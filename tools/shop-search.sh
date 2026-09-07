#!/usr/bin/env bash
# shop-search v2 — 登录态购物平台搜索（NAS 买手核心工具）
#
# 结构：本 bash 包装器（参数 / 子命令 / 缓存 / 冷却 / 配额 / 标签状态 / docker 调用 / 调用日志）
#       + shop_search_cdp.py（CDP worker，在 dsh-cdp-keepalive 容器内运行，stdout 单行 JSON）
#
# 平台通道：
#   jd            京东 PC 搜索（[data-sku] 卡片；到手价/原价/已售/店铺）
#   1688:desktop  1688 桌面版 s.1688.com（默认；--pages N 翻页；两次中转页→soft_block 后自动禁用 24h 是保护机制）
#   1688          1688 移动版 m.1688.com（仅 SHOP_1688_MOBILE=1 显式放行时用：滑块风控高发，老被 punish 拦截）
#   taobao/tmall  登录态 CDP（x5sec 间歇拦截，被拦时如实报 needs_human/空结果）
#   pdd           移动版（未登录→login.html 判 needs_human，请在 Web UI 登录）
#   douyin        不支持：桌面版无商品搜索，立即如实输出（不开标签页）
#   cloud[:taobao|xhs]  Shopme 云库免 Key API（缓存价 C 级；上游仅支持 taobao/xhs）
#
# 用法：
#   shop-search.sh <platform> <keyword> [page] [--pages N] [--scroll N] [--fresh] [--wait-human N] [--debug]
#   shop-search.sh close [platform|all]      # 关闭本工具记录的可复用标签（needs_human 的保留）
#   shop-search.sh status                    # 各平台配额/冷却/needs_human/标签（JSON）
#   shop-search.sh offer <offerId|url>       # 详情页结构化读取（备案号/生产企业/店龄/回头率/MOQ 阶梯/成分）+ 写账本
#   shop-search.sh clear-cooldown <platform> # 清冷却 + 清 needs_human 记录
#
# 环境变量：
#   SHOP_CLOUD_SORT=relevance|price_asc|price_desc|sales_desc
#   SHOP_SEARCH_DEBUG=1     # 等价 --debug，worker stderr 输出 [dbg]
#   SHOP_CACHE_TTL=1800     # 结果缓存秒数（缓存只用于去重省调用，不冒充实时价）
#   SHOP_TAB_TTL=300        # 可复用标签空闲过期秒数
#   SHOP_QUOTA_<PLATFORM>=<interval_s>,<hourly>,<daily>   # 覆盖配额（1688:desktop → SHOP_QUOTA_1688_DESKTOP）
#   SHOP_SEARCH_FAKE_RESULT=<path>  # 测试：跳过 docker，把文件内容当 worker 输出（仍走缓存/冷却/日志逻辑）
#
# 配额表（默认；每平台 interval 秒 / 每小时 / 每天）：
#   1688: 120s/6/30 · 1688:desktop: 180s/6/30 · jd: 30s/12/60 · taobao/tmall: 120s/4/12
#   pdd: 60s/6/20 · cloud: 10s/60/500
# 冷却：needs_human 600s · soft_block 900s · 连续两次空结果 300s
# 全局预算（2026-09-06）：跨平台 CDP 实时搜索合计 12 次 / 60 分钟（SHOP_GLOBAL_BUDGET=<count>,<window_s>）
# 变体拒绝（2026-09-06）：同平台族 10 分钟内近似关键词（相似度 ≥0.7 或包含）直接拒绝，提示加 --pages
#   （SHOP_ALLOW_VARIANT=1 放行；SHOP_VARIANT_WINDOW / SHOP_VARIANT_THRESHOLD 可调）
# 账本兜底（2026-09-06）：冷却/禁用/配额/频控/变体拒绝/needs_human/soft_block/空结果 时，
#   products[] 挂同关键词账本历史（C 级，from_cache=true, cache_source=ledger, cached_at=最新原检索时间），
#   并给 fallback.next 降级路线（offer 详情页 → cloud → 等冷却重跑同一命令）。退出码不变。
#   SHOP_LEDGER_SINCE=30d 限定历史时长；NAS_LEDGER=0 同时关闭读写。
#
# 退出码：0 正常（含如实降级）· 2 频控/间隔 · 3 参数错 · 4 基础设施故障 · 5 冷却/needs_human/配额用尽/变体拒绝
#
# 状态目录 /tmp/shop-search/：cache/<sha1>.json · cooldown-<platform>.json · tab-<platform>.json ·
#   needs_human.json · calls.log（TAB 分隔：ts platform keyword page products error elapsed_s exit_code）
# 证据账本：结果自动写 /usr/local/bin/ledger（add-search / add-detail）；NAS_LEDGER=0 关闭

set -u

TOOLS_DIR="/root/.dsh/tools"
WORKER="$TOOLS_DIR/shop_search_cdp.py"
STATE_DIR="/tmp/shop-search"
CDP_ENDPOINT="http://172.19.0.2:9222"
MIHOMO_HOST="http://192.168.1.220:7890"
WEBUI_URL="https://192.168.1.220:3001"
IMAGE="dsh-cdp-keepalive:latest"
FALLBACK_IMAGE="python:3.12-alpine"
CACHE_TTL="${SHOP_CACHE_TTL:-1800}"
TAB_TTL="${SHOP_TAB_TTL:-300}"
RATE_SECONDS="${SHOP_RATE_SECONDS:-30}"

mkdir -p "$STATE_DIR"

