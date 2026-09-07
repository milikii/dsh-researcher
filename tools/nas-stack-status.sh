#!/usr/bin/env bash
# nas-stack-status — NAS 研究栈实时状态（JSON / --markdown）
# 键：ts · containers · chromium_tabs · cdp{browser,chromium_ip,identity_ok} · keepalive · searxng ·
#     shop_search · mediacrawler · obscura_running · dsh_web · ledger · errors[]
# 任何子项失败只置 null 并在 errors[] 记一条；脚本本身永不非零退出；25 秒内完成。
set -u

MARKDOWN=0
[ "${1:-}" = "--markdown" ] && MARKDOWN=1

python3 - "$MARKDOWN" <<'PYEOF'
import datetime, json, os, subprocess, sys, time, urllib.request

TZ = datetime.timezone(datetime.timedelta(hours=8))
now = time.time()
markdown = sys.argv[1] == "1"

def sh(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def http_json(url, timeout=8):
    try:
        with _opener.open(url, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None

out = {"ts": datetime.datetime.fromtimestamp(now, TZ).isoformat(timespec="seconds")}
errors = []

# containers
cont = {}
for c in ["chromium", "searxng", "mediacrawler", "obscura", "mihomo"]:
    st = sh(f"docker inspect -f '{{{{.State.Status}}}}' {c}")
    cont[c] = st if st else "not-found"
out["containers"] = cont
if any(v == "not-found" for v in cont.values()):
    errors.append("container inspect failed: " + ",".join(k for k, v in cont.items() if v == "not-found"))

# chromium tabs
tabs = http_json("http://172.19.0.2:9222/json/list")
out["chromium_tabs"] = (len([t for t in tabs if t.get("type") == "page"])
                        if isinstance(tabs, list) else None)
if out["chromium_tabs"] is None:
    errors.append("chromium /json/list unreachable")

# CDP identity（2026-09-06 事故：chromium 退出后其固定 IP 172.19.0.2 被未指定 IP 的 mediacrawler 抢占，
# CDP「连得上」但连到了错误的浏览器，全栈工具静默指错 12 小时。这里校验两件事：
#   1) 172.19.0.2 是否确实归 chromium 容器所有；2) 网络端点与容器内端点报告的 Browser 是否一致。
ver = http_json("http://172.19.0.2:9222/json/version")
browser = ver.get("Browser") if isinstance(ver, dict) else None
owner_ip = sh('docker inspect -f \'{{index .NetworkSettings.Networks "ai-browser" "IPAddress"}}\' chromium')
inner = sh("docker exec chromium curl -fsS --max-time 5 http://127.0.0.1:9222/json/version", timeout=10)
try:
    inner_browser = json.loads(inner).get("Browser") if inner else None
except Exception:
    inner_browser = None
identity_ok = None
if browser is not None:
    if owner_ip != "172.19.0.2":
        identity_ok = False
        errors.append(f"cdp identity mismatch: 172.19.0.2 not owned by chromium (chromium ip={owner_ip or 'n/a'}, endpoint reports {browser})")
    elif inner_browser and inner_browser != browser:
        identity_ok = False
        errors.append(f"cdp identity mismatch: network endpoint={browser} vs in-container={inner_browser}")
    else:
        identity_ok = True
out["cdp"] = {"browser": browser, "chromium_ip": owner_ip, "identity_ok": identity_ok}

# keepalive
ka = None
try:
    ka = json.load(open("/root/01/keepalive/status.json"))
    last = ka.get("last_run")
    age = None
    if last:
        t = datetime.datetime.strptime(last, "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ).timestamp()
        age = round((now - t) / 3600, 1)
    ka = {"last_run": last, "age_hours": age,
          "logged_in": ka.get("logged_in"), "logged_out": ka.get("logged_out")}
except Exception as e:
    errors.append(f"keepalive status.json: {str(e)[:80]}")
out["keepalive"] = ka

# searxng: suspended from logs, responsive from a probe
suspended = []
logs = sh("docker logs searxng --since 20m 2>&1 | grep -iE 'Suspended|CAPTCHA' | head -20", timeout=10)
if logs is not None:
    for line in logs.splitlines():
        for name in ("bing", "baidu", "sogou", "brave", "duckduckgo", "google", "startpage", " qwant"):
            if name in line.lower() and name.strip() not in suspended:
                suspended.append(name.strip())
probe = http_json("http://127.0.0.1:8080/search?q=nas+status+probe&format=json", timeout=15)
responsive, unresponsive = [], []
if isinstance(probe, dict):
    for r in (probe.get("results") or [])[:20]:
        for e in (r.get("engines") or []):
            name = e.split()[0] if isinstance(e, str) else str(e)
            if name not in responsive:
                responsive.append(name)
    all_eng = ["bing", "baidu", "sogou", "brave", "duckduckgo", "google", "startpage"]
    unresponsive = [e for e in all_eng if e not in responsive]
    out["searxng"] = {"suspended": suspended, "responsive": responsive, "unresponsive": unresponsive}
else:
    out["searxng"] = None
    errors.append("searxng probe failed (127.0.0.1:8080)")

# shop_search status（原样嵌入）
ss = sh("/root/.dsh/tools/shop-search.sh status", timeout=15)
if ss:
    try:
        out["shop_search"] = json.loads(ss)
    except Exception:
        out["shop_search"] = ss
else:
    out["shop_search"] = None
    errors.append("shop-search.sh status failed")

# mediacrawler
mc = http_json("http://192.168.1.220:8088/api/health")
mcs = http_json("http://192.168.1.220:8088/api/crawler/status")
out["mediacrawler"] = {"health": mc, "crawler": mcs}
if mc is None and mcs is None:
    errors.append("mediacrawler api unreachable")

# obscura
out["obscura_running"] = (cont.get("obscura") == "running")

# dsh_web
active = sh("systemctl show dsh-web -p ActiveEnterTimestamp --value")
copy = "/root/.dsh/profiles/web/node_modules/@dsh-local/web-search-searxng/lib/index.js"
mtime = sh(f"stat -c %Y {copy}")
restart_pending = None
if active and mtime and mtime.isdigit():
    t = sh("date -d '" + active + "' +%s")
    if t and t.isdigit():
        restart_pending = int(mtime) > int(t)
out["dsh_web"] = {"active_since": active, "provider_copy_mtime": mtime,
                  "restart_pending": restart_pending}
if restart_pending is None:
    errors.append("dsh_web active_since/mtime parse failed")

# ledger
if os.path.exists("/root/01/ledger/ledger"):
    ls_ = sh("/root/01/ledger/ledger stats", timeout=10)
    out["ledger"] = ls_
else:
    out["ledger"] = None

out["errors"] = errors
print(json.dumps(out, ensure_ascii=False, indent=1 if not markdown else None))

if markdown:
    print()
    print("## NAS Stack Status —", out["ts"], "(+08:00)")
    print()
    print("| 项 | 状态 |")
    print("|---|---|")
    print("| containers | " + " · ".join(f"{k}={v}" for k, v in cont.items()) + " |")
    print(f"| chromium_tabs | {out['chromium_tabs']} |")
    if out.get("cdp"):
        c = out["cdp"]
        print(f"| cdp | browser={c.get('browser')} chromium_ip={c.get('chromium_ip')} identity_ok={c.get('identity_ok')} |")
    if ka:
        print(f"| keepalive | last_run={ka.get('last_run')} age={ka.get('age_hours')}h "
              f"logged_in={','.join(ka.get('logged_in') or []) or '-'} logged_out={','.join(ka.get('logged_out') or []) or '-'} |")
    if out.get("searxng"):
        s = out["searxng"]
        print(f"| searxng | responsive={','.join(s['responsive']) or '-'} suspended={','.join(s['suspended']) or '-'} unresponsive={','.join(s['unresponsive']) or '-'} |")
    print(f"| obscura_running | {out['obscura_running']} |")
    if out.get("dsh_web"):
        d = out["dsh_web"]
        print(f"| dsh_web | active_since={d.get('active_since')} restart_pending={d.get('restart_pending')} |")
    if isinstance(out.get("shop_search"), dict):
        for p, v in out["shop_search"].get("platforms", {}).items():
            flags = []
            if v.get("needs_human"):
                flags.append("needs_human")
            if v.get("cooldown_until"):
                flags.append(f"cooldown→{v['cooldown_until']}")
            if v.get("quota_used_hour"):
                flags.append(f"quota {v['quota_used_hour']}h/{v['quota_used_day']}d")
            if flags or v.get("last_call"):
                print(f"| shop:{p} | {'; '.join(flags) or 'ok'} last={v.get('last_call')} |")
        nh = out["shop_search"].get("needs_human") or []
        if nh:
            for x in nh:
                print(f"| needs_human | {x.get('platform')} tab={str(x.get('tab'))[:12]} since={x.get('since')} reason={x.get('reason')} |")
    if out.get("errors"):
        print("| errors | " + "; ".join(out["errors"]) + " |")
PYEOF
exit 0
