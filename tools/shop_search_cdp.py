#!/usr/bin/env python3
"""shop_search_cdp.py — shop-search v2 的 CDP worker（在 dsh-cdp-keepalive 容器内运行）。

用法:
  python /w.py <platform> <keyword> [page] [--tab ID] [--pages N] [--scroll N] [--wait-human N]
  python shop_search_cdp.py --selftest      # 不连 CDP，只跑风控判定固定用例

platform: jd | 1688（默认移动版 m.1688.com）| 1688:desktop | taobao | tmall | pdd | douyin

约定:
  - stdout 只输出一行 JSON；进度/诊断只写 stderr（SHOP_SEARCH_DEBUG=1 时打印 [dbg]）。
  - 标签复用：--tab 指定已存在的 target 则在其中导航；否则新建并把 targetId 回传（tab 字段）。
  - 成功后不关闭标签（由包装器按 TTL / close 子命令管理）；worker 异常退出时只关闭本次新建的标签。
  - needs_human=true：风控/滑块/登录页需要真人处理，标签保留不关。
  - soft_block：1688 桌面版「搜索中转页」（未真正执行搜索），needs_human=false，建议改移动版。
"""
import argparse, asyncio, datetime, json, os, random, re, sys, time, urllib.parse, urllib.request

CDP = "http://172.19.0.2:9222"
DEBUG = os.environ.get("SHOP_SEARCH_DEBUG") == "1"
TZ = datetime.timezone(datetime.timedelta(hours=8))

PUNISH_HREF_MARKS = ("punish", "x5secdata", "_____tmd_____", "risk_handler", "cfe.m.jd.com")
RISK_BODY_RE = re.compile(r"滑动验证|拖动滑块|安全验证|请完成验证|drag the slider|Please slide|verify|captcha", re.I)
SOFTBLOCK_MARKS = ("最近搜索", "热门搜索")

MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
ANDROID_UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36")


def now_iso():
    return datetime.datetime.now(TZ).isoformat(timespec="seconds")


def dbg(msg):
    if DEBUG:
        print(f"[dbg] {msg}", file=sys.stderr, flush=True)


# ── 风控判定（纯函数；--selftest 覆盖） ─────────────────────────────────────
def classify(platform, href, body, cards):
    """返回 {needs_human, soft_block, reason}。platform 为调用名（1688 / 1688:desktop / jd / ...）。"""
    h = (href or "").lower()
    b = body or ""
    base = "1688" if platform.startswith("1688") else platform
    for mark in PUNISH_HREF_MARKS:
        if mark.lower() in h:
            return {"needs_human": True, "soft_block": False, "reason": f"href contains {mark}"}
    if base == "pdd" and "login.html" in h:
        return {"needs_human": True, "soft_block": False,
                "reason": "pdd redirected to login.html（未登录或需验证）"}
    if cards == 0 and RISK_BODY_RE.search(b):
        m = RISK_BODY_RE.search(b)
        return {"needs_human": True, "soft_block": False, "reason": f"body: {m.group(0)[:40]}"}
    if cards == 0 and len(b) < 600 and "验证" in b:
        return {"needs_human": True, "soft_block": False, "reason": "body: 短页含「验证」"}
    if (cards == 0 and platform == "1688:desktop"
            and any(m in b for m in SOFTBLOCK_MARKS)):
        return {"needs_human": False, "soft_block": True,
                "reason": "desktop soft-block: 搜索中转页，未执行搜索（建议改用移动版 1688）"}
    return {"needs_human": False, "soft_block": False, "reason": None}


