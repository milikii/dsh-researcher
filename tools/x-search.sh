#!/usr/bin/env bash
# x-search — X(Twitter) 登录态站内搜索（NAS Researcher 实时信息源工具）
#
# 背景：X 与 Reddit 是 NAS Researcher 的「实时信息优先参考源」。
#   · Reddit 读取：cdp_read.py v3.1 只读复用同站已加载标签（新 tab 会是空壳）
#   · X 站内搜索：本工具在登录态 Chromium 开临时 tab → 搜索 → 提取 → finally 关闭
#
# 用法：x-search '<关键词>' [--count N] [--latest]
# 输出：每行一条推文（作者 @handle · 时间）＋ 正文前 320 字
set -u
Q="${1:?用法: x-search '<关键词>' [--count N] [--latest]}"
COUNT=10
F="top"
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    --latest) F="live"; shift ;;
    *) shift ;;
  esac
done

# CDP 串行锁：与 fetch-url/shop-search/mc-crawl 共用 /tmp/cdp.lock（等待上限 240s）
if command -v flock >/dev/null 2>&1; then FLOCK="flock -w 240 /tmp/cdp.lock"; else FLOCK=""; fi

$FLOCK docker run --rm --network ai-browser \
  -v /root/.dsh/tools/cdp_read.py:/r.py \
  python:3.12-alpine sh -c \
  "pip install -q websockets >/dev/null 2>&1 && timeout 150 python - $'$Q' $COUNT $F <<'PYEOF'
import asyncio, json, sys, urllib.request, urllib.parse
CDP = \"http://172.19.0.2:9222\"
async def main():
    import websockets
    q, count, f = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    url = \"https://x.com/search?q=\" + urllib.parse.quote(q) + \"&f=\" + f
    req = urllib.request.Request(f\"{CDP}/json/new?{urllib.parse.quote(url, safe='')}\", method=\"PUT\")
    t = json.load(urllib.request.urlopen(req, timeout=10))
    tid = t.get(\"id\")
    try:
        ws = await websockets.connect(t[\"webSocketDebuggerUrl\"].replace(\"127.0.0.1:9222\", \"172.19.0.2:9222\"), open_timeout=15)
        cid = [0]
        async def cmd(m, p=None, to=25):
            cid[0] += 1
            await ws.send(json.dumps({\"id\": cid[0], \"method\": m, \"params\": p or {}}))
            while True:
                mm = json.loads(await asyncio.wait_for(ws.recv(), timeout=to))
                if mm.get(\"id\") == cid[0]:
                    return mm
        await cmd(\"Page.enable\")
        await asyncio.sleep(12)
        for _ in range(2):
            await cmd(\"Runtime.evaluate\", {\"expression\": \"window.scrollBy(0, 2400)\"}, to=15)
            await asyncio.sleep(4)
        r = await cmd(\"Runtime.evaluate\", {\"expression\": \"\"\"
(() => {
  const out = [];
  document.querySelectorAll('article[data-testid=\"tweet\"]').forEach(a => {
    const uname = a.querySelector('[data-testid=\"User-Name\"]')?.innerText || '';
    const txt = a.querySelector('[data-testid=\"tweetText\"]')?.innerText || '';
    if (txt) out.push({user: uname.replace(/\\\\n/g,' ').slice(0,60), text: txt.slice(0,320)});
  });
  return out;
})()
\"\"\", \"returnByValue\": True}, to=25)
        posts = r.get(\"result\", {}).get(\"result\", {}).get(\"value\") or []
        print(json.dumps({\"query\": q, \"count\": min(len(posts), count), \"posts\": posts[:count]}, ensure_ascii=False))
    finally:
        try:
            await ws.close()
        except Exception:
            pass
        try:
            req = urllib.request.Request(f\"{CDP}/json/close/{tid}\", method=\"DELETE\")
            urllib.request.urlopen(req, timeout=8)
        except Exception:
            pass
asyncio.run(main())
PYEOF" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"=== {d['query']} → {d['count']} 条 ===\")
for p in d['posts']:
    print('·', p['user'])
    print(' ', p['text'])
"