# 踩坑实录（Incidents）

全部为 2026-09-07 升级 0.1.2-rc.1 当天实测遭遇，已逐一修复/验证。按时间线。

## #1 boot manifest `batches must be an array`

**现象**：`npm install -g` 更新后网页打不开，报 `Failed to load plugins client-modules: boot manifest batches must be an array`。

**根因**：**服务进程还是旧的**（更新前 20+ 小时启动，内存里是 0.1.1-rc.2 代码），但它从磁盘吐出的是新版客户端 JS；新版客户端要求 `window.__DSH_BOOT__.batches`（0.1.2-rc.1 新字段），旧进程生成的 index 里没有 → 崩。

**教训**：`npm install -g` 之后**必须重启服务**，旧进程不会自动换代码；版本错配的报错未必指向真正变更点。

## #2 `dsh-settings` 删除 `installSettingsSection`（真正的 blocker）

**现象**：重启后服务起不来，崩溃循环（restart counter 63），日志：`The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'installSettingsSection'`。

**根因**：0.1.2-rc.1 删除了 `installSettingsSection` / `settingsNamespace`。本仓库两个插件（provider-proxy-settings、web-search-exa-settings）都用旧 API 注册设置卡片。

**修复**（迁移，非补丁）：
```js
// 旧
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
const NAMESPACE = settingsNamespace('provider-proxy')
installSettingsSection(ctx, NAMESPACE, Config, config, { ... })
// 新
const NAMESPACE = 'provider-proxy'          // 普通字符串
ctx.settings.installSection(ctx, NAMESPACE, Config, config, { ... })  // 钩子签名一致
// 插件 inject 数组补 'settings'
```
0.1.1-rc.2 回滚后本仓库插件为**旧 API 版**；再升级时按 versions.md 手册换用备份的迁移态。

## #3 启动 token 门禁（0.1.2-rc.1 新安全机制）

**现象**：升级后打开 `http://127.0.0.1:3080` 报 401 `dsh web authentication required; reopen the URL printed by dsh web`。

**机制**（源码 `browser-auth.ts` 确认）：
- 每个进程启动时随机生成 launch token，只接受 `GET /?token=...` 一次性交换
- 交换后种 30 天 HttpOnly 签名 cookie（`SameSite=Strict`，绑定访问域名 host:port）
- **签名密钥持久化在 `~/.dsh/.credentials.yaml` → cookie 跨重启有效**（token 才是每进程的）
- 无关闭开关；`client-connection` 插件仅暴露 `trustedHosts / cookieMaxAgeDays / maxRequestBodyBytes`
- UI 的"API 密钥无效"文案 = 任何 AUTH（401/403）失败的统一标签，别被骗——这次根因与密钥无关

**缓解**（升级期间用）：patch 覆盖 `connection` 的 config 把 `cookieMaxAgeDays` 调大（如 3650），**必须整体替换并重抄 `trustedHosts: !!js ctx.webRuntime.trustedHosts`**（patch config 是整体替换不是深合并）。每个访问域名（127.0.0.1:3080 / dsh.19970626.xyz）各换一次 token。

**现状**：回滚 0.1.1-rc.2 后无此门禁；该覆盖段已从 cordis.patch.yml 移除。

## #4 Console Go 400：`Request is missing x-opencode-session`

**现象**：聊天时 opencode-go 的模型全部失败；UI 报"会话参数不对"，日志：
```
[provider-proxy] opencode-go/deepseek-v4-flash HTTP 400: Error from provider (Console Go):
Request is missing x-opencode-session and cannot be routed efficiently.
```

**根因**：Console Go（`opencode.ai/zen/go`）**硬性要求**每个请求带稳定的会话 ID 头（官方文档：路由优化 + prompt 缓存）。插件此前不透传该头。

**修复**（本仓库插件已含，两版本 API 下均验证通过）：
- 插件 `callThroughProxy` 支持 `x-opencode-session: auto` 占位符 → 运行时用 harness 的 `options.sessionId`（agent loop 每请求必带，`agent.ts:540`）填充，无则回退进程级 UUID；只保留可打印 ASCII（curl -H 安全）
- `settings.yaml`：`llm-pi-ai.providers.opencode-go.headers['x-opencode-session']: auto`

**验证**：无头 → 400，有头 → 200；headless 全链路 `HTTP 200, 2.2s`；网页聊天 4 连 200。

## #5 settings watcher 竞争（运维坑）

**现象**：手工改 `settings.yaml` 后被"弹回"。

**根因**：运行中的 dsh-web 持有设置内存态并监控文件；外部改文件与它的 flush 竞争时，内存态会覆盖手改。

**规程**：**改 `settings.yaml` 前先 `systemctl stop dsh-web`，改完再 start**。UI 里改设置则无此问题（走同一内存态）。

## #6 启动日志的固有噪音（非故障）

每次 boot 都会出现，**不要当故障处理**：
```
[provider-proxy] tool registration failed: cannot get property "tools" without inject   ×3
[provider-proxy] loaded: proxy=(disabled) ... enabled=[]
[provider-proxy] self-test FAIL: ... subprocess service or proxyUrl unavailable
```
它们来自 settings 就绪前的初载阶段；紧随其后的 `config: proxy=http://... enabled=[agent, any, opencode-go]` 才是生效态。真正的故障信号是 config 行之后仍无 `ok ... HTTP 200` 或出现 HTTP 4xx/5xx 详情。