SELFTEST_CASES = [
    # (name, platform, href, body, cards, expect)  expect ∈ needs_human|soft_block|normal
    ("x5secdata href", "1688", "https://sec.1688.com/query.htm?x5secdata=xyz", "页面内容", 0, "needs_human"),
    ("punish href", "1688:desktop", "https://sec.1688.com/query.htm?punish=true", "", 0, "needs_human"),
    ("_____tmd_____ href", "taobao", "https://www.taobao.com/_____tmd_____/slide", "", 0, "needs_human"),
    ("jd cfe risk href", "jd", "https://cfe.m.jd.com/verification?x=1", "", 0, "needs_human"),
    ("risk_handler href（有卡片也拦截）", "taobao", "https://login.taobao.com/risk_handler.htm", "", 5, "needs_human"),
    ("pdd login.html", "pdd", "https://mobile.yangkeduo.com/login.html?redir=xx", "", 0, "needs_human"),
    ("移动版滑块文案", "1688", "https://m.1688.com/offer_search/-xx.html", "Please drag the slider to verify", 0, "needs_human"),
    ("中文滑块文案", "jd", "https://search.jd.com/Search?keyword=x", "请完成滑动验证后继续", 0, "needs_human"),
    ("短页含验证", "taobao", "https://s.taobao.com/search?q=x", "安全验证 500", 0, "needs_human"),
    ("正常 30 卡片", "jd", "https://search.jd.com/Search?keyword=x", "商品结果文本 " * 60, 30, "normal"),
    ("桌面中转页 soft-block", "1688:desktop", "https://s.1688.com/selloffer/offer_search.htm", "最近搜索 热门搜索 数码 家居 猜你喜欢", 0, "soft_block"),
    ("移动版正常 11 卡片", "1688", "https://m.1688.com/offer_search/-xx.html", "商品标题 复购率42% 成交900笔 3年 广州", 11, "normal"),
    ("正常空结果", "1688", "https://m.1688.com/offer_search/-xx.html", "该关键词下暂无相关商品，换个词试试吧 " * 8, 0, "normal"),
]


def selftest():
    ok = 0
    for name, plat, href, body, cards, expect in SELFTEST_CASES:
        r = classify(plat, href, body, cards)
        got = "needs_human" if r["needs_human"] else ("soft_block" if r["soft_block"] else "normal")
        if got == expect:
            ok += 1
        else:
            print(f"[selftest FAIL] {name}: expect {expect}, got {got} ({r})", file=sys.stderr)
    if ok != len(SELFTEST_CASES):
        print(json.dumps({"selftest": "fail", "cases": f"{ok}/{len(SELFTEST_CASES)}"}))
        return 1
    print(json.dumps({"selftest": "ok", "cases": len(SELFTEST_CASES)}))
    return 0


# ── URL / 选择器 / 登录探针 ─────────────────────────────────────────────────
def build_url(platform, kw, page):
    base = "1688" if platform.startswith("1688") else platform
    if platform == "1688":  # 移动版（UTF-8 编码）
        return f"https://m.1688.com/offer_search/-B6F1C1D2B4C6BDBA-BEAB.html?keywords={urllib.parse.quote(kw)}"
    if platform == "1688:desktop":  # 桌面版要求 GBK 编码
        u = f"https://s.1688.com/selloffer/offer_search.htm?keywords={urllib.parse.quote(kw.encode('gbk'))}"
        if page > 1:
            u += f"&beginPage={page}"
        return u
    if base == "jd":
        u = f"https://search.jd.com/Search?keyword={urllib.parse.quote(kw)}&enc=utf-8"
        if page > 1:
            u += f"&page={2 * page - 1}"
        return u
    if base in ("taobao", "tmall"):
        u = f"https://s.taobao.com/search?q={urllib.parse.quote(kw)}"
        if page > 1:
            u += f"&s={44 * (page - 1)}"
        return u
    if base == "pdd":
        return f"https://mobile.yangkeduo.com/search_result.html?search_key={urllib.parse.quote(kw)}"
    raise SystemExit(3)


CARD_SEL = {
    "1688": 'a.item-link',
    "1688:desktop": 'a.search-offer-wrapper',
    "jd": '[data-sku]',
    "taobao": 'a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"]',
    "tmall": 'a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"]',
    "pdd": '[class*="goods"]',
    "douyin": 'a[href*="haohuo.jinritemai.com"], [class*="goods"]',
}

