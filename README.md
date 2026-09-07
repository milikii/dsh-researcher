# dsh-researcher

个人的 DeepSeek Harness（dsh）自部署研究工作站 —— 一台 Debian 服务器上的自托管 AI 研究栈：模型路由代理、自建搜索、电商比价研究栈，以及围绕它们的全部配置、插件、踩坑实录和运维手册。

> 本仓库是**活部署的快照与文档**：`harness/`、`skills/`、`tools/` 下的文件与服务器 `/root/.dsh/`、`/root/.dsh/tools/` 中的生产文件同源。改动服务器后请同步回本仓库。

---

## 这是什么 / 一句话

在 Debian 13 家用服务器上跑 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI（systemd 常驻、仅监听 loopback），通过自写插件把多家模型供应商（opencode Console Go、any、agent、glm、arak…）经局域网代理统一路由，配自建 SearXNG 搜索和一套 NAS 研究技能（搜索路由 / 电商比价），从 Windows 经 SSH 端口转发直接使用。

## 当前状态（2026-09-07）

| 项目 | 状态 |
|---|---|
| dsh 全局包 | **`0.1.1-rc.2`**（npm 最新 `0.1.2-rc.1`，因破坏性变更**主动回滚**，见 `docs/versions.md`） |
| 服务 | `dsh-web.service`，`127.0.0.1:3080`，systemd Restart=always |
| 访问方式 | ① Windows → SSH 本地端口转发 → `127.0.0.1:3080`；② `dsh.19970626.xyz`（trusted-host，走反代） |
| 认证 | 0.1.1-rc.2 无 token 门禁，直接打开即用（升级 0.1.2-rc.1 会引入启动 token，见 `docs/incidents.md` #3） |
| 默认模型 | `opencode-go/deepseek-v4-flash`，reasoningEffort `max` |
| 插件 | provider-proxy-settings、web-search-searxng（主搜索）、web-search-exa（备份搜索） |
| 搜索 | 自建 SearXNG（NAS Docker，`127.0.0.1:8080`），Exa 备份 |
| 出网代理 | `http://192.168.1.220:7890`（双通道：systemd 环境变量 + 插件 curl 级路由） |
| Node | v22.23.1，Debian 13 |

## 架构总览

```
 Windows 浏览器
   │  ① SSH 端口转发          ② https://dsh.19970626.xyz (反代)
   ▼
 Debian 13 服务器 (dsh-web.service, 127.0.0.1:3080)
   │
   ├── DeepSeek Harness 0.1.1-rc.2
   │     ├── profile: web  (dsh-base + dsh-web-app + 3 个自写插件)
   │     └── profile: headless (一次性任务 CLI)
   │
   ├── harness/plugins/provider-proxy-settings ── 拦截 llm/stream，按 provider 路由
   │       opencode-go ──► Console Go 网关 (opencode.ai/zen/go, 带 x-opencode-session)
   │       any ──────────► anyrouter.top   (anthropic 协议)
   │       agent / glm ──► agentrouter.org  (openai-responses/completions)
   │       arak ────────► windhub.cc       (未走代理路由)
   │       全部经 LAN 代理 192.168.1.220:7890 (curl 子进程, --proxy)
   │
   ├── harness/plugins/web-search-searxng ──► NAS Docker SearXNG (主搜索)
   ├── harness/plugins/web-search-exa ─────► Exa API (备份搜索)
   │
   ├── skills/  nas-core / nas-search / nas-shop  (研究栈技能)
   └── tools/   cdp-*, shop-search, mc-crawl, x-search … (研究栈工具)
        （cosdata、ledger 为 /root/01/ 下独立项目，软链挂载，不入本仓库）
```

## 目录导航

| 路径 | 内容 |
|---|---|
| `docs/architecture.md` | 设计思路、每个组件为什么这样做、插件机制详解 |
| `docs/deployment.md` | 从零部署手册：systemd、代理双通道、SSH 转发、密钥管理 |
| `docs/versions.md` | 版本策略、升级翻车记、回滚操作实录、备份位置 |
| `docs/incidents.md` | 踩坑实录（boot manifest batches、token 门禁、x-opencode-session 400…） |
| `docs/roadmap.md` | 后续推荐改进（按优先级） |
| `harness/plugins/` | 3 个自写 dsh 插件源码（可直接 `pnpm` 装） |
| `harness/config/` | settings.yaml、cordis.patch.yml、systemd unit、凭证模板 |
| `skills/` | NAS 研究栈技能（SKILL.md + workflows） |
| `tools/` | 研究栈命令行工具（CDP 读网页、电商搜索、爬虫路由…） |

## 三个自写插件

1. **provider-proxy-settings**（v0.1.0）—— 核心模型路由。node 半边拦截 `llm/stream`，把启用的 provider 的请求改用 `curl --proxy` 子进程发出（流式 SSE 解析、HTTP 错误分类、开机自检）；浏览器半边渲染设置卡片。内置 33 家 provider 路由表，实际启用：`opencode-go`、`any`、`agent`。**含 `x-opencode-session: auto` 补丁**（Console Go 硬要求，详见 incidents #4）。
2. **web-search-searxng**（v0.2.0）—— 主搜索。对接 NAS 上的自建 SearXNG 聚合器，零外部 API 成本，engines: bing/baidu/sogou/mojeek。
3. **web-search-exa-settings**（v0.1.0）—— 备份搜索。包装官方 Exa provider，密钥可走环境变量。

## 快速操作

```bash
systemctl status dsh-web          # 服务状态
journalctl -u dsh-web -n 50       # 日志（grep provider-proxy 看路由结果）
systemctl restart dsh-web         # 重启（注意：0.1.1-rc.2 无 token，重启后浏览器直接刷新即可）
dsh --profile web --dump-config   # 查看插件树合成结果
dsh --profile headless "任务文本"  # 一次性 agent 跑任务（不经 web UI）
```

## 密钥纪律

- **真实密钥只存于 `~/.dsh/.credentials.yaml`（chmod 600），绝不入库。** 本仓库只有 `harness/config/credentials.example.yaml` 模板。
- `settings.yaml` / `cordis.patch.yml` 中只出现 `apiKeyEnv`（变量名引用）；唯一例外是 Exa key 曾明文写在 cordis.patch.yml 中，本仓库副本已脱敏，生产文件中仍保留（待改造成环境变量引用，见 roadmap #5）。