usage() {
  cat <<'EOF'
shop-search v2 — 登录态购物平台搜索（NAS 买手）

用法:
  shop-search.sh <platform> <keyword> [page] [--pages N] [--scroll N] [--fresh] [--wait-human N] [--debug]
  shop-search.sh close [platform|all]
  shop-search.sh status
  shop-search.sh clear-cooldown <platform>

platform:
  1688:desktop  桌面版 s.1688.com（默认；--pages N 1-3 翻页；两次 soft_block 后自动禁用 24h 是保护机制）
  1688          移动版 m.1688.com（仅 SHOP_1688_MOBILE=1 时用；--scroll N 滚动；滑块风控高发）
  jd            京东 PC 搜索（支持 --pages 1-3 翻页）
  taobao|tmall  登录态 CDP（x5sec 间歇）
  pdd           移动版（未登录时 needs_human，请在 Web UI 登录）
  douyin        不支持（桌面版无商品搜索，立即如实输出）
  cloud[:taobao|xhs]  Shopme 云库免 Key（缓存价 C 级；上游仅 taobao/xhs，无 tmall）

子命令:
  close [platform|all]        关闭本工具记录的可复用标签（needs_human 标签保留给用户处理）
  status                      JSON：各平台 quota_used_hour/day、cooldown、needs_human、可复用标签
  clear-cooldown <platform>   用户处理完验证后清除冷却与 needs_human 记录
  offer <offerId|url>         详情页结构化：fetch-url --cdp-first 读 1688/京东详情页，抽取公司/备案号/MOQ/成分并写账本

选项:
  --pages N     翻页 1-3（仅 jd / 1688:desktop；移动版 1688 用 --scroll）
  --scroll N    移动版 1688 滚动次数（默认 4，上限 8；一条关键词优先加大 scroll 而不是换词重搜）
  --fresh       忽略缓存强制实时读取
  --wait-human N  needs_human 时原地等待真人处理的最长秒数（卡片出现即继续提取）
  --debug       worker 诊断输出到 stderr

环境变量:
  SHOP_CLOUD_SORT / SHOP_SEARCH_DEBUG / SHOP_CACHE_TTL / SHOP_TAB_TTL
  SHOP_QUOTA_<PLATFORM>=<interval_s>,<hourly>,<daily>（如 SHOP_QUOTA_1688=0,99,99；1688:desktop → SHOP_QUOTA_1688_DESKTOP）
  SHOP_SEARCH_FAKE_RESULT=<path>  测试用假 worker 输出

输出: 单行 JSON —— {platform, keyword, retrieved_at, login_state, products[], error,
  channel(cdp-login|cdp-login-mobile|cdp-login-desktop|cloud-cache), evidence(A|C|unknown),
  elapsed_s, from_cache?, cached_at?, cache_source?(ledger), fallback?{ledger_hits,next},
  needs_human?, reason?, tab?, open_in_webui?, cooldown_until?, quota_reset_at?, pages?}
  被阻断（退出码 5/2 或 needs_human/soft_block/空结果）时 products[] 可能是账本历史（C 级），看 cache_source。

退出码: 0 正常(含如实降级) · 2 频控 · 3 参数错 · 4 基础设施故障 · 5 冷却/needs_human/配额/全局预算/变体拒绝
EOF
}

quota_for() {
  case "$1" in
    1688)         echo "${SHOP_QUOTA_1688:-120,6,30}" ;;
    1688:desktop) echo "${SHOP_QUOTA_1688_DESKTOP:-180,6,30}" ;;
    jd)           echo "${SHOP_QUOTA_JD:-30,12,60}" ;;
    taobao)       echo "${SHOP_QUOTA_TAOBAO:-120,4,12}" ;;
    tmall)        echo "${SHOP_QUOTA_TMALL:-120,4,12}" ;;
    pdd)          echo "${SHOP_QUOTA_PDD:-60,6,20}" ;;
    cloud)        echo "${SHOP_QUOTA_CLOUD:-10,60,500}" ;;
    *)            echo "${RATE_SECONDS},9999,99999" ;;
  esac
}

