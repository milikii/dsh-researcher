# 主预设：web-search-searxng（自建聚合搜索）

**一句话**：把 dsh 的 `web_search` 接到自托管 SearXNG 聚合器的 JSON API 上，多引擎聚合、中文场景优化、零外部 API 成本，结果经过清洗/去重/出处装饰后交给 agent。

由三层组成：**SearXNG 容器（部署层）→ 插件（适配层）→ cordis patch（挂载层）**。

---

## 1. 部署层：SearXNG 容器（`deploy/`）

### docker-compose.yml 要点

| 项 | 值 | 原因 |
|---|---|---|
| image | `searxng/searxng:latest` | 官方镜像 |
| ports | `8080:8080` | Web UI + JSON API（局域网可达） |
| `SEARXNG_SECRET_KEY` | `file:///etc/searxng/secret_key` | 密钥走文件挂载，不进 compose 文件 |
| networks | `ai-browser`（固定 IP 172.19.0.4）+ `mihomo_hostlink` | 双网络：接入 Chromium 编排桥 + mihomo 代理桥（见下） |
| mem / cpus | 1g / 1.0 | 聚合器够用 |
| logging | 10m × 3 轮转 | 防日志膨胀 |

### settings.yml 关键设计（`deploy/searxng-settings.yml`）

1. **JSON API 必须显式开启**：`search.formats: [html, json]`。默认只有 html——不开 json，插件的 `format=json` 请求会被 403 拒。这是自建对接的第一坑。
2. **引擎出站代理在 settings.yml 里配，不是环境变量**：SearXNG 不读 `HTTP_PROXY` 环境变量，必须写 `outgoing.proxies`（指向 mihomo `172.28.0.10:7890`）。compose 里的 HTTP_PROXY 行只是兜底噪音。
3. **国内引擎绑定 `direct` 网络直连**（2026-09-01 修复）：`bing / baidu / sogou` 挂 `network: direct`（空 proxies = 直连）。原因：**百度对代理出口 IP 弹 CAPTCHA**，国内引擎直连才稳定；google/ddg/brave 等被墙引擎继续走 mihomo。这是双网络设计的核心动机。
4. `default_lang: zh-CN`、`safe_search: 0`、`limiter: false`（内网实例不开启限流）、`public_instance: false`。

### 启用引擎（13 家）

国内（direct 直连）：`bing`（cn.bing.com）、`baidu`、`sogou`
走代理：`google`、`google news`、`duckduckgo`、`duckduckgo html`、`brave`、`startpage`、`mojeek`、`bing news`
辅助：`wikipedia`、`wikidata`

---

## 2. 适配层：插件（`plugins/web-search-searxng/` v0.2.0）

### 架构原则

- **seam 注册模型**：搜索 provider 不拥有 `ctx.web` 键，而是 `ctx.web.registerSearchProvider()` 注册进 seam 的 provider 注册表——与官方 Exa provider 同构，天然可互换（这正是双预设可切换的根基）。
- **纯函数/副作用分层**：`lib/core.js`（193 行，零依赖纯函数：解析/路由/过滤/去重/装饰）与 `lib/index.js`（197 行，只做 HTTP + 组装）。好处：核心逻辑可用冒烟测试锁定（`test/smoke.mjs`），改 HTTP 层不碰逻辑。

### 查询语法（agent 可直接在提问里用）

| 操作符 | 作用 | 映射到 SearXNG |
|---|---|---|
| `lang:zh-TW` | 强制语言 | `language` 参数 |
| `engines:google,brave` | 强制引擎 | `engines` 参数 |
| `fresh:day/week/month/year` | 时间窗 | `time_range`（同时移除 bing——其 time_range 响应不可靠，空则回退 sogou/brave/ddg） |
| `pageno:3` | 翻页起点 | `pageno` |
| `site:example.com` | 保留传透 | 引擎路由自动绕开不透传 site: 的 bing |

### 自动路由（不带操作符时）

