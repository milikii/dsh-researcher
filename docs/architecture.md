# 架构与设计思路

## 1. 为什么用 DeepSeek Harness 自部署

需求：一个**长期常驻、数据不出家门**的 AI 研究工作台——网页会话可续、可挂后台任务、模型可换、搜索可自建。dsh（DeepSeek Harness）提供 profile 化的插件组合（cordis loader patch 层叠），`web` profile 起 Web UI、`headless` profile 跑一次性 CLI 任务，天然适合。

关键机制（这是理解一切故障的基础）：

- **profile = bundle 层 + 用户 patch 层**。`dsh web` 的插件树 = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 两个 bundle 的 `cordis.patch.yml` 层叠，再叠 `~/.dsh/profiles/web/cordis.patch.yml`（用户层：本仓库 `harness/config/cordis.patch.yml`）。
- **patch 的 `config:` 是整体替换不是深合并**。对某 `id` 覆盖 config 会把 bundle 层原有 config 全部丢掉——需要保留的字段必须原样重抄（0.1.2-rc.1 的 `trustedHosts: !!js ctx.webRuntime.trustedHosts` 教训）。
- **核心包从 dsh 安装本身解析**。`~/.dsh/profiles/node_modules/@deepseek-ai/` 下 226 个条目全是指向 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/...` 的**软链**——所以 `npm install -g` 升降级全局包 = 全部核心包整体升降级，不存在混版。
- **配置三处**：`cordis.patch.yml`（插件树/启动配置）、`settings.yaml`（运行时设置，UI 可改、文件被 watcher 监控）、`.credentials.yaml`（密钥，UI 密钥框写入）。

## 2. 模型路由：provider-proxy-settings

### 问题

多家供应商网络可达性不同：`anyrouter.top` / `agentrouter.org` **只有经局域网代理（192.168.1.220:7890）才可达**；而 Node 原生 fetch 走环境变量代理需要 `NODE_OPTIONS=--use-env-proxy`，且粒度是**全局**的——不能按 provider 区分。

### 方案

两层代理，各管一段：

**第 0 层（systemd drop-in，`harness/config/dsh-web-proxy.conf`）**：给 dsh-web 进程设 `HTTP_PROXY/HTTPS_PROXY` + `NO_PROXY`（opencode.ai、api.deepseek.com、windhub.cc 直连），管 Node fetch 的原生请求。

**第 1 层（本插件）**：拦截 `llm/stream` 事件瀑布，命中启用的 provider 时改用 `curl -sS -N --proxy ...` 子进程发请求：
- 流式 SSE 解析、OpenAI/Anthropic 两种协议翻译、工具调用透传
- HTTP 错误分类（AUTH/RATE_LIMIT/INVALID_REQUEST/SERVER…）→ UI 显示
- 未启用/无密钥的 provider → `yield* next()` 无伤穿透
- 开机自检（probe proxy URL），启动日志可见路由是否健康

**路由表数据驱动**：内置 33 家 provider 事实表（api 类型/baseURL/模型匹配），但 `settings.yaml` 的 `llm-pi-ai.providers.<name>` 可覆盖 `apiKeyEnv / baseURL / api / models / headers`——**加一家供应商不改插件代码，只改设置**。

### 当前实际路由

| provider | 协议 | 上游 | 密钥 | 备注 |
|---|---|---|---|---|
| `opencode-go` | openai-completions / anthropic-messages | `opencode.ai/zen/go` | `OPENCODE_GO_API_KEY` | Console Go 网关；**必须带 `x-opencode-session`**（见下） |
| `any` | anthropic-messages | `anyrouter.top` | `ANY_API_KEY` | 带 `anthropic-beta: context-1m` 头 |
| `agent` | openai-responses | `agentrouter.org/v1` | `AGENT_API_KEY` | 伪装 UA `claude-cli/2.1.220` |
| `glm` | openai-completions | `agentrouter.org/v1` | `AGENT_API_KEY` | 与 agent 共用密钥 |

### x-opencode-session 补丁（本仓库副本已含）

Console Go（`opencode.ai/zen/go`）**硬性要求**每个聊天请求带稳定的会话 ID 头，用于路由优化与 prompt 缓存；缺失即 400 `MissingSessionID`。

实现：`settings.yaml` 里 `opencode-go.headers['x-opencode-session']: auto`，插件遇到该占位符时用 **harness 的 `options.sessionId`**（agent loop 每次请求都会盖上 `sessionId`，`agent.ts:540`）填充——完全符合官方"每会话一个稳定 ID"语义，每个对话独立缓存桶。无 sessionId 的调用（如探针）回退进程级 UUID。

## 3. 搜索：自建优先

- **主**：`web-search-searxng` → NAS Docker 上的 SearXNG 聚合器（`127.0.0.1:8080`，engines: bing/baidu/sogou/mojeek）。零外部 API 成本、可控、无配额。`cordis.patch.yml` 里 `- id: web / searchProvider: searxng` 钉死选择。
- **备**：`web-search-exa-settings`（包装官方 Exa provider）。切换只需把 `searchProvider` 改为 `exa` 重启。

## 4. 研究栈（skills/ + tools/）

三层技能 + 命令行工具，全部挂在 `~/.dsh/skills/`、`~/.dsh/tools/`：

- `nas-core`：研究栈基座——基础设施清单、内网代理规则、证据等级（S/A/B/C/D）、Chromium 标签页纪律、登录态识别、降级链。
- `nas-search`：搜索路由 v3——SearXNG 第一入口 → 平台专用工具 → URL 读取 → 登录态深度读取 → 批量采集；核心原则"Chromium 是登录态网页深度读取器，不是搜索引擎"。
- `nas-shop`：电商比价研究（L0-L5 路由）——shop-search.sh 登录态平台搜索 → Shopme 兜底 → web_search 评测 → MediaCrawler 种草口碑；实时价必须带检索时间戳与证据等级。
- 工具：`cdp-solve`（滑块/验证码自助）、`cdp_read`（网页深读）、`shop-search`（1688/京东/淘宝搜索）、`mc-crawl`（MediaCrawler 路由）、`x-search`、`nas-stack-status`。

另有 `cosdata`（化妆品成分库）与 `ledger`（证据账本）为 `/root/01/` 下独立项目，经软链挂入 skills，**不在本仓库**。

## 5. 访问面与安全边界

- dsh-web 只绑 `127.0.0.1:3080`——服务器本身不暴露端口。
- Windows 经 SSH 本地转发使用（堡垒化：要碰 UI 必先 SSH）。
- `dsh.19970626.xyz` 走反代 + `--trusted-host`（0.1.1-rc.2 仅有 Host 信任栅栏，**无认证**；0.1.2-rc.1 引入启动 token + 签名 cookie，见 versions.md）。
- dsh 的 `/api` 请求信任栅栏：Host 必须是 loopback 或 trusted-host 列表值，Origin 必须同源，`sec-fetch-site: cross-site` 拒绝——防 DNS rebinding。