# ── gate：缓存 → 冷却 → 桌面禁用 → 配额/间隔 → 标签清扫；输出两行（action / payload） ──
gate() {
  SHOP_CACHE_TTL="$CACHE_TTL" SHOP_TAB_TTL="$TAB_TTL" SHOP_QUOTA="$(quota_for "$1")" \
  python3 - "$@" <<'PYEOF'
import datetime, difflib, glob, hashlib, json, os, re, sys, time, urllib.request
sys.path.insert(0, "/root/.dsh/tools")
from shop_search_fallback import attach_fallback   # L2 账本兜底：被阻断时挂历史 offers（C 级）+ 降级路线

STATE, CDP, WEBUI = "/tmp/shop-search", "http://172.19.0.2:9222", "https://192.168.1.220:3001"
TZ = datetime.timezone(datetime.timedelta(hours=8))
state, token, kw, page, pages, sort, fresh = sys.argv[1:8]
fresh = fresh == "1"
CACHE_TTL = int(os.environ.get("SHOP_CACHE_TTL", "1800"))
TAB_TTL = int(os.environ.get("SHOP_TAB_TTL", "300"))
interval, hourly, daily = (int(x) for x in os.environ.get("SHOP_QUOTA", "30,9999,99999").split(","))
now = time.time()

def iso(t=None):
    return datetime.datetime.fromtimestamp(t or now, TZ).isoformat(timespec="seconds")

def read_json(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d

def write_json(p, v):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(v, f, ensure_ascii=False)

def say(action, payload):
    print(action)
    print(payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False))
    sys.exit(0)

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def cdp_page_ids():
    try:
        with _opener.open(urllib.request.Request(CDP + "/json/list"), timeout=8) as r:
            return {t.get("id") for t in json.loads(r.read().decode()) if t.get("type") == "page"}
    except Exception:
        return None

def close_tab(tid):
    try:
        _opener.open(urllib.request.Request(f"{CDP}/json/close/{tid}", method="DELETE"), timeout=8)
    except Exception:
        pass

def needs_human_tabs():
    return {x.get("tab") for x in read_json(f"{STATE}/needs_human.json", []) if x.get("tab")}

# 1) 缓存命中（不消耗配额、不开标签）
key = f"{token}|{kw}|{page}|{pages}|{sort}"
cpath = f"{STATE}/cache/{hashlib.sha1(key.encode()).hexdigest()}.json"
if not fresh and os.path.exists(cpath):
    d = read_json(cpath, None)
    if d and now - os.path.getmtime(cpath) < CACHE_TTL:
        out = dict(d)
        out["from_cache"] = True
        out["cached_at"] = iso(os.path.getmtime(cpath))
        say("cache", out)

# 2) 冷却（被阻断 → 挂账本历史兜底，C 级）
cd = read_json(f"{STATE}/cooldown-{state}.json", None)
if cd and float(cd.get("until") or 0) > now:
    say("cooldown", attach_fallback({"platform": token, "keyword": kw, "retrieved_at": iso(),
                     "login_state": "unknown", "products": [],
                     "error": f"cooldown: {cd.get('reason')}",
                     "needs_human": bool(cd.get("needs_human")),
                     "cooldown_until": iso(float(cd["until"])),
                     "open_in_webui": WEBUI, "tab": cd.get("tab")}, state, kw))

# 3) 1688 桌面自动禁用（两次 soft_block 后 24h）
dfile = f"{STATE}/disabled-1688-desktop.ts"
if state == "1688:desktop":
    if os.path.exists(dfile):
        if now - os.path.getmtime(dfile) < 86400:
            say("disabled", attach_fallback({"platform": token, "keyword": kw, "retrieved_at": iso(),
                             "login_state": "unknown", "products": [],
                             "error": f"1688 desktop disabled until {iso(os.path.getmtime(dfile) + 86400)}"
                                      "（软风控）; 改用 offer 详情页通道 / ledger / cloud",
                             "cooldown_until": iso(os.path.getmtime(dfile) + 86400)}, state, kw))
        else:
            os.remove(dfile)

# 4) 标签清扫（TTL 过期 / 已消失；needs_human 的保留；总数上限 2；顺带清 v1 遗留 active-*.ts）
protected = needs_human_tabs()
page_ids = cdp_page_ids()
kept = []
for f in sorted(glob.glob(f"{STATE}/tab-*.json")):
    rec = read_json(f, None)
    if not rec or not rec.get("target_id"):
        try: os.remove(f)
        except Exception: pass
        continue
    tid = rec["target_id"]
    if tid in protected:
        kept.append(rec); continue
    expired = now - float(rec.get("last_used") or 0) > TAB_TTL
    gone = page_ids is not None and tid not in page_ids
    if expired or gone:
        if expired and not gone:
            close_tab(tid)
        try: os.remove(f)
        except Exception: pass
    else:
        rec["_file"] = f
        kept.append(rec)
if len(kept) > 2:
    kept.sort(key=lambda r: float(r.get("last_used") or 0))
    for rec in kept[:-2]:
        if rec["target_id"] in protected:
            continue
        close_tab(rec["target_id"])
        try: os.remove(rec["_file"])
        except Exception: pass
for f in glob.glob(f"{STATE}/active-*.ts"):   # v1 遗留记录
    try:
        tid = open(f).read().strip().split(":")[0]
        if tid and tid not in protected:
            close_tab(tid)
        os.remove(f)
    except Exception:
        pass

# 5) 配额与间隔（calls.log 只记真实调用：缓存命中/冷却/配额拒绝不计）
try:
    lines = [l.split("\t") for l in open(f"{STATE}/calls.log") if l.strip()]
except Exception:
    lines = []
mine = [l for l in lines if len(l) > 7 and l[1] == state]

def quota_out(msg, reset_at=None):
    o = {"platform": token, "keyword": kw, "retrieved_at": iso(), "login_state": "unknown",
         "products": [], "error": msg}
    if reset_at:
        o["quota_reset_at"] = reset_at
    return o

if mine:
    last_ts = float(mine[-1][0])
    if now - last_ts < interval:
        say("rate", attach_fallback(quota_out(
            f"rate limited: last call was {int(now - last_ts)}s ago, need >= {interval}s between calls per platform"),
            state, kw))
h = [l for l in mine if now - float(l[0]) < 3600]
d = [l for l in mine if now - float(l[0]) < 86400]
if len(h) >= hourly:
    say("quota", attach_fallback(quota_out(f"quota exceeded: {len(h)}/{hourly} hourly calls used",
                           iso(float(h[0][0]) + 3600)), state, kw))
if len(d) >= daily:
    say("quota", attach_fallback(quota_out(f"quota exceeded: {len(d)}/{daily} daily calls used",
                           iso(float(d[0][0]) + 86400)), state, kw))

# 5b) 全局搜索预算（跨平台合计，只算 CDP 实时通道；cloud 不计）
#     各平台每小时配额相加约 38 次，换平台轮着搜仍能高频打站——这正是「买手预设老被控」的主因之一。
#     默认 12 次 / 60 分钟；SHOP_GLOBAL_BUDGET=<count>,<window_s> 覆盖。超出 → 走 offer / ledger / cloud。
if state != "cloud":
    gb_n, gb_w = (int(x) for x in os.environ.get("SHOP_GLOBAL_BUDGET", "12,3600").split(","))
    live = [l for l in lines if len(l) > 7 and l[1] != "cloud" and now - float(l[0]) < gb_w]
    if len(live) >= gb_n:
        say("quota", attach_fallback(quota_out(
            f"global budget exceeded: {len(live)}/{gb_n} live searches across all platforms in the last "
            f"{gb_w // 60} min（防高频触发风控）; 改走 offer 详情页 / ledger 历史 / cloud，或等 quota_reset_at",
            iso(float(live[0][0]) + gb_w)), state, kw))

# 5c) 关键词变体检测（同平台族近 10 分钟内的近似关键词）
#     「换词硬试」是触发风控的主因（评估 §2.5；账本里 vivo 充电器 5 个变体连搜即实例）。
#     近似 = 归一化后 SequenceMatcher ≥ 0.7，或一方包含另一方（≥4 字）。同词不算变体（缓存/间隔另管）。
#     SHOP_ALLOW_VARIANT=1 放行；SHOP_VARIANT_WINDOW / SHOP_VARIANT_THRESHOLD 可调。
if state != "cloud" and os.environ.get("SHOP_ALLOW_VARIANT", "0") != "1":
    win = int(os.environ.get("SHOP_VARIANT_WINDOW", "600"))
    thr = float(os.environ.get("SHOP_VARIANT_THRESHOLD", "0.7"))
    norm = lambda s: re.sub(r"[\s\W_]+", "", (s or "").lower())
    me, fam = norm(kw), state.split(":")[0]
    recent = [l for l in lines if len(l) > 7 and l[1].split(":")[0] == fam and now - float(l[0]) < win]
    for l in reversed(recent):
        prev, pn = l[2], norm(l[2])
        if not pn or pn == me:
            continue
        ratio = difflib.SequenceMatcher(None, me, pn).ratio()
        contained = len(min(me, pn, key=len)) >= 4 and (me in pn or pn in me)
        if ratio >= thr or contained:
            say("quota", attach_fallback(quota_out(
                f"keyword variant rejected: 「{kw}」≈「{prev}」(similarity {ratio:.2f}) searched "
                f"{int(now - float(l[0]))}s ago on {l[1]}. 用原关键词加 --pages N 取更多结果，不要连续换词变体"
                f"（风控主因）；确属不同商品可设 SHOP_ALLOW_VARIANT=1"), state, kw))

# 6) proceed：回传本平台可复用标签
tab = "null"
rec = read_json(f"{STATE}/tab-{state}.json", None)
if rec and rec.get("target_id"):
    if (page_ids is None or rec["target_id"] in (page_ids or set())) \
            and rec["target_id"] not in protected:
        tab = rec["target_id"]
say("proceed", tab)
PYEOF
}

