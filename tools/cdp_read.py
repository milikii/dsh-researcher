#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cdp_read.py v3 — Chromium CDP 页面读取器（供 fetch-url v3 的 Chromium 分支调用）
运行环境：docker 一次性容器（python:3.12-alpine + websockets），ai-browser 网络。
输入：URL（argv[1]），可选 --render（argv[2]，网络空闲+内容稳定等待）

v3 智能等待（取代固定 sleep 5 轮询）：
  · 每 1s 采样 {location.href, title, 正文文本长度, readyState}
  · 提取条件：href 命中目标 host 且 readyState=complete 且 文本长度>200 且 连续 2 次采样长度稳定
  · --render 额外开启 Network.enable（network idle 事件）并给更宽松的稳定窗口
  · 总上限 60s（--render 90s），超时也照常提取一次（拿多少算多少）

v3 噪音清理提取：
  · 平台正文容器优先（知乎 RichContent/文章 MarkdownBody、小红书 note 描述、
    X tweetText、B站 视频描述区、通用 article/main）
  · cloneNode 后删除 nav/header/footer/aside/评论区/侧栏/推荐/广告/cookie/登录弹窗等
  · 提取 meta author / published 时间（证据链 metadata）

清理规则（自 v2 起保持不变，绝不允许回退）：
  · 本次任务创建的临时 target 记下 targetId，成功/失败/超时/异常一律 finally 关闭
  · 模式 2 只复用「同站」现有标签导航，找不到同站绝不导航；绝不关闭任何原有标签
