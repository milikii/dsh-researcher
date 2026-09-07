#!/usr/bin/env bash
# mc-crawl — MediaCrawler 采集包装器（NAS Researcher 工具层强制执行标签页生命周期规则）
#
# 对应 preset 规则：
#   · 任务开始前记录 Chromium tab 基线（targetId 快照）
#   · 任务结束后关闭「本次任务新建」的平台工作页（explore/search 等 crawler 入口页）
#   · 用户原有 tab（含用户自己的知乎/小红书页面）一律保留；无法判断的宁可不关
#   · 批量采集绝不逐帖点浏览器（交给 MediaCrawler 内部）
#
# 用法：
#   mc-crawl '<crawler JSON body>' [--timeout 秒] [--no-sweep]
#   示例：
#   mc-crawl '{"platform":"xhs","login_type":"cookie","crawler_type":"search",
#              "keywords":"DeepSeek V4","enable_comments":false,"max_notes_count":20}'
#
# 防护（2026-09-03 phase1）：
#   · 所有 curl 一律 --noproxy '*'（内网服务不走 mihomo 折返）
#   · 预检 GET $API/api/health（3 秒超时），失败输出 {"error":"mediacrawler unreachable","api":"..."} 退出码 4
#   · body 校验：键集合以 $API/openapi.json 的 CrawlerStartRequest.properties 为准，
#     读取失败用内置兜底集合；集合外键 → 退出码 3；crawler_type 缺省或为 search 时 keywords 必须非空
#   · 状态轮询：解析失败连续 3 次打印 poll: unreachable 并退出循环（final_status=unreachable），
#     不再默认 running；默认 TIMEOUT=300
#
# 输出：JSON 汇总 {snapshot_tabs, started, status, new_tabs, closed, kept, user_tabs,
#                  final_status, data_file, data_lines}
set -u

API="${MC_API:-http://192.168.1.220:8088}"
CDP="http://172.19.0.2:9222"
BODY="${1:?用法: mc-crawl '<JSON body>' [--timeout 秒]}"
TIMEOUT=300
SWEEP=1
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --no-sweep) SWEEP=0; shift ;;
    *) shift ;;
  esac
done

SNAP=/tmp/mc-crawl-snapshot.json

# ── 0) 预检：MediaCrawler API 可达性（3 秒止损） ──────────────────────────────
HEALTH_CODE=$(curl -s --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' "$API/api/health" 2>/dev/null || true)
if [ "$HEALTH_CODE" != "200" ]; then
  echo "{\"error\":\"mediacrawler unreachable\",\"api\":\"$API\"}"
  exit 4
fi

# ── 0.5) body 校验：键集合（openapi 优先，失败用内置兜底）＋ keywords 规则 ────
OPENAPI=$(curl -s --noproxy '*' --max-time 5 "$API/openapi.json" 2>/dev/null || true)
BODY_CHECK=$(python3 - "$BODY" "$OPENAPI" <<'PYEOF'
import json, sys
body_raw, openapi_raw = sys.argv[1], sys.argv[2]
try:
    body = json.loads(body_raw)
except Exception as e:
    print(json.dumps({"error": "body 不是合法 JSON: %s" % e}, ensure_ascii=False))
    sys.exit(3)
try:
    oa = json.loads(openapi_raw)
    props = set(oa["components"]["schemas"]["CrawlerStartRequest"]["properties"].keys())
except Exception:
    props = set(["platform", "login_type", "crawler_type", "keywords", "specified_ids",
                 "creator_ids", "start_page", "enable_comments", "enable_sub_comments",
                 "save_option", "cookies", "headless", "max_notes_count",
                 "max_comments_count"])
unknown = sorted(k for k in body.keys() if k not in props)
if unknown:
    print(json.dumps({"error": "unknown body keys: %s" % unknown,
                      "allowed_keys": sorted(props)}, ensure_ascii=False))
    sys.exit(3)
ct = body.get("crawler_type") or "search"
if ct == "search" and not str(body.get("keywords") or "").strip():
    print(json.dumps({"error": "keywords required (non-empty) when crawler_type is search"},
                     ensure_ascii=False))
    sys.exit(3)
print("ok")
PYEOF
)
BODY_CHECK_EXIT=$?
if [ "$BODY_CHECK_EXIT" != "0" ]; then
  echo "$BODY_CHECK"
  exit "$BODY_CHECK_EXIT"
fi

# 平台 → 工作页 host 映射（sweep 只清理本次采集平台的工作页）
PLATFORM=$(echo "$BODY" | grep -o '"platform":"[a-z]*"' | cut -d'"' -f4 || true)
case "$PLATFORM" in
  xhs)   SWEEP_HOST="xiaohongshu.com" ;;
  zhihu) SWEEP_HOST="zhihu.com" ;;
  bili)  SWEEP_HOST="bilibili.com" ;;
  wb)    SWEEP_HOST="weibo.com" ;;
  dy)    SWEEP_HOST="douyin.com" ;;
  tieba) SWEEP_HOST="tieba.baidu.com" ;;
  *)     SWEEP_HOST="" ;;
esac

pages_json() {
  curl -s --noproxy '*' --max-time 8 "$CDP/json/list" | python3 -c "
import json,sys
try:
    ts=json.load(sys.stdin)
except Exception:
    print('[]'); sys.exit(0)
out=[]
for t in ts:
    if t.get('type')=='page':
        out.append({'id': t.get('id',''), 'url': t.get('url') or ''})
print(json.dumps(out, ensure_ascii=False))
"
}