# ── ledger 写入（证据账本；NAS_LEDGER=0 关闭；任何异常静默） ──
ledger_write() {
  [ "${NAS_LEDGER:-1}" = "0" ] && return 0
  [ -x /usr/local/bin/ledger ] || return 0
  python3 - "$1" <<'PYEOF' 2>/dev/null || true
import json, subprocess, sys
try:
    d = json.load(open(sys.argv[1]))
    # 账本兜底挂上来的历史 offers 不回写（防自我复制成新一批“检索结果”）
    if d.get("cache_source") == "ledger" or d.get("from_cache"):
        sys.exit(0)
    subprocess.run(["/usr/local/bin/ledger", "add-search"],
                   input=json.dumps(d, ensure_ascii=False),
                   capture_output=True, text=True, timeout=5)
except Exception:
    pass
PYEOF
}

# ── offer 子命令：详情页结构化读取（fetch-url --cdp-first）+ ledger add-detail ──
offer_cmd() {
  local ID="${1:-}"
  [ -n "$ID" ] || { echo '{"error":"用法: shop-search.sh offer <offerId|url>"}'; exit 3; }
  case "$ID" in
    http*) URL="$ID" ;;
    *) URL="https://detail.1688.com/offer/$ID.html" ;;
  esac
  OFFER_ID="$(echo "$URL" | grep -oE 'offer/[0-9]+' | grep -oE '[0-9]+' || echo "$ID")"
  TMP=$(mktemp /tmp/shop-search/.offer.XXXXXX.json)
  fetch-url "$URL" --cdp-first --max-chars 20000 > "$TMP" 2>/dev/null || true
  python3 - "$TMP" "$OFFER_ID" "$URL" <<'PYEOF'
import datetime, json, re, subprocess, sys

tmp, offer_id, url = sys.argv[1], sys.argv[2], sys.argv[3]
TZ = datetime.timezone(datetime.timedelta(hours=8))
REG_NO_RE = re.compile(r"(?:[京津沪渝冀晋辽吉黑苏浙皖闽赣鲁豫鄂湘粤桂琼川贵云陕甘青蒙藏宁新]G?妆网备字|国妆[特备]?进?字)\s*[A-Z]?\d{6,12}")
try:
    d = json.load(open(tmp))
except Exception as e:
    print(json.dumps({"error": f"fetch-url 输出不可解析: {e}"})); sys.exit(4)
content = (d.get("content") or d.get("body") or "")
flat = re.sub(r"\s+", " ", content)

def grab(pattern, n=1):
    m = re.search(pattern, flat)
    return m.group(n) if m else None

reg_m = REG_NO_RE.search(flat)
company = (grab(r"公司名称[:：]?\s*([^ ]{2,40}?(?:有限公司|股份公司|厂|商行|经营部))")
           or grab(r"供应商[:：]?\s*([^ ]{2,40}?(?:公司|厂))")
           or grab(r"([\u4e00-\u9fa5]{2,20}(?:有限公司|股份有限公司))(?=关注|客服|商品|入驻|主营)"))
out = {
    "platform": "1688" if "1688.com" in url else ("jd" if "jd.com" in url else "web"),
    "offer_id": offer_id, "url": url,
    "retrieved_at": d.get("retrieved_at") or datetime.datetime.now(TZ).isoformat(timespec="seconds"),
    "method": d.get("method"), "evidence": "A" if d.get("login_state") else "B",
    "title": (d.get("title") or "")[:200],
    "company": company,
    "shop_age": grab(r"(\d+)年"),
    "repeat_rate": grab(r"回头率[:：]?\s*(\d+%)") or grab(r"复购率[:：]?\s*(\d+%)"),
    "moq_ladder": "；".join(f"≥{a}件 ¥{b}" for a, b in re.findall(r"≥\s*(\d+)\s*件\s*¥?\s*([\d.]+)", flat)[:8]) or None,
    "reg_no": reg_m.group(0) if reg_m else None,
    "manufacturer": grab(r"生产企业[:：]?\s*([^ ]{2,40}?(?:公司|厂))"),
    "brand": grab(r"品牌[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,20})"),
    "raw_excerpt": content[:1500],
}
m = re.search(r"成分[:：]\s*(.{0,2000}?)(?:生产许可证|备案|执行标准|保质期|$)", flat)
if m and ("、" in m.group(1) or "，" in m.group(1) or "," in m.group(1)):
    out["ingredients"] = m.group(1)[:2000]
