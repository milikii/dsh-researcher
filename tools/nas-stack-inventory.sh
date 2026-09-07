#!/usr/bin/env bash
# nas-stack-inventory — NAS Researcher 全套组件体检/位置清单
# 用法: bash /root/.dsh/tools/nas-stack-inventory.sh
set -u

check_path() { [ -e "$1" ] && echo "  存在" || echo "  缺失!"; }
check_port() { curl -sk --max-time 5 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null || echo "不通"; }

echo "=================================================="
echo " NAS Researcher 组件清单（存放位置 / 运行位置 / 状态）"
echo " 时间: $(date '+%F %T')"
echo "=================================================="

echo
echo "## 1. Docker 运行组件"
for c in chromium chromium-cdp-proxy mediacrawler mediacrawler-cdp-bridge searxng; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "无容器")
  lim=$(docker inspect -f 'cpu={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}}' "$c" 2>/dev/null || true)
  echo "  [$c] $st  $lim"
done

echo
echo "## 2. 部署目录（Docker compose 与数据）"
for d in /home/docker/chromium /home/docker/searxng /home/docker/mediacrawler; do
  echo "  $d:"; check_path "$d"
  ls "$d" 2>/dev/null | sed 's/^/    /' | head -6
done

echo
echo "## 3. 工具脚本与可执行文件"
for f in /usr/local/bin/fetch-url /usr/local/bin/fetch-url.v2 /usr/local/bin/agent-reach /usr/bin/mcporter \
         /root/.dsh/tools/cdp_read.py /root/.dsh/tools/mc-crawl.sh /root/.dsh/tools/fetch-url-tests.sh; do
  printf "  %-45s" "$f"; check_path "$f"
done

echo
echo "## 4. DSH 技能与 Preset"
for f in /root/.dsh/skills/nas-search/SKILL.md /root/.dsh/.agent-presets/nas-researcher/agent.cordis.yml \
         /root/.dsh/.agent-presets/nas-researcher/preset.yml /root/.mcporter/mcporter.json; do
  printf "  %-50s" "$f"; check_path "$f"
done

echo
echo "## 5. 关键端口/端点"
printf "  %-40s" "SearXNG API 127.0.0.1:8080:";        echo "$(check_port 'http://127.0.0.1:8080/search?q=ping&format=json')"
printf "  %-40s" "MediaCrawler API 192.168.1.220:8088:"; echo "$(check_port 'http://192.168.1.220:8088/api/health')"
printf "  %-40s" "Chromium CDP 172.19.0.2:9222:";        echo "$(check_port 'http://172.19.0.2:9222/json/version')"
printf "  %-40s" "Chromium WebUI 192.168.1.220:3001:";   echo "$(check_port 'https://192.168.1.220:3001/')"

echo
echo "## 6. Chromium 资源配额（当前值）"
docker inspect chromium --format '  cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}} shm={{.HostConfig.ShmSize}}' 2>/dev/null
docker exec chromium ls /dev/dri >/dev/null 2>&1 && echo "  /dev/dri 直通: 在" || echo "  /dev/dri 直通: 不在"
docker logs chromium 2>&1 | grep -m1 "Starting mode" | grep -q websockets && echo "  selkies 模式: websockets" || echo "  selkies 模式: 需查日志"

echo
echo "## 7. 文档"
[ -d /root/01/docs/nas-researcher ] && echo "  Obsidian Vault: /root/01/docs/nas-researcher/（$(ls /root/01/docs/nas-researcher/*.md 2>/dev/null | wc -l) 个笔记）" || echo "  Obsidian Vault: 缺失!"

echo
echo "=================================================="