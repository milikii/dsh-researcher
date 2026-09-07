# 版本现状、历史与策略

## 当前状态（2026-09-07）

**dsh `0.1.1-rc.2`**（npm dist-tag latest 为 `0.1.2-rc.1`，2026-09-03 发布）。我们**故意停在 0.1.1-rc.2**：2026-09-07 试升 0.1.2-rc.1 成功运行了数小时后，按需求整体回滚（升级期间全部功能已修通，回滚是无损的、双向可逆的）。

| 组件 | 版本 | 备注 |
|---|---|---|
| `@deepseek-ai/dsh`（全局 CLI + 全部核心包） | 0.1.1-rc.2 | profile 下 226 个 `@deepseek-ai/*` 是指向全局的软链，随全局包一起升降 |
| provider-proxy-settings | 0.1.0（本地） | 旧 settings API（`installSettingsSection`）+ `x-opencode-session: auto` 补丁 |
| web-search-searxng | 0.2.0（本地） | |
| web-search-exa-settings | 0.1.0（本地） | 旧 settings API |

## 版本历史

| 日期 | 事件 |
|---|---|
| 2026-08-24 | 初始部署 0.1.1-rc.x，profile node_modules 建软链 |
| ~2026-08-28 | 加 systemd proxy drop-in（第 0 层代理）；provider-proxy 插件成形（取代早期会话级动态插件 prxy-7/ppxy-8/ppxy-9） |
| 2026-09-01 | provider-proxy 改造为常驻插件 + 设置卡片；searxng 接入 |
| 2026-09-03 | searxng 0.2.0（smoke test）；Exa 降为备份 |
| 2026-09-06 | opencode-go 路由正常工作（全天 HTTP 200） |
| 2026-09-07 15:39 | `npm install -g @deepseek-ai/dsh@latest` 升到 **0.1.2-rc.1** → 旧进程服务新客户端，报 `batches must be an array`（incidents #1） |
| 2026-09-07 17:34 | 重启暴露真正问题：`dsh-settings@0.1.2-rc.1` 删除 `installSettingsSection`/`settingsNamespace`，两个插件加载失败、服务崩溃循环（restart counter 63） |
| 2026-09-07 17:35 | 迁移插件到新 API `ctx.settings.installSection`（签名一致、inject 补 `'settings'`），0.1.2-rc.1 恢复运行；随后遇到启动 token 门禁（incidents #3）与 Console Go 400（incidents #4），均修复并验证 |
| 2026-09-07 20:27 | opencode-go 全链路修复后实测 4 次聊天全部 HTTP 200 |
| 2026-09-07 21:32 | **整体回滚至 0.1.1-rc.2**（用户决策）：npm 降级 + 插件恢复旧 API + 移除 0.1.2-rc.1 专属配置（`cookieMaxAgeDays`），`x-opencode-session` 补丁重放，headless 一次性任务全链路测试通过（2.2s，HTTP 200） |

## 0.1.1-rc.2 ↔ 0.1.2-rc.1 差异清单（升级前必读）

0.1.2-rc.1 相对 0.1.1-rc.2 的**破坏性变更**（已实测确认）：

1. **`dsh-settings` 删除 `installSettingsSection` / `settingsNamespace`**。替代：`ctx.settings.installSection(ctx, ns, schema, entry, hooks)`（钩子签名一致），命名空间变普通字符串，插件 inject 需含 `'settings'`。影响：provider-proxy-settings、web-search-exa-settings（本仓库两个插件源码均需迁移）。
2. **`dsh-client-connection` 引入浏览器认证门禁**：每个进程随机 launch token，`GET /?token=...` 换 30 天签名 cookie（密钥持久化在 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` 记录，跨重启有效）。无关闭开关；唯一可调 `cookieMaxAgeDays`（schema `natural().min(1)`，默认 30）。**patch 里覆盖 connection 的 config 必须整体替换并重抄 `trustedHosts: !!js ctx.webRuntime.trustedHosts`**。
3. **boot manifest 增加 `batches` 字段**：新旧版本的服务端/客户端不可错配（incidents #1 的根源）。
4. **`--patch` 相对插件名改为锚定 patch 文件所在目录**（旧版按 profile 根解析）。
5. 官方 CLI 仍无 `dsh update`/自升级命令：升级 = `npm install -g @deepseek-ai/dsh@<ver>`，核心包自动跟随（软链机制）。

## 升级操作手册（下次升 0.1.2-rc.1 或更高时）

1. 读 changelog，重点 grep `dsh-settings`、`connection` 的 API 变更。
2. 停服务：`systemctl stop dsh-web`。
3. `npm install -g @deepseek-ai/dsh@0.1.2-rc.1`。
4. 应用已迁移的插件（备份在 `/root/backups/deepseek-harness/dsh-012rc1-state-20260907/`，含迁移后三份插件源码与 cordis.patch.yml/settings.yaml）——拷回即可。
5. cordis.patch.yml 加回 connection 覆盖段（cookieMaxAgeDays，见上）。
6. `systemctl start dsh-web`，从 `journalctl` 取带 token 的 URL 打开一次（每个使用域名各一次），cookie 30 天内免 token。
7. 回归测试：headless 一次性任务（见 deployment.md §8）验证 opencode-go 全链路。

## 回滚操作手册（反向）

1. `systemctl stop dsh-web`
2. `npm install -g @deepseek-ai/dsh@0.1.1-rc.2`（核心包随软链整体降级）
3. 恢复旧 API 插件（备份 `/root/backups/deepseek-harness/reset_20260907_173429_dsh012/`，或本仓库 `harness/plugins/` 即为当前回滚态源码）+ 重放 `x-opencode-session` 补丁（本仓库副本已含）
4. 移除 cordis.patch.yml 中 connection 覆盖段（`cookieMaxAgeDays` 是新版专属）
5. `systemctl start dsh-web`，浏览器直接开 `http://127.0.0.1:3080`（无 token）

## 备份位置（服务器）

| 路径 | 内容 |
|---|---|
| `/root/backups/deepseek-harness/reset_20260907_173429_dsh012/` | **0.1.1-rc.2 旧 API 态**插件快照（回滚用） |
| `/root/backups/deepseek-harness/dsh-012rc1-state-20260907/` | **0.1.2-rc.1 迁移后态**（插件×3 + cordis.patch.yml + settings.yaml + credentials.yaml 快照，再升级用） |
| 本仓库 | 活配置/插件/文档的单点真相 |

## 版本策略

- **停在 0.1.1-rc.2**，直到 (a) 0.1.2 出 rc.2/正式版修掉迁移阻力，或 (b) 有必须用的新特性。
- 升级前必跑 headless 回归；升级窗口内预期有 token 门禁的一次性配合。
- 永远先 `npm view @deepseek-ai/dsh dist-tags` 确认版本，不盲用 `@latest`。