LOGIN_COOKIES = {
    "1688": ["unb", "__cn_logon__", "cookie2", "lgc", "_tb_token_", "sgcookie"],      # 移动版
    "1688:desktop": ["__cn_logon__", "unb"],
    "jd": ["pin"],
    "taobao": ["tracknick", "lgc", "unb"],
    "tmall": ["tracknick", "lgc", "unb"],
    "pdd": ["pdd_user_id", "PASS_ID"],
    "douyin": ["sessionid", "sessionid_ss"],
}

EXTRACT_JS_TEMPLATE = r'''
(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const push = (o) => { if (o.title && o.price) out.push(o); };
  if (__IS_M1688__) {
    const seen = new Set();
    for (const a of document.querySelectorAll('a.item-link')) {
      const om = (a.href || '').match(/offer\/(\d+)\.html/) || (a.href || '').match(/offerId=(\d+)/);
      if (!om || seen.has(om[1])) continue;
      seen.add(om[1]);
      const lines = (a.innerText || '').split(/\n+/).map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
      if (!lines.length) continue;
      const flat = lines.join(' ');
      const pm = flat.match(/[￥¥]\s*([\d.]+)/);
      const sm = flat.match(/成交(\d+)\+?笔/);
      const rm = flat.match(/复购率[:\s]*(\d+)%/);
      const ym = flat.match(/(\d+)年/);
      const img = a.querySelector('img');
      out.push({title: lines[0].slice(0, 90),
                price: pm ? pm[1] : '',
                sales: sm ? ('成交' + sm[1] + '笔') : '',
                repeat_rate: rm ? ('复购率' + rm[1] + '%') : '',
                shop_age: ym ? (ym[1] + '年') : '',
                region: (lines[lines.length - 1] || '').slice(0, 12),
                url: 'https://detail.1688.com/offer/' + om[1] + '.html',
                image: img ? (img.src || '') : ''});
      if (out.length >= 40) break;
    }
    return {products: out};
  }
  if (__IS_JD__) {
    for (const el of document.querySelectorAll('[data-sku]')) {
      const sku = el.getAttribute('data-sku');
      const txt = clean(el.innerText);
      if (!txt || txt.startsWith('广告')) continue;
      let title = '';
      for (const s of el.querySelectorAll('span[title]')) {
        const t = s.getAttribute('title') || '';
        if (t.length > title.length) title = t;
      }
      const pm = txt.match(/¥\s*([\d.]+)/);
      const om = txt.match(/到手价\s*¥\s*([\d.]+)/);
      const sm = txt.match(/已售([\d.,]+\+?万?)/);
      const shm = txt.match(/([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,28}(?:旗舰店|自营|专营店|专卖店|官方店|超市))/);
      const img = el.querySelector('img[data-src*="360buyimg"], img[src*="360buyimg"]') || el.querySelector('img');
      const isrc = img ? (img.getAttribute('data-src') || img.src || '') : '';
      push({title: (title || txt.slice(0, 60)).slice(0, 90),
            price: pm ? pm[1] : '', orig_price: om ? om[1] : '',
            sales: sm ? ('已售' + sm[1]) : '',
            shop: shm ? shm[1] : '',
            url: 'https://item.jd.com/' + sku + '.html',
            image: isrc.replace(/^\/\//, 'https://').split('?')[0]});
      if (out.length >= 30) break;
    }
    return {products: out};
  }
  if (__IS_ALI__) {
    for (const a of document.querySelectorAll('a.search-offer-wrapper')) {
      const cls = a.className + '';
      const rpt = a.getAttribute('data-aplus-report') || '';
      if (cls.includes('adOffer') || rpt.includes('_p_isad@1')) continue;
      const om = (a.href || '').match(/offerId=(\d+)/);
      if (!om) continue;
      // 必须用原始 innerText 按换行分段（clean 会把换行压平）
      const parts = (a.innerText || '').split(/\n+/).map(s => (s || '').replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
      const title = parts[0] || '';
      let price = '';
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p === '¥' || p.startsWith('¥')) {
          const main = p === '¥' ? (parts[i+1] || '') : p.slice(1);
          const dec = (parts[i+2] && /^\./.test(parts[i+2])) ? parts[i+2] : '';
          price = (main + dec).replace(/[^\d.]/g, '');
          break;
        }
      }
      const flat = (a.innerText || '').replace(/\s+/g, ' ');
      const moqM = flat.match(/(\d+)\+件/);
      const rrM = flat.match(/回头率(\d+)%/);
      const shop = parts[parts.length - 1] || '';
      const img = a.querySelector('img.main-img') || a.querySelector('img');
      push({title: title.slice(0, 90), price,
            moq: moqM ? (moqM[1] + '+件') : '',
            sales: rrM ? ('回头率' + rrM[1] + '%') : '',
            shop: (/(公司|厂|商行|经营部|店|部)/.test(shop)) ? shop : '',
            url: 'https://detail.1688.com/offer/' + om[1] + '.html',
            image: img ? (img.src || '') : ''});
      if (out.length >= 30) break;
    }
    return {products: out};
  }
  if (__IS_TB__) {
    for (const a of document.querySelectorAll('a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"]')) {
      let el = a;
      for (let i = 0; i < 5 && el.parentElement; i++) el = el.parentElement;
      const txt = clean(el.innerText);
      const pm = txt.match(/¥\s*([\d.]+)/);
      const sm = txt.match(/(月销[\d.,]+|已售[\d.,]+\+?万?|[\d.,]+人付款)/);
      const shm = txt.match(/([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,28}(?:旗舰店|专营店|专卖店|官方店|超市|小店))/);
      const img = el.querySelector('img');
      const tEl = a.querySelector('[class*="title"]') || a;
      push({title: (clean(tEl.innerText) || txt.slice(0, 60)).slice(0, 90),
            price: pm ? pm[1] : '',
            sales: sm ? sm[1] : '', shop: shm ? shm[1] : '',
            url: (a.href || '').split('&')[0], image: img ? (img.src || '') : ''});
      if (out.length >= 30) break;
    }
    return {products: out};
  }
  if (__IS_PDD__) {
    for (const el of document.querySelectorAll('[class*="goods"]')) {
      const txt = clean(el.innerText);
      if (txt.length < 20 || !txt.match(/¥\s*[\d.]+/)) continue;
      const pm = txt.match(/¥\s*([\d.]+)/);
      const sm = txt.match(/已拼([\d.,]+万?\+?件?)/);
      push({title: txt.slice(0, 90), price: pm ? pm[1] : '',
            sales: sm ? ('已拼' + sm[1]) : '', shop: '', url: '', image: ''});
      if (out.length >= 30) break;
    }
    return {products: out};
  }
  return {products: []};
})()
'''