print(json.dumps(out, ensure_ascii=False))
try:
    subprocess.run(["/usr/local/bin/ledger", "add-detail"],
                   input=json.dumps(out, ensure_ascii=False),
                   capture_output=True, text=True, timeout=5)
except Exception:
    pass
PYEOF
  rm -f "$TMP"
}

# ── post：解析 worker/cloud 输出 → 状态写入（calls.log/缓存/冷却/needs_human/标签）→ 最终 JSON + 退出码 ──
post() {
  python3 - "$@" <<'PYEOF'
import datetime, hashlib, json, os, sys, time
sys.path.insert(0, "/root/.dsh/tools")
from shop_search_fallback import attach_fallback   # L2 账本兜底

STATE, WEBUI = "/tmp/shop-search", "https://192.168.1.220:3001"
TZ = datetime.timezone(datetime.timedelta(hours=8))
wfile, token, state, kw, page, pages, sort, elapsed = sys.argv[1:9]
elapsed = float(elapsed)
now = time.time()

def iso(t=None):
    return datetime.datetime.fromtimestamp(t or now, TZ).isoformat(timespec="seconds")

def read_json(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d

def write_json(p, v):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(v, f, ensure_ascii=False)

def read_cnt(p):
    try:
        return int(open(p).read().strip() or 0)
    except Exception:
        return 0

def write_cnt(p, v):
    if v <= 0:
        try: os.remove(p)
        except Exception: pass
    else:
        with open(p, "w") as f:
            f.write(str(v))

def rm(p):
    try: os.remove(p)
    except Exception: pass

try:
    d = json.load(open(wfile))
except Exception as e:
    print(4)
    print(json.dumps({"platform": token, "keyword": kw, "retrieved_at": iso(),
                      "login_state": "unknown", "products": [], "channel": "unknown",
                      "evidence": "unknown", "elapsed_s": elapsed,
                      "error": f"infra: worker output unparseable: {str(e)[:100]}"}, ensure_ascii=False))
    sys.exit(0)

channel = d.get("channel") or (
    "cloud-cache" if state == "cloud" else
    {"1688": "cdp-login-mobile", "1688:desktop": "cdp-login-desktop"}.get(token, "cdp-login"))
live_n = len(d.get("products") or [])   # 实时通道真实产出数（calls.log 只记这个，不记兜底条数）
if state == "cloud":
    evidence = "C"
elif channel.startswith("cdp-login") and d.get("login_state") == "yes":
    evidence = "A"
else:
    evidence = "unknown"

base = {"platform": d.get("platform") or token, "keyword": kw,
        "retrieved_at": d.get("retrieved_at") or iso(),
        "login_state": d.get("login_state", "unknown"),
        "products": d.get("products") or [], "error": d.get("error"),
        "channel": channel, "evidence": evidence, "elapsed_s": elapsed}
for k in ("variant", "pages", "price_note", "cookie_names"):
    if d.get(k):
        base[k] = d[k]

def finish(code, out):
    log = [f"{now:.0f}", state, kw, str(page), str(live_n),
           str(out.get("error") or "")[:60].replace("\t", " "), f"{elapsed:.1f}", str(code)]
    try:
        with open(f"{STATE}/calls.log", "a") as f:
            f.write("\t".join(log) + "\n")
    except Exception:
        pass
    print(code)
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)

# 基础设施故障：不消耗配额（不写 calls.log）
if d.get("infra_error"):
    out = dict(base)
    out["error"] = d.get("error")
    print(4)
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)

tab = d.get("tab")

# needs_human：写 600s 冷却 + needs_human.json（标签保留给用户）
if d.get("needs_human"):
    write_json(f"{STATE}/cooldown-{state}.json",
               {"until": now + 600, "reason": d.get("reason") or "anti-bot",
                "needs_human": True, "tab": tab})
    nh = [x for x in read_json(f"{STATE}/needs_human.json", []) if x.get("platform") != state]
    nh.append({"platform": state, "tab": tab, "url": d.get("url"),
               "since": iso(), "reason": d.get("reason")})
    write_json(f"{STATE}/needs_human.json", nh)
    if tab:
        old = read_json(f"{STATE}/tab-{state}.json", {})
        write_json(f"{STATE}/tab-{state}.json",
                   {"target_id": tab, "created": old.get("created") or now, "last_used": now})
    out = dict(base, needs_human=True, reason=d.get("reason"), tab=tab,
               url=d.get("url"), open_in_webui=WEBUI, cooldown_until=iso(now + 600))
    finish(5, attach_fallback(out, state, kw))

# soft_block（1688 桌面中转页）：900s 冷却；两次后 24h 禁用
if d.get("soft_block") or "soft-block" in str(d.get("error") or ""):
    cnt = read_cnt(f"{STATE}/soft-{state}.cnt") + 1
    if state == "1688:desktop" and cnt >= 2:
        open(f"{STATE}/disabled-1688-desktop.ts", "w").close()
        write_cnt(f"{STATE}/soft-{state}.cnt", 0)
    else:
        write_cnt(f"{STATE}/soft-{state}.cnt", cnt)
    write_json(f"{STATE}/cooldown-{state}.json",
               {"until": now + 900, "reason": d.get("reason") or "soft-block",
                "needs_human": False, "tab": tab})
    if tab:
        old = read_json(f"{STATE}/tab-{state}.json", {})
        write_json(f"{STATE}/tab-{state}.json",
                   {"target_id": tab, "created": old.get("created") or now, "last_used": now})
    out = dict(base, soft_block=True, reason=d.get("reason"), tab=tab,
               cooldown_until=iso(now + 900))
    finish(0, attach_fallback(out, state, kw))

prods = d.get("products") or []

