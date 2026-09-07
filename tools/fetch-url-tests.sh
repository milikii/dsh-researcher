#!/usr/bin/env bash
# fetch-url v3 自动化测试套件
# 覆盖：本地提取 / PDF / 视频提示 / 知乎默认与 CDP / --render / 失败清理 /
#       --no-cdp / --deep 元数据 / 批量 / 向后兼容 / CDP 临时 tab 清理不变量
set -u
PF=/tmp/fut-pass-count; FF=/tmp/fut-fail-count
rm -f "$PF" "$FF"
ZHIHU="https://www.zhihu.com/question/519600042"
BILI="https://www.bilibili.com/video/BV1BuhG6CEjD/"
PDFURL="https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"
WIKI="https://en.wikipedia.org/wiki/DeepSeek"
DEAD="http://10.99.99.99/dead"

tabs_count() {
  curl -s --noproxy '*' --max-time 8 http://172.19.0.2:9222/json/list | python3 -c \
    "import json,sys; ts=json.load(sys.stdin); print(len([t for t in ts if t.get('type')=='page']))" 2>/dev/null
}
tabs_ok() { [ "$(tabs_count)" = "$BASE_TABS" ]; }

get() {
  python3 -c "
import json,sys
d=json.load(sys.stdin)
k='$1'
v=d.get(k,'')
print(v if isinstance(v,(str,int,float,bool)) else json.dumps(v,ensure_ascii=False))
"
}
check() {
  local name="$1"; shift
  if "$@"; then echo "PASS: $name"; echo x >> "$PF"; else echo "FAIL: $name"; echo x >> "$FF"; fi
}
eq() { [ "$(cat)" = "$1" ]; }
neq() { [ "$(cat)" != "$1" ]; }
contains() { grep -q -- "$1"; }
num_gt() { [ "$(cat | tr -d ' \n')" -gt "$1" ]; }
num_eq() { [ "$(cat | tr -d ' \n')" = "$1" ]; }
matches() { grep -qE -- "$1"; }
not_cdp() { ! grep -qE '^(cdp|cdp-render)$'; }

BASE_TABS=$(tabs_count)
echo "基线 tab 数: $BASE_TABS ($(date +%T))"

# T1 富文本静态页 → 本地提取（trafilatura/readability），不碰 CDP
T1=$(fetch-url "$WIKI")
echo "$T1" | get method | check "T1.1 wiki 走本地 http 通道" eq http
echo "$T1" | get title | check "T1.2 wiki 标题含 DeepSeek" contains DeepSeek
echo "$T1" | get content_chars | check "T1.3 wiki 正文 > 5000 字" num_gt 5000
echo "$T1" | get quality_score | check "T1.4 质量评分为 0~1 小数" matches '^0\.[0-9]+$'

# T2 PDF → pdftotext
T2=$(fetch-url "$PDFURL")
echo "$T2" | get method | check "T2.1 PDF 走 pdf 通道" eq pdf
echo "$T2" | get content | check "T2.2 PDF 正文提取成功" contains "Dummy PDF"

# T3 视频页默认提示专用工具（不耗 Chromium）
T3=$(fetch-url "$BILI")
echo "$T3" | get method | check "T3.1 视频页默认 hint" eq hint
echo "$T3" | get content | check "T3.2 提示指向专用工具" contains "MediaCrawler"
check "T3.3 视频页未开 Chromium tab" tabs_ok

# T4 知乎默认路由：本地(403)→Jina→CDP，最终读到正文
T4=$(fetch-url "$ZHIHU")
T4M=$(echo "$T4" | get method)
check "T4.1 知乎默认路由返回非 none" bash -c '[ -n "$1" ] && [ "$1" != "none" ]' _ "$T4M"
echo "$T4" | get content_chars | check "T4.2 知乎正文 > 100 字" num_gt 100
echo "$T4" | get title | check "T4.3 知乎标题含「知乎」" contains 知乎
check "T4.4 读取后临时 tab 已清理" tabs_ok

# T5 --cdp-first 强制 CDP
T5=$(fetch-url "$ZHIHU" --cdp-first)
echo "$T5" | get method | check "T5.1 cdp-first 走 cdp" eq cdp
check "T5.2 cdp-first 后 tab 清理" tabs_ok

# T6 --render 强制 Chromium 渲染读取
T6=$(fetch-url "$BILI" --render)
echo "$T6" | get method | check "T6.1 render 走 cdp-render" eq cdp-render
echo "$T6" | get title | check "T6.2 render 拿到真实标题" matches '.{8,}'
check "T6.3 render 后 tab 清理" tabs_ok

# T7 异常/死地址：干净失败 + 临时 tab 仍关闭
fetch-url "$DEAD" --cdp-first > /tmp/fut7.json 2>&1
T7_EXIT=$?
check "T7.1 死地址返回非零退出码" bash -c '[ "$1" != "0" ]' _ "$T7_EXIT"
get method < /tmp/fut7.json | check "T7.2 死地址 method=none" eq none
get tried_methods < /tmp/fut7.json | check "T7.3 记录了尝试过的通道" contains cdp
check "T7.4 失败后临时 tab 仍关闭" tabs_ok

# T8 --no-cdp：绝不使用 Chromium
T8=$(fetch-url "$ZHIHU" --no-cdp)
echo "$T8" | get method | check "T8.1 no-cdp 不使用 cdp 通道" not_cdp
check "T8.2 no-cdp 期间无新 tab" tabs_ok