LOGIN_PROBE_JS_TEMPLATE = r'''
(() => {
  const ck = (document.cookie || '').split(';').map(x => x.trim().split('=')[0]).filter(Boolean);
  const names = __LOGIN_NAMES__;
  const cookieHit = names.filter(n => ck.includes(n));
  const nickname = (document.querySelector('.site-nav-login-info-nick, .J_UserName') || {}).textContent || '';
  return {cookieHit, cookie_names: ck.slice(0, 40),
          nickname: (nickname || '').trim().slice(0, 30),
          href: location.href.slice(0, 160)};
})()
'''


def extract_js(platform):
    return (EXTRACT_JS_TEMPLATE
            .replace('__IS_M1688__', 'true' if platform == '1688' else 'false')
            .replace('__IS_JD__', 'true' if platform == 'jd' else 'false')
            .replace('__IS_ALI__', 'true' if platform == '1688:desktop' else 'false')
            .replace('__IS_TB__', 'true' if platform in ('taobao', 'tmall') else 'false')
            .replace('__IS_PDD__', 'true' if platform == 'pdd' else 'false'))


def login_probe_js(platform):
    return LOGIN_PROBE_JS_TEMPLATE.replace(
        '__LOGIN_NAMES__', json.dumps(LOGIN_COOKIES.get(platform, [])))


