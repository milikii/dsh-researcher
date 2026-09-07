# 浏览器层与爬虫项目（搜索栈的第 3-5 层）

搜索预设（searxng/exa）只是研究栈的**第一层**。当关键词搜索不够——需要登录态内容、动态渲染页、批量采集时，栈往下走：

```
L1  web_search        → SearXNG 聚合（主）/ Exa（备）          ← docs/searxng-preset.md
L2  平台专用搜索工具   → shop-search / x-search（登录态定向搜）
L3  URL 读取层        → fetch-url（http → cdp 自动降级）
L4  登录态深度读取    → Chromium CDP（真实浏览器、真实登录态）
L5  批量采集          → MediaCrawler（经 mc-crawl.sh 统一启动）
```

核心原则（`skills/nas-core`）：**Chromium 是"登录态网页深度读取器"，不是搜索引擎——搜索第一入口永远是 web_search。**

---

## 1. 浏览器层：Docker Chromium + CDP（`deploy/chromium-docker-compose.yml`）

### 部署要点（全部有实测教训）

| 设计 | 原因 |
|---|---|
| `lscr.io/linuxserver/chromium` + `/config` 持久化 | **登录态（Cookie/LocalStorage）持久保存在 NAS**，不是一次性无头浏览器——风控表现等同真人长驻浏览器 |
| 核显直通 `/dev/dri` + VAAPI | UHD 630 硬解硬编，Web UI（3001 端口）不占 CPU |
| `--proxy-server=http://172.28.0.10:7890` + `--proxy-bypass-list`（私网段/`<local>`） | 境外站走 mihomo 分流；**Chromium 默认只 bypass loopback，内网地址会全被丢进代理 502**（实测 7576 端口经代理 5s 超时 vs 直连 3.7ms）——必须显式列出私网段 |
| 固定 IP `172.19.0.2`（ai-browser 网络） | **全栈 CDP 工具地址写死**；2026-09-06 chromium 静默退出（exit 128 未被拉起）12 小时期间，该 IP 被未固定 IP 的 mediacrawler 抢占，CDP 工具全连到错的容器 |
| healthcheck 探 CDP `/json/version` | 上述静默停机事件的直接修复——`docker ps` 可见健康度 |
| **socat 伴生容器 `chromium-cdp-proxy`** | Chrome 136+ 安全变更：CDP 强制绑定 127.0.0.1，`--remote-debugging-address=0.0.0.0` 被忽略（docker-chromium#71）。伴生容器共享网络命名空间，`bind=172.19.0.2:9222` 转发到 `127.0.0.1:9222`——**CDP 仅 Docker 网络内可达，不发布宿主机端口** |
| 4 核 / 6G（2026-08-26 调整） | 配合核显直通解决 Web UI 卡顿 |

### 接入纪律（来自 `nas-core`，全是踩坑总结）

- **CDP 必须 IP 直连** `http://172.19.0.2:9222`——Chrome 拒绝非 IP 的 Host 头
- **手工 curl 到 `172.19.0.x` / `192.168.1.220:<port>`（8088/3001）必须前置 `no_proxy='*'`**，否则被 mihomo 折返 502/空响应；`127.0.0.1:8080`（SearXNG）不受影响
- **CDP 串行锁**：所有驱动 Chromium 的工具共用 `/tmp/cdp.lock`（flock 独占、等待上限 240s）——fetch-url 的 cdp 通道、shop-search、x-search、mc-crawl 启动都要拿锁；**mc-crawl 只有启动动作持锁**（600s 采集期持锁会饿死其他工具）
- **标签页纪律**：shop-search 复用购物标签（TTL 5min、上限 2、`close all` 清理）；绝不碰用户其他标签

### 工具（`tools/`）

| 工具 | 职责 |
|---|---|
| `cdp_read.py` | 网页深度读取（CDP 渲染后取正文） |
| `cdp-solve.sh/.py` | **人机验证自助接管**：list/open/close/eval/shot/click/drag/slider/wait，自动持 CDP 锁，截图落 `/tmp/cdp-solve/`（css 坐标 = 截图像素/scale）。协议：每轮 ≤3 次尝试/3 分钟；**只做滑块/点选类**，短信/扫码/登录类直接交真人；滑块/验证页**禁止**临时手写 CDP/Playwright 脚本 |
| `x-search.sh` | X/Twitter 登录态搜索 |
| `nas-stack-status.sh` / `nas-stack-inventory.sh` | 栈健康巡检 / 组件清单 |

---

## 2. 爬虫项目一：MediaCrawler（`deploy/mediacrawler-docker-compose.yml`）

中文内容平台（小红书/抖音/哔哩哔哩等）的批量采集服务，镜像 `mediacrawler:local`（`build: .`，源码不在本仓库，容器 WebUI/API 在 `192.168.1.220:8088`）。