- 检测 CJK → `language=zh-CN` + 引擎 `[bing, sogou, baidu]`
- 纯英文 → `en` + `[brave, bing, duckduckgo]`
- 含 `site:` → 路由到能处理该操作符的引擎组（中文 `[sogou, baidu, bing]` / 英文 `[brave, ddg, bing]`）

### 清洗管线（`cleanRaw`）

```
原始 results[]
  → junk 域过滤（默认黑名单 10 域：microsoft/msn/bing/live/office/instagram/facebook/126/163 邮箱等
     + 配置 junkDomains 追加 + 单双字母 wiki 条目）
  → 丢弃无 snippet 的条目（seam 无其他字段可派生摘要）
  → canonical URL 去重（剥 utm_*/fbclid/gclid/spm/from/ref/_t/msockid、去 fragment、host 小写、去尾斜杠）
  → snippet 装饰：前置 `(engine · date)` 出处标签——agent 引用结果时可溯源
```

### 分页与降级

- **2 页策略**：page1 清洗后不足 `numResults`（默认 20）→ 拉 page2 合并去重截断；page2 失败不伤 page1 结果。
- **零结果引擎回退**：`results=0` 且 `unresponsive_engines` 非空 → 去掉 `engines` 参数重试一次（SearXNG 全默认引擎）。应对"指定引擎组恰好全挂"的场景。
- 错误映射：中断 → `WEB_ABORTED`；HTTP/重定向(JSON API 禁重定向)/解析错误 → `WEB_PROVIDER_ERROR`。

### 配置项（cordis.patch.yml 的 `config:`）

| 键 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8080`（可被 `$SEARXNG_BASE_URL` 覆盖） | JSON API 端点 |
| `numResults` | 20 | 每次搜索返回条数上限 |
| `junkDomains` | `[]` | 追加的垃圾域黑名单 |

### 依赖与 API 兼容性

依赖 `@deepseek-ai/dsh-web@0.1.1-rc.2`（`WebError`）+ `schemastery`。**本插件不使用 dsh-settings API、无 UI 设置卡片**（配置只能改 patch 重启）——副作用是它在 0.1.1→0.1.2 升级中**无需迁移**（installSettingsSection 删除事件未波及它）。

---

## 3. 挂载层（`config/cordis.patch.yml`）

```yaml
- insert:
    - id: web-search-searxng
      name: '@dsh-local/web-search-searxng'
      config:
        baseURL: http://127.0.0.1:8080
        numResults: 20
- id: web
  config:
    searchProvider: searxng    # 钉死主预设（选择是确定性的：id 必须已注册且 available）
```

## 4. 版本历史

| 版本 | 日期 | 内容 |
|---|---|---|
| 0.1.0 | 2026-09-01 | 初版：对接 SearXNG JSON API，注册 provider，基础映射 |
| **0.2.0（当前）** | 2026-09-03 | 拆出纯函数 core.js；内联操作符解析；CJK 自动路由；junk 域过滤；canonical 去重；snippet 出处装饰；2 页分页；零结果引擎回退；smoke.mjs 冒烟测试 |

## 5. 推荐改进

1. **UI 设置卡片**：加 `web-search-searxng` settings section（numResults/junkDomains 可在网页改，不用重启）——参照 exa 预设的卡片实现即可；注意这将引入 dsh-settings 依赖，需随 0.1.2 迁移面同步。
2. **结果质量评测脚本**：固定 10 条查询（中/英/site:/fresh:）跑 SearXNG，断言结果数与 junk 率，做回归基线——引擎路由改动的安全网。
3. **fresh: 细化**：bing 的 time_range 恢复后解除移除逻辑；或把 bing news 单独用于时效查询。
4. **junk 黑名单外置**：观察一段时间后把高频垃圾域从代码默认表迁到 patch 配置。
5. **失败自动 fallback 到 exa**：seam 目前选择是静态钉死的；可在 provider 层做"主预设连续 WEB_PROVIDER_ERROR → 提示切换/自动换 exa"的降级链（联动见 `comparison.md` §4）。