# T9 --deep 元数据完整性
T9=$(fetch-url "$ZHIHU" --deep)
echo "$T9" | get quality_score | check "T9.1 deep 有质量评分" matches '^0\.[0-9]+$'
echo "$T9" | get content_chars | check "T9.2 deep 有 content_chars" num_gt 0
echo "$T9" | get retrieved_at | check "T9.3 deep 有 retrieved_at" matches '^20[0-9]{2}-'
echo "$T9" | get tried_methods | check "T9.4 deep 记录 tried_methods" matches '^\[.+\]$'
echo "$T9" | get login_state | check "T9.5 deep 记录 login_state" matches '^(True|False)$'

# T10 批量模式（并发上限、manifest、md 文件）
cat > /tmp/fut-urls.txt <<EOF
# 批量测试
$WIKI
$PDFURL
$DEAD
EOF
TB=$(fetch-url --batch /tmp/fut-urls.txt --out-dir /tmp/fut-out)
echo "$TB" | get total | check "T10.1 批量总数=3" num_eq 3
echo "$TB" | get ok | check "T10.2 批量 2 成功 1 失败" num_eq 2
check "T10.3 manifest.json 生成" bash -c '[ -f /tmp/fut-out/manifest.json ]'
check "T10.4 3 个 .md 文件" bash -c '[ "$(ls /tmp/fut-out/*.md | wc -l)" = "3" ]'
check "T10.5 批量后 tab 清理" tabs_ok

# T11 向后兼容：body 字段存在且与 content 一致
echo "$T4" | python3 -c "
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if ('body' in d and 'content' in d and d['body']==d['content']) else 1)
"
T11_EXIT=$?
check "T11 body 字段向后兼容" bash -c '[ "$1" = "0" ]' _ "$T11_EXIT"

# T12 全程 tab 清理不变量
END_TABS=$(tabs_count)
check "T12 全测试后 tab 数不变（$BASE_TABS → $END_TABS）" bash -c '[ "$1" = "$2" ]' _ "$BASE_TABS" "$END_TABS"

# T13 SERP 拒绝：搜索引擎结果页零网络请求直接 hint（耗时 < 3 秒，tab 数不变）
T13_START=$(date +%s%N)
T13=$(fetch-url "https://www.google.com/search?q=test")
T13_ELAPSED_MS=$(( ($(date +%s%N) - T13_START) / 1000000 ))
echo "$T13" | get method | check "T13.1 SERP 命中 hint" eq hint
check "T13.2 SERP hint 耗时 < 3 秒" bash -c '[ "$1" -lt 3000 ]' _ "$T13_ELAPSED_MS"
check "T13.3 SERP 未开 Chromium tab" tabs_ok

# T14 404 终态：HTTP 404 直接结束不再级联（zhihu 该路径现回 200/403，改用 example.com 稳定 404，
#      语义不变：method=none、tried_methods 恰为 ["http"]）
T14=$(fetch-url "https://example.com/this-page-does-not-exist-404" 2>/dev/null || true)
echo "$T14" | get method | check "T14.1 404 终态 method=none" eq none
echo "$T14" | get tried_methods | check "T14.2 404 终态只试 http" eq '["http"]'

# T15 全局时间预算：--budget 20 限制总耗时 < 45 秒，输出带 elapsed_s
T15_START=$(date +%s)
T15=$(fetch-url "$DEAD" --cdp-first --budget 20 2>/dev/null || true)
T15_TOTAL=$(( $(date +%s) - T15_START ))
echo "$T15" | get elapsed_s | check "T15.1 elapsed_s 字段存在" matches '^[0-9]+(\.[0-9]+)?$'
check "T15.2 预算 20s 总耗时 < 45 秒" bash -c '[ "$1" -lt 45 ]' _ "$T15_TOTAL"

# T16 Obscura：cosdna（CF 盾）走本地隐身引擎；容器没跑则打印 SKIP
if docker inspect -f '{{.State.Running}}' obscura 2>/dev/null | grep -q true; then
  T16=$(fetch-url "https://www.cosdna.com/chs/" --no-cdp 2>/dev/null || true)
  echo "$T16" | get method | check "T16.1 cosdna 走 obscura" eq obscura
  echo "$T16" | get content_chars | check "T16.2 cosdna 正文 > 5000 字" num_gt 5000
else
  echo "SKIP: T16 Obscura 容器未运行"
fi

# T17 中文挑战页判定：importlib 加载 /usr/local/bin/fetch-url 为模块，
#       quality_score('...安全验证...'*100, 't', 'obscura') 应 < 0.35
python3 - <<'EOF'
import importlib.machinery
import importlib.util
loader = importlib.machinery.SourceFileLoader("fetch_url_mod", "/usr/local/bin/fetch-url")
spec = importlib.util.spec_from_loader("fetch_url_mod", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
score = mod.quality_score("...安全验证..." * 100, "t", "obscura")
assert score < 0.35, score
EOF
T17_EXIT=$?
check "T17 中文挑战页判定 < 0.35" bash -c '[ "$1" = "0" ]' _ "$T17_EXIT"

echo
PASSN=$([ -f "$PF" ] && wc -l < "$PF" || echo 0)
FAILN=$([ -f "$FF" ] && wc -l < "$FF" || echo 0)
echo "结果: PASS=$PASSN FAIL=$FAILN  (基线 tab=$BASE_TABS, 结束 tab=$END_TABS, $(date +%T))"
[ "$FAILN" = "0" ]