# 空结果：连续 2 次 → 写 300s 冷却（下一次调用被拒），本次仍如实输出
if not prods:
    cnt = read_cnt(f"{STATE}/empty-{state}.cnt") + 1
    out = dict(base)
    if cnt >= 2:
        write_json(f"{STATE}/cooldown-{state}.json",
                   {"until": now + 300, "reason": "empty twice", "needs_human": False, "tab": None})
        write_cnt(f"{STATE}/empty-{state}.cnt", 0)
        out["cooldown_until"] = iso(now + 300)
        out["note"] = "连续两次空结果，已写 300s 冷却（下一次同平台调用会被拒）"
    else:
        write_cnt(f"{STATE}/empty-{state}.cnt", cnt)
        out["empty_streak"] = cnt
    if tab:
        old = read_json(f"{STATE}/tab-{state}.json", {})
        write_json(f"{STATE}/tab-{state}.json",
                   {"target_id": tab, "created": old.get("created") or now, "last_used": now})
    finish(0, attach_fallback(out, state, kw))

# 成功：清计数/冷却，写缓存与标签记录
write_cnt(f"{STATE}/empty-{state}.cnt", 0)
write_cnt(f"{STATE}/soft-{state}.cnt", 0)
rm(f"{STATE}/cooldown-{state}.json")
out = dict(base, needs_human=False)
if tab:
    old = read_json(f"{STATE}/tab-{state}.json", {})
    write_json(f"{STATE}/tab-{state}.json",
               {"target_id": tab, "created": old.get("created") or now, "last_used": now})
    out["tab"] = tab
key = f"{token}|{kw}|{page}|{pages}|{sort}"
os.makedirs(f"{STATE}/cache", exist_ok=True)
with open(f"{STATE}/cache/{hashlib.sha1(key.encode()).hexdigest()}.json", "w") as f:
    json.dump(out, f, ensure_ascii=False)
finish(0, out)
PYEOF
}

# ── cloud 通道（host 侧 python3 + urllib；仅 taobao / xhs；输出 worker 风格 JSON） ──
cloud_search() {
  python3 - "$@" <<'PYEOF'
import datetime, json, sys, urllib.request

kw, page, sub, sort, proxy = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
TZ = datetime.timezone(datetime.timedelta(hours=8))

def out(products, error=None):
    print(json.dumps({
        "platform": f"cloud:{sub}", "keyword": kw,
        "retrieved_at": datetime.datetime.now(TZ).isoformat(timespec="seconds"),
        "login_state": "unknown",
        "price_note": "C级缓存价：价格非实时，时间未知，仅作线索与交叉验证",
        "products": products, "error": error
    }, ensure_ascii=False))
    sys.exit(0)

body = json.dumps({"keyword": kw, "platform": sub, "sort_by": sort,
                   "limit": 10, "page": page}).encode()
url = "https://api.shopmeagent.com/mcp/goods/search"

def try_req(opener):
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"})
    with opener.open(req, timeout=20) as r:
        return json.load(r)

data = None
errs = []
for opener in (urllib.request.build_opener(),
               urllib.request.build_opener(urllib.request.ProxyHandler(
                   {"http": proxy, "https": proxy}))):
    try:
        data = try_req(opener)
        break
    except Exception as e:
        errs.append(str(e)[:120])
if data is None:
    out([], error=f"cloud API unreachable (direct + mihomo tried): {'; '.join(errs)}")
if not data.get("success"):
    out([], error=f"cloud API error: {json.dumps(data)[:200]}")

products = []
for p in (data.get("products") or [])[:10]:
    products.append({
        "title": (p.get("original_name") or p.get("name") or "")[:80],
        "price": str(p.get("price") or ""),
        "sales": str(p.get("sales") or ""),
        "shop": p.get("shop_name") or "",
        "url": p.get("url") or "",
        "image": p.get("image") or "",
        "product_id": p.get("product_id") or "",
    })
out(products)
PYEOF
}