"""
import asyncio
import json
import sys
import time
import urllib.parse
import urllib.request

CDP_HOST = "172.19.0.2:9222"


def http_get(path):
    with urllib.request.urlopen(f"http://{CDP_HOST}{path}", timeout=8) as r:
        return json.load(r)


def create_target(url):
    req = urllib.request.Request(
        f"http://{CDP_HOST}/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def close_target(target_id):
    try:
        req = urllib.request.Request(f"http://{CDP_HOST}/json/close/{target_id}", method="DELETE")
        with urllib.request.urlopen(req, timeout=8):
            pass
    except Exception:
        pass


# 轮询采样表达式（轻量）
POLL_JS = ("({u:location.href,t:document.title,"
           "n:(document.body?.innerText||'').length,s:document.readyState})")

# 提取表达式（噪音清理 + 平台正文选择器 + metadata）
EXTRACT_JS = """
(() => {
  const select = (sel) => { try { return document.querySelector(sel) } catch (e) { return null } };
  const pickRoot = () => {
    const sels = [
      'article', 'main',
      '.Post-RichText', '.RichContent', '.MarkdownBody', '.Article-content', '.article-content',
      '#detail-desc', '.note-content', '.note-text', '.desc', '.content',
      'article[data-testid="tweetText"]', 'div[data-testid="tweetText"]',
      '.answer-content', '.post-content', '.video-desc-container', '.basic-desc-info', '.desc-info'
    ];
    let best = null, bestN = 0;
    for (const s of sels) {
      const el = select(s);
      if (!el) continue;
      const n = ((el.innerText || '') || '').trim().length;
      if (n > bestN) { bestN = n; best = el; }
    }
    if (best && bestN > 120) return best;
    return document.body;
  };
  const root = (pickRoot() || document.body).cloneNode(true);
  const noise = [
    'nav', 'header', 'footer', 'aside', 'form', 'script', 'style', 'noscript',
    'iframe', 'svg', 'button', 'input', 'textarea', 'select', 'img', 'picture',
    '.ad', '.ads', '.advertisement', '.advert', '[class*="cookie"]', '[class*="banner"]',
    '[class*="comment"]', '[id*="comment"]', '.sidebar', '.recommend', '.related',
    '[class*="modal"]', '[class*="popup"]', '.share', '.toolbar', '[class*="login"]',
    '.Catalog', '.Question-sideColumn', '.ContentItem-actions', '.MoreAnswers',
    '.list-footer', '.VoteButton', '.CornerButtons'
  ];
  noise.forEach((s) => { try { root.querySelectorAll(s).forEach((e) => e.remove()) } catch (e) {} });
  const text = (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24000);
  const meta = (sels, attr) => {
    for (const s of sels) {
      try {
        const el = document.querySelector(s);
        if (!el) continue;
        const v = attr ? el.getAttribute(attr) : (el.content || el.textContent || '');
        if (v) return String(v).trim().slice(0, 120);
      } catch (e) {}
    }
    return '';
  };
  const author = meta([
    'meta[name="author"]', 'meta[property="article:author"]', 'meta[itemprop="author"]'
  ], 'content');
  const published = meta([
    'meta[property="article:published_time"]', 'meta[itemprop="datePublished"]',
    'meta[name="publishdate"]', 'meta[name="date"]', 'time[datetime]', 'meta[name="createdate"]'
  ], 'content') || meta(['time'], 'datetime') || meta(['time'], '');
  return { url: location.href, title: document.title || '', author, published, body: text };
})()
"""


async def read_via(ws, url, do_navigate, render=False):
    """在已连接的 ws 上等待渲染并提取。do_navigate=True 时先导航。
    v3：1s 采样 + 内容长度连续 2 次稳定判定，取代固定 sleep。"""
    cid = [0]

    async def cmd(method, params=None, timeout=35):
        cid[0] += 1
        await ws.send(json.dumps({"id": cid[0], "method": method, "params": params or {}}))
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
            if m.get("id") == cid[0]:
                return m

    await cmd("Page.enable")
    if render:
        try:
            await cmd("Network.enable")
        except Exception:
            pass
    if do_navigate:
        await cmd("Page.navigate", {"url": url})
    want_host = urllib.parse.urlparse(url).netloc
    deadline = time.time() + (90 if render else 60)
    last = -1
    stable = 0
    while time.time() < deadline:
        await asyncio.sleep(1.0)
        try:
            r = await cmd("Runtime.evaluate",
                          {"expression": POLL_JS, "returnByValue": True}, timeout=15)
            v = r.get("result", {}).get("result", {}).get("value", {})
        except Exception:
            continue
        if not isinstance(v, dict):
            continue
        u = v.get("u") or ""
        if want_host and want_host not in u:
            continue  # 目标未加载（还停在旧页面/被拦截）
        n = v.get("n") or 0
        if n == last:
            stable += 1
        else:
            stable = 0
            last = n
        if v.get("s") == "complete" and n > 200 and stable >= 2:
            break
    r = await cmd("Runtime.evaluate", {"expression": EXTRACT_JS, "returnByValue": True}, timeout=40)
    return r.get("result", {}).get("result", {}).get("value", {})


async def main():
    args = sys.argv[1:]
    # 兼容两种传参：直接传 URL（fetch-url 新路径，$1 原样传入）或
    # 整体 percent-encode 的 URL（旧路径），后者解一次码，避免 create_target 二次编码。
    raw_url = args[0]
    if "://" not in raw_url and "%" in raw_url:
        raw_url = urllib.parse.unquote(raw_url)
    url = raw_url
    render = "--render" in args[1:]
    import websockets
    v = {}
    # 模式 2 前置（v3.1）：只读复用「同站已加载」标签——attach 后直接采样+提取，
    # 不导航、不关闭、不触碰用户正在操作的页面（如 Reddit 新 tab 会得到空壳，
    # 已加载的既有 tab 才有完整内容；此路径是唯一可靠读取通道）。
    try:
        pages = [t for t in http_get("/json/list") if t.get("type") == "page"]
        want_host = urllib.parse.urlparse(url).netloc
        stable = [p for p in pages
                  if (p.get("url") or "").startswith("http")
                  and want_host and want_host in (p.get("url") or "")
                  and not (p.get("url") or "").startswith(("chrome://", "edge://", "devtools://", "about:"))]
        # 优先挑正文最长的同站标签
        ranked = []
        for p in stable[:5]:
            try:
                ws0 = await websockets.connect(
                    p["webSocketDebuggerUrl"].replace("127.0.0.1:9222", CDP_HOST), open_timeout=15)
                try:
                    cid0 = [0]
                    async def cmd0(method, params=None, timeout=15):
                        cid0[0] += 1
                        await ws0.send(json.dumps({"id": cid0[0], "method": method, "params": params or {}}))
                        while True:
                            m0 = json.loads(await asyncio.wait_for(ws0.recv(), timeout=timeout))
                            if m0.get("id") == cid0[0]:
                                return m0
                    await cmd0("Page.enable")
                    r0 = await cmd0("Runtime.evaluate",
                                    {"expression": POLL_JS, "returnByValue": True})
                    val = r0.get("result", {}).get("result", {}).get("value", {})
                    ranked.append((val.get("n") or 0, p, ws0, cmd0))
                except Exception:
                    try:
                        await ws0.close()
                    except Exception:
                        pass
            except Exception:
                pass
        if ranked:
            ranked.sort(key=lambda x: -x[0])
            n_best, p_best, ws_best, cmd_best = ranked[0]
            try:
                if n_best > 500:
                    r = await cmd_best("Runtime.evaluate",
                                       {"expression": EXTRACT_JS, "returnByValue": True}, timeout=30)
                    v = r.get("result", {}).get("result", {}).get("value", {})
            finally:
                try:
                    await ws_best.close()
                except Exception:
                    pass
    except Exception:
        pass
    # 模式 1：没有可复用的同站已加载标签时才新建临时标签。清理规则：本任务创建的
    # target 记下 targetId，成功/失败/超时/异常一律在 finally 中关闭。
    if not (v or {}).get("body"):
        target_info = None
        try:
            t = create_target(url)
            if t and t.get("id"):
                target_info = t
        except Exception:
            target_info = None
        if target_info:
            try:
                ws = await websockets.connect(target_info["webSocketDebuggerUrl"], open_timeout=15)
                try:
                    v = await read_via(ws, url, do_navigate=False, render=render)
                finally:
                    try:
                        await ws.close()
                    except Exception:
                        pass
            except Exception:
                pass
            finally:
                close_target(target_info.get("id"))
    v = v or {}
    print(json.dumps({
        "url": v.get("url", url),
        "title": v.get("title", ""),
        "author": v.get("author", ""),
        "published": v.get("published", ""),
        "body": v.get("body", ""),
    }, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