### 设计要点

- **CDP bridge 复用真实登录态**（`mediacrawler-cdp-bridge` socat 伴生容器）：MediaCrawler 的 CDP 模式写死连容器内 `localhost:9222`；伴生容器把 `127.0.0.1:9222` 转发到 **chromium 的 CDP（172.19.0.2:9222）**——采集直接跑在持久化登录态的真实浏览器上，**Cookie/风控表现等同真人**，登录态一次维护全栈共用
- **固定 IP `172.19.0.6`**（2026-09-06）：同样源于 IP 抢占事件——它曾抢走 `.2` 自环到自己的 socat bridge
- **一律经 `tools/mc-crawl.sh` 启动，禁止裸调 API**（`nas-core` 纪律）：统一处理 CDP 锁、参数校验、结果落盘
- 采集**启动时持锁、采集期不持锁**（600s 长任务不能饿死 fetch-url/shop-search）；需要完全互斥时先跑完 mc-crawl 再起 CDP 子代理
- 配置/数据卷：`/home/docker/mediacrawler/{config,data}`

---

## 3. 爬虫项目二：shop-search 栈（`tools/shop-search.sh` + `shop_search_cdp.py` + `shop_search_fallback.py`）

电商登录态搜索（1688/京东/淘宝/天猫/拼多多/抖音商城），比价研究的主力（`skills/nas-shop` L0 层）。

### v2 机制

- **平台标签复用**：每平台固定购物标签（TTL 5 分钟、上限 2 个），减少反复开页触发风控
- **登录态检测是按 cookie 名单**（`LOGIN_COOKIES`）：1688→`unb/__cn_logon__`、jd→`pin`、taobao→`tracknick/lgc/unb`、pdd→`pdd_user_id/PASS_ID`、douyin→`sessionid` 等——检测的是名字不是值
- **1688 默认走桌面版通道**（移动版 CSS 选择器双套备好）；jd 稳定；taobao/tmall 间歇
- **滑块/验证 → needs_human**：先按 cdp-solve 自助协议接管（≤3 次/3 分钟），失败才保留给用户，处理完 `clear-cooldown` 重跑原命令
- 兜底链：shop-search → Shopme cloud（免 Key，仅 taobao/xhs）→ web_search 评测攻略 → MediaCrawler 种草口碑
- 实时价必须带检索时间戳与证据等级；缓存价标 C 级（`nas-shop` 规则）

---

## 4. 代理底座：mihomo（`deploy/mihomo-compose.yaml`）

全栈境外出口。双网络接入：

- `mnet`（macvlan，`192.168.1.250`）：旁路由语义，默认路由走 LAN 网关
- `hostlink`（bridge，`172.28.0.10`）：**主机↔容器互通桥**——macvlan 下主机不可达，由 `systemd mihomo-lan-proxy` 把宿主机 `192.168.1.220:7890` 转发到 `172.28.0.10:7890`；searxng/chromium 等容器也通过该桥接入代理

代理配置（订阅/节点）在 `/opt/stacks/mihomo/config/`，**不入本仓库**。

## 5. 当前状态与版本（2026-09-07）

| 组件 | 状态 |
|---|---|
| chromium 容器 | 运行中（healthcheck 绿），CDP `172.19.0.2:9222` 经 socat 暴露在 Docker 网络内 |
| mediacrawler 容器 | 运行中，WebUI 8088，CDP bridge 接 chromium 登录态 |
| mihomo | 运行中，宿主机 7890 可达 |
| 全套工具 | `/root/.dsh/tools/`（本仓库 `tools/` 同步副本） |
| 技能路由文档 | `skills/nas-core`（基座/纪律）、`nas-search`（L1-L5 路由）、`nas-shop`（电商比价 L0-L5） |

## 6. 推荐改进

1. **IP 抢占防线**：把 ai-browser 网络所有常驻容器固定 IP 写成约定表（`.2` chromium / `.4` searxng / `.6` mediacrawler），并加一个巡检脚本断言各容器 IP 与预期一致（`nas-stack-status.sh` 扩展）——2026-09-06 事件的系统性预防。
2. **chromium 自愈**：exit 128 静默停机事件后考虑 `autoheal` 类容器或 cron 探活 + 自动拉起。
3. **登录态看护**：cookie 名单检测已做，可加定时探活（每平台每天 1 次轻量访问）+ 失效告警，替代"用时才发现要重登"。
4. **MediaCrawler 版本管理**：`mediacrawler:local` 是本地 build——镜像里锁版本号，升级走重新 build + 回归一条龙，避免静默漂移。
5. **fetch-url 降级链测试化**：`fetch-url-tests.sh` 已有雏形，扩成固定样本集（含 NMPA 412 反爬站）的回归基线。
