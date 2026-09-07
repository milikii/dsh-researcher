#!/usr/bin/env bash
# cdp-solve.sh — Chromium 人机验证自助接管工具（临时操控浏览器完成滑块/点选验证）
#
# 用法:
#   cdp-solve.sh list                                  # 列出标签页（找 needs_human 的 tab）
#   cdp-solve.sh open <url>                            # 新建标签（返回 tab id，用完 close）
#   cdp-solve.sh close <targetId>                      # 关标签（只关自己 open 的或已处理完的 needs_human 标签）
#   cdp-solve.sh eval <targetId> '<js>'                # 在标签里执行 JS（检测验证状态/取元素坐标）
#   cdp-solve.sh shot <targetId> [name]                # 截图 → /tmp/cdp-solve/<name>.png（read_image 查看）
#   cdp-solve.sh click <targetId> <x> <y>              # 点击（css 坐标 = 截图像素坐标 / scale）
#   cdp-solve.sh drag <targetId> <x1> <y1> <x2> <y2> [steps] [--touch]
#                                                      # 人类化轨迹拖动（滑块）
#   cdp-solve.sh slider <targetId>                     # 自动检测滑块并尝试拖动（鼠标+触摸，best-effort）
#   cdp-solve.sh wait <targetId> [timeout_s]           # 等验证页消失/跳回目标页（默认 20s）
#
# 纪律（技能层强制，见 nas-core §4 / nas-shop §1.1）:
#   - 本工具自动持 /tmp/cdp.lock（与 shop-search/fetch-url/x-search/mc-crawl 互斥，等待上限 240s）
#   - 只操作 needs_human 保留标签或本工具 open 的标签；绝不碰用户其他标签
#   - 每轮验证自助上限 3 次尝试/3 分钟；点选文字/短信/扫码/登录类验证不自助，直接交用户
#   - stdout 一行 JSON；退出码 0=操作完成（成败看 JSON）· 3=参数错 · 4=基础设施故障
set -euo pipefail

IMAGE="dsh-cdp-keepalive:latest"
FALLBACK_IMAGE="python:3.12-alpine"
WORKER="${CDP_SOLVE_WORKER:-/root/.dsh/tools/cdp-solve.py}"
OUT_DIR="/tmp/cdp-solve"
mkdir -p "$OUT_DIR"

if [ $# -lt 1 ]; then
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 3
fi

# CDP 串行锁：与 shop-search / fetch-url / x-search / mc-crawl 共用（等待上限 240s）
if command -v flock >/dev/null 2>&1; then FLOCK="flock -w 240 /tmp/cdp.lock"; else FLOCK=""; fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  $FLOCK timeout 300 docker run --rm --network ai-browser \
    -v "$WORKER:/w.py:ro" -v "$OUT_DIR:/out" \
    -e "CDP_SOLVE_DEBUG=${CDP_SOLVE_DEBUG:-0}" \
    "$IMAGE" timeout 280 python /w.py "$@"
else
  $FLOCK timeout 300 docker run --rm --network ai-browser \
    -v "$WORKER:/w.py:ro" -v "$OUT_DIR:/out" \
    -e "CDP_SOLVE_DEBUG=${CDP_SOLVE_DEBUG:-0}" \
    "$FALLBACK_IMAGE" sh -c 'pip install -q websockets >/dev/null 2>&1 && exec timeout 280 python "$@"' _ "$@"
fi
