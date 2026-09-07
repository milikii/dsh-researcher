# 备预设：web-search-exa-settings（Exa 语义搜索）

**一句话**：给官方 `@deepseek-ai/dsh-web-search-exa` provider 做一层"双面（dual-face）"包装——node 半边补上官方包没有的设置 section（网页可改配置、热生效），browser 半边渲染 设置 → 插件 卡片。

---

## 1. 为什么保留这个预设

1. **语义检索是聚合器做不到的**：Exa 的 `searchType: neural` 按"内容相似度"而非关键词匹配找网页——"找讨论过 X 概念的长文 / 找与这篇相似的文章"这类研究型查询，SearXNG 的关键词聚合天然弱。
2. **故障兜底**：SearXNG 是单机自建（容器挂了/引擎全抽风时主预设整体不可用），Exa 是外部 SaaS，两者故障域正交。
3. **成本可控**：Exa 有免费配额，且只在主预设钉死之外按需使用。

## 2. 官方包的局限（本包装的存在理由）

官方 `@deepseek-ai/dsh-web-search-exa` **只注册 provider**：
- options 在启动时一次性固化（来自 patch config 或 `$EXA_API_KEY`）
- 没有设置 section、没有 UI——改 apiKey/numResults/searchType 都要改 patch + 重启
- 官方 schema 里 `apiKey` 是明文往返（浏览器端密码框显示）

## 3. 包装设计（`plugins/web-search-exa-settings/` v0.1.0）

### dual-face 结构

| 半边 | 文件 | 职责 |
|---|---|---|
| node | `lib/index.js` | 注册 provider + 安装 `web-search-exa` settings section（apiKey/baseURL/searchType/numResults/highlightsPerResult，schema 与官方一致） |
| browser | `lib/client.js` | `window.__ModuleLoader__` bundle：PluginCard 克隆（折叠卡片 + 草稿模型 + 保存/放弃），字段带中文 hint，apiKey 渲染为 secret 输入，保存后热刷新 |

### 核心机制：DynamicExaSearchProvider 子类

官方 provider 构造时固化 options。子类注入一个 `resolve()` 函数，**每次 `available()` / `search()` 前重新投影设置**：

```js
class DynamicExaSearchProvider extends ExaSearchProvider {
  #resolve
  constructor(resolve) { super({}); this.#resolve = resolve }
  available() { this.options = this.#resolve(); return super.available() }
  async search(request, signal) { this.options = this.#resolve(); return super.search(request, signal) }
}
```

效果：**GUI 改配置 → 下一次搜索立即生效，无需重启或重注册 provider**。设置 section 的 `setSource` 回调维护"当前生效配置"的引用，UI 保存即更新。

### 密钥回退链（`resolveOptions`）

```
config.apiKey（设置卡片/patch 明文） → $EXA_API_KEY（launch environment） → ''
```

浏览器卡片的语义：留空保存 = 保持当前值；清除覆盖 = 回落到环境变量。env 回退放在包装层而非 provider，保持官方包不改动。

### 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | 明文（见改进 #1） |
| `baseURL` | `https://api.exa.ai` | `/search` 自动追加 |
| `searchType` | `auto` | `auto / keyword / neural`（语义检索用 neural） |
| `numResults` | — | 未携带 maxResults 时的默认条数 |
| `highlightsPerResult` | 1 | 每条结果的高亮摘要句数 |

## 4. 挂载（`config/cordis.patch.yml`）

```yaml
- insert:
    - id: web-search-exa
      name: '@dsh-local/web-search-exa-settings'
      config:
        apiKey: <你的-EXA-API-KEY>   # 仓库已脱敏；线上为明文（待改进）
```

## 5. 版本现状与 API 迁移注意

- **v0.1.0（当前）**：依赖 dsh **0.1.1-rc.2** 的 `installSettingsSection` / `settingsNamespace`。
- **dsh 0.1.2-rc.1 已删除这两个导出**（2026-09-07 实测踩坑），迁移写法已验证：

```js
// 0.1.1-rc.2（当前源码）
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
const NS = settingsNamespace('web-search-exa')
installSettingsSection(ctx, NS, Config, config, { setSource, onChange })

// 0.1.2 迁移后
const NS = 'web-search-exa'                                   // 普通字符串
ctx.settings.installSection(ctx, NS, Config, config, { setSource, onChange })  // 钩子签名一致
// 且插件 inject 需补 'settings'
```

迁移后的完整源码已验证可跑（备份在服务器 `/root/backups/deepseek-harness/dsh-012rc1-state-20260907/`）。harness 回停在 0.1.1-rc.2，升级时按此迁移。

## 6. 推荐改进

1. **密钥出配置（P1）**：去掉 cordis.patch.yml 里的明文 apiKey，只留 `config: {}`，密钥走 `~/.dsh/.credentials.yaml` 的 `EXA_API_KEY`——插件的三层回退链已支持，零代码改动，消除配置文件最后一处明文密钥。
2. **双 API 兼容**：`installSection` / `installSettingsSection` 运行时探测（try/catch 动态 import），一份源码通吃 0.1.1/0.1.2，升级不再换文件。
3. **searchType 智能路由**：在包装层按查询特征（"相似/like/论文找相似"→ neural，其余 → auto）自动选型，让 agent 不必理解 Exa 参数。
4. **跟随官方包升级**：`@deepseek-ai/dsh-web-search-exa` 上游更新时回归验证 DynamicExaSearchProvider 子类兼容性（super.options 约定是其私有实现细节）。
5. **配额监控**：Exa 免费配额有限，可在包装层计数/记录用量，UI 卡片显示剩余额度。
