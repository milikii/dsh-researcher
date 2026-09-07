#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cdp-solve.py v1 — Chromium 人机验证自助接管 worker（cdp-solve.sh 在 dsh-cdp-keepalive 容器内运行本脚本）

用法:
  python /w.py list
  python /w.py open <url>
  python /w.py close <targetId>
  python /w.py eval <targetId> <js表达式>
  python /w.py shot <targetId> [name]
  python /w.py click <targetId> <x> <y>
  python /w.py drag <targetId> <x1> <y1> <x2> <y2> [steps]
  python /w.py slider <targetId>
  python /w.py wait <targetId> [timeout_s]

约定（与栈内其他 worker 一致）:
  - stdout 只输出一行 JSON；诊断写 stderr（CDP_SOLVE_DEBUG=1 时打印 [dbg]）
  - CDP 串行锁由外层 cdp-solve.sh 的 flock /tmp/cdp.lock 持有（与 shop-search/fetch-url/x-search/mc-crawl 互斥）
  - 截图写 /out/<name>.png（宿主 /tmp/cdp-solve/），JSON 里给宿主路径与 scale（css_x = img_x / scale）
  - slider 只做「拖动滑块」类验证的 best-effort 自动尝试（先鼠标、后触摸事件）；
    点选文字/短信/扫码/登录类验证不在其列，found=false 或 solved=false 时交回调用方决策
  - 标签纪律：本脚本只执行调用方明确指定的 target；纪律（只碰 needs_human 标签或本工具 open 的标签）由技能层约束