# ── 子命令：status / close / clear-cooldown ─────────────────────────────────
status_cmd() {
  python3 - "$@" <<'PYEOF'
import datetime, glob, json, os, sys, time

STATE = "/tmp/shop-search"
TZ = datetime.timezone(datetime.timedelta(hours=8))
now = time.time()
quotas = {}
for kv in (sys.argv[1] if len(sys.argv) > 1 else "").split(";"):
    if "=" in kv:
        quotas[kv.split("=", 1)[0]] = kv.split("=", 1)[1]

def iso(t=None):
    return datetime.datetime.fromtimestamp(t or now, TZ).isoformat(timespec="seconds")

def read_json(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d

try:
    lines = [l.split("\t") for l in open(f"{STATE}/calls.log") if l.strip()]
except Exception:
    lines = []

platforms = {}
for state in ["jd", "1688", "1688:desktop", "taobao", "tmall", "pdd", "cloud"]:
    mine = [l for l in lines if len(l) > 7 and l[1] == state]
    cd = read_json(f"{STATE}/cooldown-{state}.json", None)
    rec = read_json(f"{STATE}/tab-{state}.json", None)
    entry = {
        "quota": quotas.get(state, ""),
        "quota_used_hour": len([l for l in mine if now - float(l[0]) < 3600]),
        "quota_used_day": len([l for l in mine if now - float(l[0]) < 86400]),
        "cooldown_until": iso(float(cd["until"])) if cd and float(cd.get("until") or 0) > now else None,
        "cooldown_reason": cd.get("reason") if cd else None,
        "needs_human": any(x.get("platform") == state
                           for x in read_json(f"{STATE}/needs_human.json", [])),
        "last_call": iso(float(mine[-1][0])) if mine else None,
        "tab": (rec or {}).get("target_id"),
    }
    platforms[state] = entry

tabs = []
for f in sorted(glob.glob(f"{STATE}/tab-*.json")):
    rec = read_json(f, None)
    if rec and rec.get("target_id"):
        tabs.append({"platform": os.path.basename(f)[4:-5], "target_id": rec["target_id"],
                     "created": iso(float(rec.get("created") or 0)),
                     "last_used": iso(float(rec.get("last_used") or 0))})

disabled = None
df = f"{STATE}/disabled-1688-desktop.ts"
if os.path.exists(df) and now - os.path.getmtime(df) < 86400:
    disabled = iso(os.path.getmtime(df) + 86400)

print(json.dumps({"ts": iso(), "platforms": platforms,
                  "needs_human": read_json(f"{STATE}/needs_human.json", []),
                  "tabs": tabs, "disabled_1688_desktop": disabled}, ensure_ascii=False, indent=1))
PYEOF
}

close_cmd() {
  python3 - "$@" <<'PYEOF'
import datetime, glob, json, os, sys, time, urllib.request

STATE, CDP = "/tmp/shop-search", "http://172.19.0.2:9222"
target = sys.argv[1] if len(sys.argv) > 1 else "all"
now = time.time()
TZ = datetime.timezone(datetime.timedelta(hours=8))

def read_json(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d

protected = {x.get("tab") for x in read_json(f"{STATE}/needs_human.json", []) if x.get("tab")}
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with _opener.open(urllib.request.Request(CDP + "/json/list"), timeout=8) as r:
        page_ids = {t.get("id") for t in json.loads(r.read().decode()) if t.get("type") == "page"}
except Exception:
    page_ids = None

closed, kept = [], []
for f in sorted(glob.glob(f"{STATE}/tab-*.json")):
    plat = os.path.basename(f)[4:-5]
    if target != "all" and plat != target:
        continue
    rec = read_json(f, None)
    tid = (rec or {}).get("target_id")
    if tid in protected:
        kept.append({"platform": plat, "tab": tid, "reason": "needs_human，保留给用户处理"})
        continue
    if tid and (page_ids is None or tid in page_ids):
        try:
            _opener.open(urllib.request.Request(f"{CDP}/json/close/{tid}", method="DELETE"), timeout=8)
            closed.append(tid)
        except Exception:
            pass
    try:
        os.remove(f)
    except Exception:
        pass
for f in glob.glob(f"{STATE}/active-*.ts"):   # v1 遗留
    try:
        tid = open(f).read().strip().split(":")[0]
        if tid and tid not in protected:
            try:
                _opener.open(urllib.request.Request(f"{CDP}/json/close/{tid}", method="DELETE"), timeout=8)
                closed.append(tid)
            except Exception:
                pass
        os.remove(f)
    except Exception:
        pass
print(json.dumps({"closed": closed, "kept": kept}, ensure_ascii=False))
PYEOF
}

clear_cd() {
  python3 - "$@" <<'PYEOF'
import json, os, sys

STATE = "/tmp/shop-search"
state = sys.argv[1] if len(sys.argv) > 1 else ""
if not state:
    print(json.dumps({"error": "need platform"})); sys.exit(3)
for p in (f"{STATE}/cooldown-{state}.json", f"{STATE}/empty-{state}.cnt", f"{STATE}/soft-{state}.cnt"):
    try:
        os.remove(p)
    except Exception:
        pass
nh_path = f"{STATE}/needs_human.json"
try:
    nh = [x for x in json.load(open(nh_path)) if x.get("platform") != state]
    if nh:
        with open(nh_path, "w") as f:
            json.dump(nh, f, ensure_ascii=False)
    else:
        os.remove(nh_path)   # 清空即删文件
except Exception:
    pass
print(json.dumps({"cleared": state}, ensure_ascii=False))
PYEOF
}

# ── 主流程 ───────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; exit 0; fi

case "${1:-}" in
  close)       shift; close_cmd "${1:-all}"; exit 0 ;;
  status)      QUOTAS="jd=$(quota_for jd);1688=$(quota_for 1688);1688:desktop=$(quota_for 1688:desktop);taobao=$(quota_for taobao);tmall=$(quota_for tmall);pdd=$(quota_for pdd);cloud=$(quota_for cloud)"; status_cmd "$QUOTAS"; exit 0 ;;
  clear-cooldown) shift; [ $# -ge 1 ] || { echo "用法: shop-search.sh clear-cooldown <platform>" >&2; exit 3; }; clear_cd "$1"; exit 0 ;;
  offer)       shift; offer_cmd "${1:-}"; exit 0 ;;
esac

[ $# -ge 2 ] || { usage >&2; exit 3; }
PLATFORM="$1"
KEYWORD="$2"
shift 2
PAGE=1; PAGES=1; SCROLL=0; FRESH=0; WAIT_HUMAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pages)      PAGES="${2:-1}"; shift 2 ;;
    --scroll)     SCROLL="${2:-4}"; shift 2 ;;
    --fresh)      FRESH=1; shift ;;
    --wait-human) WAIT_HUMAN="${2:-0}"; shift 2 ;;
    --debug)      export SHOP_SEARCH_DEBUG=1; shift ;;
    [0-9]*)       PAGE="$1"; shift ;;
    *)            echo "未知参数: $1（见 shop-search.sh --help）" >&2; exit 3 ;;
  esac
done
case "$PAGES" in ''|*[!0-9]*) PAGES=1 ;; esac
case "$SCROLL" in ''|*[!0-9]*) SCROLL=0 ;; esac
case "$WAIT_HUMAN" in ''|*[!0-9]*) WAIT_HUMAN=0 ;; esac

# 平台归一化
CLOUD_SUB=""
# 1688 默认桌面版（2026-09-04：移动版 m.1688 滑块风控高发，不再作为默认通道；SHOP_1688_MOBILE=1 显式放行移动版）
if [ "$PLATFORM" = "1688" ] && [ "${SHOP_1688_MOBILE:-0}" != "1" ]; then
  PLATFORM="1688:desktop"
fi
STATE_KEY="$PLATFORM"
CACHE_TOKEN="$PLATFORM"
case "$PLATFORM" in
  cloud)            CLOUD_SUB="taobao"; STATE_KEY="cloud"; CACHE_TOKEN="cloud:taobao" ;;
  cloud:taobao|cloud:xhs) CLOUD_SUB="${PLATFORM#cloud:}"; STATE_KEY="cloud"; CACHE_TOKEN="$PLATFORM" ;;
  cloud:*)          echo "{\"error\":\"unsupported cloud platform: $PLATFORM（上游仅支持 taobao/xhs，tmall 已移除）\"}" >&2; exit 3 ;;
  jd|taobao|tmall|pdd|1688|1688:desktop) ;;
  douyin)
    echo '{"platform":"douyin","keyword":"'"$KEYWORD"'","login_state":"n/a","products":[],"error":"unsupported: 抖音桌面版无商品搜索，请改用 cloud 或 MediaCrawler"}'
    exit 0 ;;
  *) echo "未知平台: $PLATFORM（支持 1688|1688:desktop|jd|taobao|tmall|pdd|douyin|cloud[:taobao|xhs]）" >&2; exit 3 ;;
