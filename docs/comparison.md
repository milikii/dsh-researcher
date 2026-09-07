# 双预设对比、切换与选型

## 1. 能力对比

| 维度 | searxng（主） | exa（备） |
|---|---|---|
| 类型 | 自建元搜索聚合器（13 引擎） | 商业 API（关键词 + 语义神经检索） |
| 成本 | **0**（自建，无配额） | 免费配额，超出付费 |
| 覆盖 | 广（bing/baidu/sogou/google/brave/ddg/维基…聚合） | Exa 自建索引（网页深度/干净度好） |
| 中文 | 强（baidu/sogou 直连 + CJK 自动路由 + zh-CN 默认） | 一般 |
| 语义/相似检索 | ✗ | ✓（`searchType: neural`） |
| 时效过滤 | ✓（`fresh:` 操作符 → time_range，bing 除外） | 有限 |
| 结果控制 | junk 过滤 / canonical 去重 / 出处装饰 / 2 页分页 | highlights 高亮摘要 |
| 故障域 | 本机容器 + 各引擎可用性（有零结果回退） | Exa SaaS |
| 配置方式 | patch config（重启生效） | **UI 卡片热生效** + env 回退 |
| 可扩展性 | 随时可加引擎（settings.yml 一行） | 固定 API |

## 2. 切换操作

两个 provider 始终同时注册，选择由 `cordis.patch.yml` 钉死（确定性选择：id 必须已注册且 `available()`）：

```yaml
- id: web
  config:
    searchProvider: searxng   # ← 改为 exa
```

```bash
vim ~/.dsh/profiles/web/cordis.patch.yml
systemctl restart dsh-web
```

验证：`journalctl -u dsh-web -n 50` 无 search 报错；网页里发起一次带 web_search 的对话。

**注意**：`available()` 语义——searxng 只检查 baseURL 可解析（容器挂了要到真搜索才报 `WEB_PROVIDER_ERROR`）；exa 检查 apiKey 非空。切换前确保备预设配置完好（exa 的 apiKey 留空 + 无 `$EXA_API_KEY` 时不可用）。

## 3. 选型决策

- **日常一切查询** → searxng（钉死，零成本零配额顾虑）
- **"找相似的 / 找讨论过 X 的深度长文"** → 临时切 exa（neural）
- **SearXNG 容器维护 / 各引擎集体异常** → 切 exa 兜底
- **修完回到 searxng**（默认态）

## 4. 联动改进（Roadmap 汇总）

1. **主→备自动降级链**（两预设文档改进项的合流，P2）：searxng 连续 N 次 `WEB_PROVIDER_ERROR` 时自动临时降级到 exa 并在 UI 提示——把"故障兜底"从手动操作变成机制。实现落点：包装层监听 provider 错误 + 覆写 `searchProvider` 设置项（exa 卡片式的热生效通道已具备）。
2. **Exa 密钥出配置**（P1，见 exa-preset.md 改进 #1）。
3. **searxng 补 UI 卡片**（P2，见 searxng-preset.md 改进 #1）——补齐后两预设配置体验对齐。
4. **统一评测基线**（P2）：同一组查询分别跑两预设，对比召回/junk 率/延迟，作为切换与调参的依据。

## 5. 相关时间线

| 日期 | 事件 |
|---|---|
| 2026-09-01 | SearXNG 容器上线；百度对代理出口 IP 弹 CAPTCHA → 国内引擎绑 direct 网络修复 |
| 2026-09-01 | web-search-searxng 0.1.0 接入，取代此前 Exa 单预设 |
| 2026-09-03 | searxng 0.2.0（操作符/路由/清洗/分页/测试）；Exa 降为备份预设（wrapper 保留 UI 热生效能力） |
| 2026-09-07 | harness 回滚 0.1.1-rc.2，searxng 预设零迁移无损，exa 预设保持旧 API 版（迁移方案已验证） |