_no_proxy = urllib.request.ProxyHandler({})
_opener = urllib.request.build_opener(_no_proxy)


def http_json(path, method="GET"):
    req = urllib.request.Request(f"{CDP}{path}", method=method)
    with _opener.open(req, timeout=10) as r:
        return json.loads(r.read().decode())


def close_target(tid):
    try:
        _opener.open(urllib.request.Request(f"{CDP}/json/close/{tid}", method="DELETE"), timeout=8)
    except Exception:
        pass


def emit(platform, kw, login_state, products, error=None, extra=None):
    d = {"platform": platform, "keyword": kw, "retrieved_at": now_iso(),
         "login_state": login_state, "products": products, "error": error}
    if extra:
        d.update(extra)
    print(json.dumps(d, ensure_ascii=False), flush=True)


async def run_search(args):
    import websockets
    platform = args.platform
    base = "1688" if platform.startswith("1688") else platform
    channel = {"1688": "cdp-login-mobile", "1688:desktop": "cdp-login-desktop"}.get(platform, "cdp-login")
    extra_base = {"channel": channel}
    variant = {"1688": "m.1688.com", "1688:desktop": "s.1688.com"}.get(platform)
    if variant:
        extra_base["variant"] = variant

    if base == "douyin":
        emit(platform, args.keyword, "n/a", [],
             "unsupported: 抖音桌面版无商品搜索，请改用 cloud 或 MediaCrawler", extra=extra_base)
        return 0

    # ── 标签获取（复用 or 新建） ──
    try:
        pages = http_json("/json/list")
    except Exception as e:
        emit(platform, args.keyword, "unknown", [], f"CDP unreachable: {str(e)[:120]}",
             extra=dict(extra_base, infra_error=True))
        return 4
    page_map = {p.get("id"): p for p in pages if p.get("type") == "page"}
    tid = ws_url = None
    created = False
    if args.tab and args.tab in page_map:
        tid = args.tab
        ws_url = page_map[tid].get("webSocketDebuggerUrl")
        dbg(f"reuse tab {tid[:12]}")
    if not ws_url:
        t = http_json("/json/new?about:blank", method="PUT")
        tid = t.get("id")
        ws_url = t.get("webSocketDebuggerUrl")
        created = True
    if not tid or not ws_url:
        emit(platform, args.keyword, "unknown", [], "CDP: cannot create/attach tab",
             extra=dict(extra_base, infra_error=True))
        return 4

    try:
        ws = await websockets.connect(
            ws_url.replace("127.0.0.1:9222", "172.19.0.2:9222"), open_timeout=15)
        try:
            cid = [0]

            async def cmd(m, p=None, to=30):
                cid[0] += 1
                await ws.send(json.dumps({"id": cid[0], "method": m, "params": p or {}}))
                while True:
                    mm = json.loads(await asyncio.wait_for(ws.recv(), timeout=to))
                    if mm.get("id") == cid[0]:
                        return mm

            async def ev(js, to=30):
                r = await cmd("Runtime.evaluate",
                              {"expression": js, "returnByValue": True}, to=to)
                return r.get("result", {}).get("result", {}).get("value")

            async def cards_n():
                sel = CARD_SEL.get(platform, "a")
                expr = ("(function(){try{return document.querySelectorAll("
                        + json.dumps(sel) + ").length}catch(e){return 0}})()")
                return (await ev(expr, to=15)) or 0

            async def smart_wait(min_cards=6):
                deadline = time.time() + 15
                last_len, stable = -1, 0
                while time.time() < deadline:
                    await asyncio.sleep(1.0)
                    try:
                        n = await ev("((document.body&&document.body.innerText)||'').length", to=15)
                        rs = await ev("document.readyState", to=15)
                        cards = await cards_n()
                    except Exception:
                        continue
                    stable = stable + 1 if n == last_len else 0
                    last_len = n or 0
                    dbg(f"wait: ready={rs} len={n} cards={cards} stable={stable}")
                    if rs == "complete" and cards >= min_cards and stable >= 1:
                        break
                    if rs == "complete" and stable >= 4 and (n or 0) > 300:
                        break

            async def do_extract():
                r = await cmd("Runtime.evaluate",
                              {"expression": extract_js(platform), "returnByValue": True}, to=30)
                raw = (r.get("result") or {}).get("result") or {}
                if DEBUG:
                    dbg("extract raw: " + json.dumps(raw, ensure_ascii=False)[:500])
                return (raw.get("value") or {}).get("products") or []

            await cmd("Page.enable")
            if platform == "1688":  # 移动版：iPhone UA + 视口
                await cmd("Emulation.setUserAgentOverride",
                          {"userAgent": MOBILE_UA, "platform": "iPhone"})
                await cmd("Emulation.setDeviceMetricsOverride",
                          {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True})
            elif base == "pdd":
                await cmd("Emulation.setUserAgentOverride",
                          {"userAgent": ANDROID_UA, "platform": "Android"})
                await cmd("Emulation.setDeviceMetricsOverride",
                          {"width": 412, "height": 915, "deviceScaleFactor": 2.625, "mobile": True})

            url = build_url(platform, args.keyword, args.page)
            dbg(f"url={url}")
            await cmd("Page.navigate", {"url": url}, to=25)
            await smart_wait(min_cards=4 if platform == "1688" else 6)

            # 滚动触发懒加载 / 无限加载
            if platform == "1688":
                await asyncio.sleep(random.uniform(2, 4))
                for _ in range(min(args.scroll, 8)):
                    await ev(f"window.scrollBy(0, {1400 + random.randint(-300, 300)})")
                    await asyncio.sleep(random.uniform(0.8, 2.0))
            else:
                # 非 1688 平台也加抖动（2026-09-06）：固定 2.0s / 1600px 是可识别的机器节律
                await asyncio.sleep(random.uniform(1.0, 2.5))
                for _ in range(2):
                    await ev(f"window.scrollBy(0, {1600 + random.randint(-300, 300)})")
                    await asyncio.sleep(random.uniform(1.2, 2.8))

            # ── 风控判定（等待结束后统一执行） ──
            href = (await ev("location.href")) or ""
            body = (await ev("((document.body&&document.body.innerText)||'').slice(0,5000)")) or ""
            cards = await cards_n()
            cls = classify(platform, href, body, cards)
            dbg(f"classify: {cls} cards={cards} href={href[:80]}")

            # --wait-human：原地等真人过验证，卡片出现即继续
            if cls["needs_human"] and args.wait_human > 0:
                deadline = time.time() + args.wait_human
                next_note = time.time()
                print(f"[wait-human] 需要人工验证，请在 Web UI 完成滑块（最长等 {args.wait_human}s）",
                      file=sys.stderr, flush=True)
                while time.time() < deadline:
                    await asyncio.sleep(3)
                    href2 = (await ev("location.href")) or ""
                    cards2 = await cards_n()
                    if cards2 >= 3 and not classify(platform, href2, "", cards2)["needs_human"]:
                        cls = {"needs_human": False, "soft_block": False, "reason": None}
                        print("[wait-human] 验证已通过，继续提取", file=sys.stderr, flush=True)
                        break
                    if time.time() >= next_note:
                        print(f"[wait-human] 剩余 {int(deadline - time.time())}s，请在 Web UI 完成验证",
                              file=sys.stderr, flush=True)
                        next_note += 15

            if cls["needs_human"]:
                emit(platform, args.keyword, "no" if base == "pdd" else "unknown", [], "anti-bot",
                     extra=dict(extra_base, needs_human=True, reason=cls["reason"],
                                tab=tid, url=(href or "")[:160]))
                return 0
            if cls["soft_block"]:
                emit(platform, args.keyword, "unknown", [], cls["reason"],
                     extra=dict(extra_base, soft_block=True, reason=cls["reason"], tab=tid))
                return 0

            # ── 提取（--pages 仅 jd / 1688:desktop 支持翻页；移动版用 --scroll） ──
            products = await do_extract()
            pages_done = 1
            if args.pages > 1 and platform in ("jd", "1688:desktop"):
                for p in range(2, min(args.pages, 3) + 1):
                    await asyncio.sleep(random.uniform(6, 10))
                    await cmd("Page.navigate", {"url": build_url(platform, args.keyword, p)}, to=25)
                    await smart_wait(min_cards=6)
                    for _ in range(2):
                        await ev(f"window.scrollBy(0, {1600 + random.randint(-300, 300)})")
                        await asyncio.sleep(random.uniform(1.2, 2.8))
                    more = await do_extract()
                    seen = {x.get("url") for x in products}
                    for m in more:
                        if m.get("url") not in seen:
                            products.append(m)
                            seen.add(m.get("url"))
                    pages_done = p
            dbg(f"extracted {len(products)} products")

            # ── 登录探针 ──
            lp = (await ev(login_probe_js(platform))) or {}
            dbg(f"login probe: {lp}")
            if lp.get("cookieHit") or lp.get("nickname"):
                login_state = "yes"
            elif base == "pdd":
                login_state = "no"
            else:
                login_state = "unknown"

            err = None
            if not products:
                if login_state == "no":
                    err = ("platform not logged in（请在 https://192.168.1.220:3001 登录后重试；"
                           "可用 cloud 通道兜底）")
                elif login_state == "yes" and base in ("taobao", "tmall"):
                    err = ("product list blocked by Alibaba x5sec anti-bot (login OK, shell renders). "
                           "淘宝/天猫实时搜索当前不可用——改用 cloud 通道兜底（C级缓存价）")
                else:
                    err = "no product cards extracted (page empty, blocked, or layout changed)"
            extra = dict(extra_base, tab=tid)
            if pages_done > 1:
                extra["pages"] = pages_done
            if platform == "1688":
                extra["cookie_names"] = lp.get("cookie_names") or []
            emit(platform, args.keyword, login_state, products, err, extra=extra)
            return 0
        finally:
            try:
                await ws.close()
            except Exception:
                pass
    except SystemExit:
        raise
    except Exception as e:
        emit(platform, args.keyword, "unknown", [], f"CDP failure: {str(e)[:180]}",
             extra=dict(extra_base, infra_error=True))
        if created and tid:
            close_target(tid)  # 只关本次新建的标签；复用标签交给包装器
        return 4


def main():
    ap = argparse.ArgumentParser(prog="shop_search_cdp.py")
    ap.add_argument("--selftest", action="store_true", help="不连 CDP，只跑风控判定用例")
    ap.add_argument("platform", nargs="?", help="jd|1688|1688:desktop|taobao|tmall|pdd|douyin")
    ap.add_argument("keyword", nargs="?", help="搜索关键词")
    ap.add_argument("page", nargs="?", type=int, default=1)
    ap.add_argument("--tab", help="复用的 CDP targetId")
    ap.add_argument("--pages", type=int, default=1, help="翻页数 1-3（仅 jd / 1688:desktop）")
    ap.add_argument("--scroll", type=int, default=4, help="移动版 1688 滚动次数（默认 4，上限 8）")
    ap.add_argument("--wait-human", dest="wait_human", type=int, default=0,
                    help="needs_human 时原地等待真人处理的秒数")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    global DEBUG
    if args.debug:
        DEBUG = True
    if args.selftest:
        return selftest()
    if not args.platform or args.keyword is None:
        ap.error("need <platform> <keyword>")
    return asyncio.run(run_search(args))


if __name__ == "__main__":
    sys.exit(main() or 0)