# 1) 快照基线（任务开始前的所有 page targetId）
pages_json > "$SNAP"
BASE_IDS=$(python3 -c "
import json
ts=json.load(open('$SNAP'))
print(' '.join(t['id'] for t in ts))
")

# 2) 启动采集（CDP 串行锁：采集器驱动 Chromium，与 fetch-url/shop-search/x-search 共用 /tmp/cdp.lock）
if command -v flock >/dev/null 2>&1; then FLOCK="flock -w 240 /tmp/cdp.lock -c"; else FLOCK=""; fi
START_RESP=$($FLOCK curl -s --noproxy '*' --max-time 15 -X POST "$API/api/crawler/start" \
  -H "Content-Type: application/json" -d "$BODY" 2>/dev/null || curl -s --noproxy '*' --max-time 15 -X POST "$API/api/crawler/start" -H "Content-Type: application/json" -d "$BODY")
echo "start: $(echo "$START_RESP" | head -c 120)"

# 3) 等待结束（idle/error），超时强制退出等待；解析失败连续 3 次视为 unreachable
STATUS="running"
POLL_FAILS=0
WAITED=0
while [ "$STATUS" = "running" ] || [ "$STATUS" = "stopping" ]; do
  [ "$WAITED" -ge "$TIMEOUT" ] && { echo "poll: timeout after ${TIMEOUT}s"; break; }
  sleep 10
  WAITED=$((WAITED+10))
  STATUS=$(curl -s --noproxy '*' --max-time 10 "$API/api/crawler/status" 2>/dev/null | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('status',''))
except Exception: print('')
" 2>/dev/null)
  if [ -z "$STATUS" ]; then
    POLL_FAILS=$((POLL_FAILS+1))
    echo "poll[$((WAITED/10))]: parse failed ($POLL_FAILS/3)"
    if [ "$POLL_FAILS" -ge 3 ]; then
      echo "poll: unreachable"
      STATUS="unreachable"
      break
    fi
  else
    POLL_FAILS=0
    echo "poll[$((WAITED/10))]: status=$STATUS"
  fi
done

# 4) sweep：关闭本次任务新建的平台工作页（保留基线内与其它站点页面）
NEW_CLOSED=0
KEPT=0
# 超时退出时爬虫可能仍在跑：此时 sweep 会关掉它正在用的工作页，必须跳过
if [ "$STATUS" = "running" ] || [ "$STATUS" = "stopping" ]; then
  echo "sweep: skipped (crawler still $STATUS after ${TIMEOUT}s timeout; check $API/api/crawler/status and rerun with --timeout N)"
  SWEEP=0
fi
if [ "$SWEEP" = "1" ] && [ -n "$SWEEP_HOST" ]; then
  for id in $(pages_json | python3 -c "
import json,sys
base=set('''$BASE_IDS'''.split())
ts=json.load(sys.stdin)
for t in ts:
    tid=t['id']
    if tid in base:  # 基线内 → 保留
        continue
    url=t['url']
    if '$SWEEP_HOST' not in url:  # 非本次平台 → 保留
        continue
    print(tid)
" ); do
    curl -s --noproxy '*' --max-time 8 -X DELETE "$CDP/json/close/$id" -o /dev/null && NEW_CLOSED=$((NEW_CLOSED+1))
  done
fi
sleep 3
FINAL=$(pages_json)
FINAL_N=$(echo "$FINAL" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "tabs after sweep: $FINAL_N (closed_new=$NEW_CLOSED)"

# 5) 数据文件定位：/home/docker/mediacrawler/data/<platform>/jsonl/ 下最新文件
DATA_FILE=$(ls -t "/home/docker/mediacrawler/data/$PLATFORM/jsonl/"*.jsonl 2>/dev/null | head -1 || true)
if [ -n "$DATA_FILE" ]; then
  DATA_LINES=$(wc -l < "$DATA_FILE" 2>/dev/null || echo 0)
else
  DATA_FILE="null"
  DATA_LINES="null"
fi

python3 - "$START_RESP" "$STATUS" "$NEW_CLOSED" "$FINAL_N" "$SNAP" "$DATA_FILE" "$DATA_LINES" <<'EOF'
import json, sys
start_resp, status, closed, final_n, snap_path, data_file, data_lines = sys.argv[1:8]
snap_n = len(json.load(open(snap_path)))
try:
    sr = json.loads(start_resp)
except Exception:
    sr = {"raw": start_resp[:120]}
print(json.dumps({
    "snapshot_tabs": snap_n,
    "start_response": sr,
    "final_status": status,
    "closed_new_work_tabs": int(closed),
    "tabs_after": int(final_n),
    "data_file": data_file if data_file != "null" else None,
    "data_lines": int(data_lines) if data_lines != "null" else None,
}, ensure_ascii=False))
EOF

# 6) 证据账本：结束时若 data_file 非空，写入 ledger（NAS_LEDGER=0 关闭；异常静默）
if [ "${NAS_LEDGER:-1}" != "0" ] && [ "$DATA_FILE" != "null" ] && [ -n "$DATA_FILE" ] && [ -x /usr/local/bin/ledger ]; then
  KEYWORD=$(echo "$BODY" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('keywords',''))" 2>/dev/null || echo "")
  /usr/local/bin/ledger add-mc "$DATA_FILE" --platform "$PLATFORM" --keyword "$KEYWORD" >/dev/null 2>&1 || true
fi