esac

# gate：缓存 / 冷却 / 禁用 / 配额 / 标签清扫
GATE_OUT="$(gate "$STATE_KEY" "$CACHE_TOKEN" "$KEYWORD" "$PAGE" "$PAGES" "${SHOP_CLOUD_SORT:-relevance}" "$FRESH")" || {
  echo "{\"error\":\"gate failure\"}" >&2; exit 4; }
ACTION="${GATE_OUT%%$'\n'*}"
REST="${GATE_OUT#*$'\n'}"
case "$ACTION" in
  cache|cooldown|disabled|rate|quota)
    printf '%s\n' "$REST"
    case "$ACTION" in
      cache) exit 0 ;;
      rate)  exit 2 ;;
      *)     exit 5 ;;
    esac ;;
  proceed) TAB_ID="$REST" ;;
  *) echo "{\"error\":\"gate unknown action: $ACTION\"}" >&2; exit 4 ;;
esac

WORKER_OUT="$STATE_DIR/.worker.$$.json"
START_TS=$(date +%s)
rm -f "$WORKER_OUT"

if [ "$STATE_KEY" = "cloud" ]; then
  # cloud 通道：host 侧 API（免 Key）
  cloud_search "$KEYWORD" "$PAGE" "$CLOUD_SUB" "${SHOP_CLOUD_SORT:-relevance}" "$MIHOMO_HOST" > "$WORKER_OUT"
elif [ -n "${SHOP_SEARCH_FAKE_RESULT:-}" ] && [ -f "${SHOP_SEARCH_FAKE_RESULT}" ]; then
  # 测试通道：假 worker 输出（仍走 post 的缓存/冷却/日志逻辑）
  cat "${SHOP_SEARCH_FAKE_RESULT}" > "$WORKER_OUT"
else
  # CDP 串行锁：与 fetch-url/x-search/mc-crawl 共用 /tmp/cdp.lock（等待上限 240s）
  if command -v flock >/dev/null 2>&1; then FLOCK="flock -w 240 /tmp/cdp.lock"; else FLOCK=""; fi

  # CDP 通道：docker 一次性容器运行 worker（优先预构建镜像，省每次 pip install）
  WARGS=(/w.py "$PLATFORM" "$KEYWORD" "$PAGE")
  [ "$PAGES" -gt 1 ] && WARGS+=(--pages "$PAGES")
  [ "$SCROLL" -gt 0 ] && WARGS+=(--scroll "$SCROLL")
  [ "$WAIT_HUMAN" -gt 0 ] && WARGS+=(--wait-human "$WAIT_HUMAN")
  [ "$TAB_ID" != "null" ] && [ -n "$TAB_ID" ] && WARGS+=(--tab "$TAB_ID")
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    $FLOCK timeout 300 docker run --rm --network ai-browser \
      -v "$WORKER:/w.py:ro" \
      -e "SHOP_SEARCH_DEBUG=${SHOP_SEARCH_DEBUG:-0}" \
      "$IMAGE" timeout 280 python "${WARGS[@]}" > "$WORKER_OUT"
  else
    $FLOCK timeout 300 docker run --rm --network ai-browser \
      -v "$WORKER:/w.py:ro" \
      -e "SHOP_SEARCH_DEBUG=${SHOP_SEARCH_DEBUG:-0}" \
      "$FALLBACK_IMAGE" sh -c 'pip install -q websockets >/dev/null 2>&1 && exec timeout 280 python "$@"' _ "${WARGS[@]}" > "$WORKER_OUT"
  fi
fi

ELAPSED=$(( $(date +%s) - START_TS ))
if [ ! -s "$WORKER_OUT" ]; then
  rm -f "$WORKER_OUT"
  echo "{\"platform\":\"$PLATFORM\",\"keyword\":\"$KEYWORD\",\"login_state\":\"unknown\",\"products\":[],\"channel\":\"unknown\",\"evidence\":\"unknown\",\"elapsed_s\":$ELAPSED,\"error\":\"infra: worker produced no output (docker/CDP failure)\"}"
  exit 4
fi

POST_OUT="$(post "$WORKER_OUT" "$CACHE_TOKEN" "$STATE_KEY" "$KEYWORD" "$PAGE" "$PAGES" "${SHOP_CLOUD_SORT:-relevance}" "$ELAPSED")" || POST_OUT=""
rm -f "$WORKER_OUT"
if [ -z "$POST_OUT" ]; then
  echo "{\"platform\":\"$PLATFORM\",\"keyword\":\"$KEYWORD\",\"login_state\":\"unknown\",\"products\":[],\"channel\":\"unknown\",\"evidence\":\"unknown\",\"elapsed_s\":$ELAPSED,\"error\":\"infra: post-process failure\"}"
  exit 4
fi
EXIT_CODE="${POST_OUT%%$'\n'*}"
JSON_OUT="${POST_OUT#*$'\n'}"
printf '%s\n' "$JSON_OUT"
# 证据账本：真实结果与 FAKE 结果均写（缓存命中不写——gate 在 cache 分支已直接输出并退出）
case "$EXIT_CODE" in
  0) LEDGER_TMP=$(mktemp /tmp/shop-search/.ledger.XXXXXX.json); printf '%s\n' "$JSON_OUT" > "$LEDGER_TMP"; ledger_write "$LEDGER_TMP"; rm -f "$LEDGER_TMP" ;;
esac
case "$EXIT_CODE" in
  0|2|3|4|5) exit "$EXIT_CODE" ;;
  *) exit 0 ;;
esac