退出码: 0 操作执行完（成败看 JSON 的 ok/solved 字段）· 3 参数错 · 4 基础设施故障（CDP 连不上 / target 不存在）
"""
import asyncio
import base64
import json
import math
import os
import random
import struct
import sys
import time
import urllib.parse
import urllib.request

CDP_HOST = "172.19.0.2:9222"
DEBUG = os.environ.get("CDP_SOLVE_DEBUG") == "1"
OUT_DIR = "/out"                    # 容器内输出目录（宿主 /tmp/cdp-solve）
HOST_OUT_DIR = "/tmp/cdp-solve"     # JSON 输出里换算成宿主路径

PUNISH_HREF_MARKS = ("punish", "x5secdata", "_____tmd_____", "risk_handler", "cfe.m.jd.com")
WAIT_RISK_WORDS = ("滑动验证", "拖动滑块", "请完成验证", "安全验证", "请按住滑块",
                   "拖动下方滑块", "验证失败", "drag the slider", "请拖动滑块")


def dbg(msg):
    if DEBUG:
        print(f"[dbg] {msg}", file=sys.stderr, flush=True)


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def http_json(path, method="GET", timeout=10):
    req = urllib.request.Request(f"http://{CDP_HOST}{path}", method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def http_raw(path, method="GET", timeout=10):
    """返回 (status, body)；/json/close 会回空响应，不能用 http_json。"""
    req = urllib.request.Request(f"http://{CDP_HOST}{path}", method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def get_targets():
    return [t for t in http_json("/json") if t.get("type") == "page"]


def find_target(target_id):
    for t in get_targets():
        if t.get("id") == target_id:
            return t
    return None


def png_size(data):
    """PNG IHDR 里取宽高（big-endian，偏移 16/20）。"""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None, None
    w, h = struct.unpack(">II", data[16:24])
    return w, h


class Tab:
    """极简 CDP 客户端：单命令同步语义（跳过事件帧）。"""

    def __init__(self, ws):
        self.ws = ws
        self._id = 0

    async def call(self, method, **params):
        self._id += 1
        mid = self._id
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        deadline = time.monotonic() + 25
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"CDP {method}: no response in 25s")
            try:
                msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=remaining))
            except asyncio.TimeoutError:
                raise TimeoutError(f"CDP {method}: no response in 25s")
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error'].get('message', msg['error'])}")
                return msg.get("result", {})

    async def bring_to_front(self):
        """输入前置条件（实测 2026-09-04，Chrome 151 / linuxserver-chromium）：
        1) 后台/未聚焦页面的 Input.dispatchMouseEvent mouseMoved 固定等 5s
           （命中测试等合成器帧超时），20+ 步拖动会慢到被滑块控件判超时；
        2) Emulation.setFocusEmulationEnabled 一步解决（5.00s → 0.01s）；
        3) Page.bringToFront 让用户在 Web UI 里能看到操作过程。
        输入类命令（click/drag/slider）一律先走本方法。"""
        try:
            await self.call("Emulation.setFocusEmulationEnabled", enabled=True)
        except Exception as e:
            dbg(f"setFocusEmulationEnabled failed (continuing): {e}")
        try:
            await self.call("Page.bringToFront")
        except Exception as e:
            dbg(f"bringToFront failed (continuing): {e}")


async def eval_js(tab, js, await_promise=False):
    r = await tab.call("Runtime.evaluate", expression=js,
                       returnByValue=True, awaitPromise=await_promise)
    if r.get("exceptionDetails"):
        d = r["exceptionDetails"]
        desc = ""
        try:
            desc = (d.get("exception") or {}).get("description") or d.get("text") or ""
        except Exception:
            pass
        return {"__err__": str(desc)[:400]}
    return r.get("result", {}).get("value")


# ── 输入事件（人类化轨迹） ───────────────────────────────────────────────────

async def mouse(tab, type_, x, y, button="none", buttons=0, click_count=0):
    t0 = time.monotonic()
    await tab.call("Input.dispatchMouseEvent", type=type_, x=round(x, 1), y=round(y, 1),
                   button=button, buttons=buttons, clickCount=click_count)
    dbg(f"  input {type_} @{round(x)},{round(y)} took {time.monotonic()-t0:.2f}s")


async def cmd_click(tab, x, y):
    await tab.bring_to_front()
    await mouse(tab, "mouseMoved", x, y)
    await asyncio.sleep(random.uniform(0.04, 0.10))
    await mouse(tab, "mousePressed", x, y, button="left", buttons=1, click_count=1)
    await asyncio.sleep(random.uniform(0.05, 0.12))
    await mouse(tab, "mouseReleased", x, y, button="left", buttons=0, click_count=1)
    return {"ok": True, "clicked": [x, y]}


async def drag_mouse(tab, x1, y1, x2, y2, steps=0):
    dist = math.hypot(x2 - x1, y2 - y1)
    steps = steps or max(20, min(60, int(dist / 7)))
    await tab.bring_to_front()
    dbg(f"drag(mouse) {x1},{y1} -> {x2},{y2} steps={steps}")
    await mouse(tab, "mouseMoved", x1, y1)
    await asyncio.sleep(random.uniform(0.06, 0.14))
    await mouse(tab, "mousePressed", x1, y1, button="left", buttons=1, click_count=1)
    await asyncio.sleep(random.uniform(0.08, 0.16))
    for i in range(1, steps + 1):
        p = i / steps
        e = 1 - (1 - p) ** 3                     # ease-out
        arc = math.sin(math.pi * p) * random.uniform(-2.5, 2.5)   # 轻微弧线
        x = x1 + (x2 - x1) * e
        y = y1 + (y2 - y1) * e + arc * 0.4 + random.uniform(-1.2, 1.2)
        await mouse(tab, "mouseMoved", x, y, buttons=1)
        await asyncio.sleep(random.uniform(0.006, 0.018))
    await asyncio.sleep(random.uniform(0.05, 0.10))
    await mouse(tab, "mouseMoved", x2, y2, buttons=1)
    await asyncio.sleep(random.uniform(0.03, 0.08))
    await mouse(tab, "mouseReleased", x2, y2, button="left", buttons=0, click_count=1)
    dbg("drag(mouse) done")


async def drag_touch(tab, x1, y1, x2, y2, steps=0):
    dist = math.hypot(x2 - x1, y2 - y1)
    steps = steps or max(20, min(60, int(dist / 7)))

    async def touch(type_, points):
        await tab.call("Input.dispatchTouchEvent", type=type_,
                       touchPoints=[{"x": round(p[0], 1), "y": round(p[1], 1)} for p in points])

    await tab.bring_to_front()
    await touch("touchStart", [(x1, y1)])
    await asyncio.sleep(random.uniform(0.08, 0.15))
    for i in range(1, steps + 1):
        p = i / steps
        e = 1 - (1 - p) ** 3
        x = x1 + (x2 - x1) * e
        y = y1 + (y2 - y1) * e + math.sin(math.pi * p) * random.uniform(-2.0, 2.0)
        await touch("touchMove", [(x, y)])
        await asyncio.sleep(random.uniform(0.006, 0.018))
    await asyncio.sleep(random.uniform(0.05, 0.10))
    await touch("touchEnd", [])


# ── 滑块自动检测（best-effort：已知选择器 → 启发式 → 同源 iframe） ───────────

SLIDER_JS = r"""
(() => {
  const known = ['#nc_1_n1z','#nc_1__n1z','.btn_slide','span.btn_slide',
                 '.slider-btn','.slide-btn','.slider_button','[class*="btn_slide"]',
                 '[class*="slider-btn"]','[class*="slide_btn"]','.JDJRV-slide-btn',
                 '#small_slider','[id*="nc_"][class*="btn"]','.slidetounlock'];
  const sizeOk = (r) => r.width>=28 && r.width<=110 && r.height>=22 && r.height<=80
                      && r.width/r.height<3.5 && r.bottom>0 && r.right>0
                      && r.top<innerHeight && r.left<innerWidth;
  const clsOf = (e) => {
    let c = e.className;
    if (c && c.baseVal !== undefined) c = c.baseVal;
    return ((c||'') + ' ' + (e.id||''));
  };
  const findIn = (doc, off) => {
    for (const sel of known) {
      try { const e = doc.querySelector(sel); if (e) return [e, off]; } catch (err) {}
    }
    for (const e of doc.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      if (!sizeOk(r)) continue;
      if (!/slide|drag|knob|handle/i.test(clsOf(e))) continue;
      return [e, off];
    }
    return null;
  };
  let hit = findIn(document, [0, 0]);
  if (!hit) {
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument;
        if (!d) continue;
        const fr = f.getBoundingClientRect();
        hit = findIn(d, [fr.left, fr.top]);
        if (hit) break;
      } catch (err) {}
    }
  }
  if (!hit) return {found: false};
  const [handle, off] = hit;
  const hr = handle.getBoundingClientRect();
  let tr = null, p = handle.parentElement;
  while (p && p !== document.body) {
    const r = p.getBoundingClientRect();
    if (r.width >= 200 && r.width <= 700 && r.height >= 20 && r.height <= 120) { tr = r; break; }
    p = p.parentElement;
  }
  const from = [Math.round(hr.left + hr.width/2 + off[0]), Math.round(hr.top + hr.height/2 + off[1])];
  let to;
  if (tr) {
    const end = tr.right - hr.width/2 - 6 + off[0];
    to = [Math.round(Math.max(end, from[0] + 120)), Math.round(hr.top + hr.height/2 + off[1])];
  } else {
    to = [Math.round(from[0] + 260), from[1]];   // 无轨道兜底：向右 260px
  }
  return {found: true, sel: (handle.id || String(handle.className).slice(0, 60) || 'heuristic'),
          from, to, handle_w: Math.round(hr.width),
          track: tr ? [Math.round(tr.width), Math.round(tr.height)] : null,
          vw: [innerWidth, innerHeight], ua: navigator.userAgent.slice(0, 80)};
})()
"""

PROBE_JS = ("((w)=>({u:location.href,t:document.title,n:((document.body&&document.body.innerText)||'').length,"
            "r:w.some(x=>((document.body&&document.body.innerText)||'').includes(x))}))("
            + json.dumps(list(WAIT_RISK_WORDS)) + ")")


async def probe(tab):
    v = await eval_js(tab, PROBE_JS)
    if isinstance(v, dict) and "__err__" in v:
        return {"href": "", "title": "", "n": 0, "risk": True, "err": v["__err__"]}
    v = v or {}
    punish = any(m in (v.get("u") or "").lower() for m in PUNISH_HREF_MARKS)
    return {"href": v.get("u") or "", "title": v.get("t") or "", "n": int(v.get("n") or 0),
            "punish": punish, "risk": bool(v.get("r"))}


async def solved_state(tab):
    st = await probe(tab)
    st["solved"] = (not st["punish"]) and (not st["risk"])
    return st


# ── 子命令 ───────────────────────────────────────────────────────────────────

async def cmd_list():
    ts = get_targets()
    return {"ok": True, "count": len(ts),
            "tabs": [{"id": t.get("id"), "title": (t.get("title") or "")[:80], "url": (t.get("url") or "")[:160]} for t in ts]}


def valid_url(url):
    return isinstance(url, str) and (url.startswith("http://") or url.startswith("https://") or url.startswith("about:"))


async def cmd_open(url):
    if not valid_url(url):
        return {"ok": False, "error": "invalid url"}
    t = http_json("/json/new?" + urllib.parse.quote(url, safe=""), method="PUT")
    await asyncio.sleep(1.0)   # 给导航一点时间
    return {"ok": True, "tab": t.get("id"), "url": t.get("url"),
            "note": "记下 tab id；用完 close，别留给 TTL"}


def rematch_url(url):
    return isinstance(url, str) and (url.startswith("http://") or url.startswith("https://") or url.startswith("about:"))


async def cmd_close(target_id):
    t = find_target(target_id)
    if not t:
        return {"ok": False, "error": "target not found (already closed?)"}
    status, body = http_raw(f"/json/close/{target_id}", method="DELETE")
    if status not in (200, 400) and "closing" not in body:
        return {"ok": False, "error": f"close http {status}: {body[:120]}"}
    return {"ok": True, "closed": target_id}


async def cmd_eval(tab, js):
    v = await eval_js(tab, js)
    if isinstance(v, dict) and "__err__" in v:
        return {"ok": False, "error": v["__err__"]}
    return {"ok": True, "value": v}


async def cmd_shot(tab, target_id, name):
    try:
        await tab.call("Page.enable")
    except Exception:
        pass
    r = await tab.call("Page.captureScreenshot", format="png")
    data = base64.b64decode(r["data"])
    if not name:
        name = f"tab-{target_id[:8]}-{int(time.time())}"
    if not name.endswith(".png"):
        name += ".png"
    path = os.path.join(OUT_DIR, name)
    with open(path, "wb") as f:
        f.write(data)
    w, h = png_size(data)
    vp = await eval_js(tab, "({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})")
    vp = vp if isinstance(vp, dict) else {}
    iw, ih = vp.get("w"), vp.get("h")
    scale = round(w / iw, 3) if (w and iw) else None
    return {"ok": True, "path": os.path.join(HOST_OUT_DIR, name), "img": [w, h],
            "viewport": [iw, ih], "dpr": vp.get("dpr"), "scale": scale,
            "note": "css_x = img_x / scale；css_y = img_y / scale（scale 为空则 1:1）"}


async def cmd_drag(tab, x1, y1, x2, y2, steps, mode):
    fn = drag_touch if mode == "touch" else drag_mouse
    await fn(tab, x1, y1, x2, y2, steps)
    return {"ok": True, "dragged": [x1, y1, x2, y2], "steps": steps or "auto", "mode": mode}


async def cmd_slider(tab):
    v = await eval_js(tab, SLIDER_JS)
    dbg(f"slider detect: {json.dumps(v, ensure_ascii=False)[:300]}")
    if not isinstance(v, dict) or not v.get("found"):
        return {"ok": True, "found": False,
                "hint": "未检测到滑块控件：shot 截图后用 drag 手动拖，或确认不是滑块类验证"}
    frm, to = v["from"], v["to"]
    attempts = []
    for mode in ("mouse", "touch"):
        await asyncio.sleep(random.uniform(0.3, 0.8))
        fn = drag_touch if mode == "touch" else drag_mouse
        await fn(tab, frm[0], frm[1], to[0], to[1])
        for i in range(6):   # 最多等 6s 看页面反应
            await asyncio.sleep(1.0)
            st = await solved_state(tab)
            dbg(f"slider[{mode}] probe#{i}: solved={st['solved']} punish={st['punish']} risk={st['risk']} n={st['n']}")
            if st["solved"]:
                return {"ok": True, "found": True, "sel": v.get("sel"), "from": frm, "to": to,
                        "mode": mode, "solved": True, "href": st["href"], "body_chars": st["n"]}
        attempts.append({"mode": mode, "solved": False, "href": st["href"]})
    return {"ok": True, "found": True, "sel": v.get("sel"), "from": frm, "to": to,
            "solved": False, "attempts": attempts,
            "hint": "两次拖动未通过：shot 看当前状态，换坐标 drag 重试（自助上限 3 次），仍失败交用户"}


async def cmd_wait(tab, timeout):
    t0 = time.time()
    st = await solved_state(tab)
    if st["solved"]:
        st.update({"ok": True, "solved": True, "waited_s": 0})
        return st
    while time.time() - t0 < timeout:
        await asyncio.sleep(1.5)
        st = await solved_state(tab)
        if st["solved"]:
            st.update({"ok": True, "solved": True, "waited_s": round(time.time() - t0, 1)})
            return st
    st.update({"ok": True, "solved": False, "waited_s": round(time.time() - t0, 1)})
    return st


# ── 入口 ─────────────────────────────────────────────────────────────────────

USAGE = __doc__


async def run(argv):
    if not argv:
        print(USAGE, file=sys.stderr)
        sys.exit(3)
    cmd, args = argv[0], argv[1:]

    if cmd == "list":
        return await cmd_list()

    if cmd == "open":
        if len(args) < 1:
            print("usage: open <url>", file=sys.stderr); sys.exit(3)
        return await cmd_open(args[0])

    if cmd == "close":   # 纯 HTTP，不需要 WebSocket
        if len(args) < 1:
            print("usage: close <targetId>", file=sys.stderr); sys.exit(3)
        return await cmd_close(args[0])

    import websockets  # 仅需要连 tab 的命令才 import（list/open/close 走 HTTP）

    if cmd in ("eval", "shot", "click", "drag", "slider", "wait"):
        if len(args) < 1:
            print(f"usage: {cmd} <targetId> ...", file=sys.stderr); sys.exit(3)
        target_id = args[0]
        t = find_target(target_id)
        if not t:
            raise RuntimeError(f"target not found: {target_id}（先 list 查一下）")
        ws_url = t.get("webSocketDebuggerUrl")
        if not ws_url:
            raise RuntimeError("target has no webSocketDebuggerUrl")
        async with websockets.connect(ws_url, open_timeout=15, max_size=32 * 1024 * 1024) as ws:
            tab = Tab(ws)
            if cmd == "eval":
                if len(args) < 2:
                    print("usage: eval <targetId> <js>", file=sys.stderr); sys.exit(3)
                return await cmd_eval(tab, args[1])
            if cmd == "shot":
                return await cmd_shot(tab, target_id, args[1] if len(args) > 1 else "")
            if cmd == "click":
                if len(args) < 3:
                    print("usage: click <targetId> <x> <y>", file=sys.stderr); sys.exit(3)
                return await cmd_click(tab, float(args[1]), float(args[2]))
            if cmd == "drag":
                if len(args) < 5:
                    print("usage: drag <targetId> <x1> <y1> <x2> <y2> [steps] [--touch]", file=sys.stderr); sys.exit(3)
                steps = int(args[5]) if len(args) > 5 and args[5].isdigit() else 0
                mode = "touch" if "--touch" in args[6:] or (len(args) > 5 and args[5] == "--touch") else "mouse"
                return await cmd_drag(tab, float(args[1]), float(args[2]), float(args[3]), float(args[4]), steps, mode)
            if cmd == "slider":
                return await cmd_slider(tab)
            if cmd == "wait":
                timeout = int(args[1]) if len(args) > 1 and args[1].isdigit() else 20
                return await cmd_wait(tab, timeout)

    print(USAGE, file=sys.stderr)
    sys.exit(3)


def main():
    try:
        result = asyncio.run(run(sys.argv[1:]))
        out(result)
    except SystemExit:
        raise
    except Exception as e:   # 基础设施故障 → 退出码 4
        print(json.dumps({"ok": False, "error": f"infra: {type(e).__name__}: {str(e)[:300]}"}, ensure_ascii=False))
        sys.exit(4)


if __name__ == "__main__":
    main()
