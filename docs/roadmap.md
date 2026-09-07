# 后续推荐改进（Roadmap）

按优先级排列。标注 [0.1.2] 的项与升级绑定，其余在当前 0.1.1-rc.2 上即可做。

## P1 —— 稳定性与安全

1. **版本钉死 + 升级前检查单**（已写入 `docs/versions.md`，建议脚本化）：
   ```bash
   npm view @deepseek-ai/dsh dist-tags --json          # 先看版本
   # 升级检查单：dsh-settings API 变更? connection 配置? --patch 语义?
   ```
   把 headless 一次性回归测试做成 `scripts/regression.sh`（固定用 `--patch` 临时把 default-model 切到 opencode-go 跑一句话任务，断言输出与 `[provider-proxy] ok` 日志），升级前后各跑一次。

2. **Exa 密钥出配置**：`cordis.patch.yml` 里的明文 `apiKey` 改走 `EXA_API_KEY` 凭证（插件已支持 `launchEnvironmentOf(ctx).get('EXA_API_KEY')`，见 `web-search-exa-settings/lib/index.js:52`），配置里只留引用。消除配置文件里的最后一处明文密钥。

3. **备份自动化**：目前备份是手工 `cp`。建议脚本（cron 每日）：
   - `~/.dsh/settings.yaml`、`cordis.patch.yml`、`credentials.yaml`、systemd 单元 → 打包到 `/root/backups/deepseek-harness/daily/`（保留 7 份）
   - 同步 `harness/`、`skills/`、`tools/` 到本 git 仓库并提交（单点真相原则）

## P2 —— 插件健壮性

4. **provider-proxy 双 API 兼容**（推荐，一劳永逸解决升级翻车）：
   ```js
   // 运行时探测 API 面，0.1.1 与 0.1.2 通吃
   const register = (ctx.settings && typeof ctx.settings.installSection === 'function')
     ? (c, ns, cfg, entry, hooks) => ctx.settings.installSection(c, ns, cfg, entry, hooks)
     : installSettingsSection
   ```
   加 `import { installSettingsSection } from '@deepseek-ai/dsh-settings'` 时用 try/catch 动态 import 规避 0.1.2 下模块导出不存在的崩溃。完成后升级不再需要换插件文件。

5. **自检降噪**：`incidents.md #6` 的三行噪音（tool registration ×3、disabled 初载、自检 FAIL）建议加静默逻辑或状态标签（`[pre-settings]` 前缀），避免以后误判。

6. **x-opencode-session 更进一步**：当前用 harness sessionId（每对话一个）。可观察 Console Go 的 prompt cache 命中率；若 sessionId 在 resume/branch 时变化导致缓存失效，考虑按 `sessionId` 稳定映射（会话恢复保持同值）。

## P3 —— 升级相关 [0.1.2]

7. **择机升级 0.1.2-rc.2/正式版**：迁移态文件已备好（`dsh-012rc1-state-20260907/`）。升级收益：boot batches、token 门禁（安全 +）、`--patch` 目录锚定。升级成本：一次性 token 配合 + 插件换迁移版。等 rc.2 出来一并做。
8. **升级后把 `cookieMaxAgeDays` 调成 3650**（方案已验证：cookie 跨重启长效有效，token 只需每浏览器/域名开一次）。

## P4 —— 部署与体验

9. **systemd 加固**：`dsh-web.service` 加 `NoNewPrivileges=yes`、`ProtectSystem=strict`（写白名单 `~/.dsh`、`/tmp`）、`ProtectHome=read-only` 视工具需要放开；目前以 root 跑，可评估专用用户。
10. **域名通道 HTTPS 检查**：`dsh.19970626.xyz` 走反代，确认反代强制 HTTPS + HSTS（0.1.1-rc.2 的 UI 无认证，HTTPS 是该通道唯一加密层）。
11. **headless profile 补一个默认模型 patch**：目前 headless 跟随全局 `agent-default-model`；如需独立默认（如固定走 glm 便宜模型），加 profile 级 patch 即可。
12. **研究栈技能/工具测试化**：`tools/` 下脚本已有 `.bak` 习俗，建议统一 `test/` 冒烟（searxng 已有 `test/smoke.mjs` 先例）。
