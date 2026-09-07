---
name: nas-search
description: NAS 自建搜索与采集栈 v3 路由指南。搜索需求（实时新闻、平台内容、深度调查、批量采集、URL 阅读）一律按本技能的分层路由执行：SearXNG 搜索 → 平台专用工具 → URL 读取层 → 登录态内容 → 批量采集。核心原则：Chromium 是「登录态网页深度读取器」，不是搜索引擎；搜索第一入口永远是 web_search（SearXNG）。基础设施/证据等级/降级规则见 nas-core。
---

# NAS 搜索与采集栈 v3 —— 分层路由

> **先加载 nas-core**（本技能的基座）：基础设施清单与实时状态、代理规则、证据等级表、标签页纪律、失败降级链都在那里，本技能只写搜索路由。运行状态用 `/root/.dsh/tools/nas-stack-status.sh` 实时查看，不引用旧结论。

## 0. 路由总则（按顺序，能低层不高层）

| 层 | 场景 | 使用 | 禁止 |
|---|---|---|---|
| **L1 搜索** | 普通搜索 / 实时新闻 / 开放 Web | `web_search`（= 本机 SearXNG `http://127.0.0.1:8080`）或 Exa（英文长尾/技术文档，免 Key） | 禁止用 Chromium 打开搜索引擎；禁止 fetch-url 读搜索结果页 |
| **L2 平台专用搜索** | 平台内搜索、帖子/评论/视频内容 | MediaCrawler（经 `/root/.dsh/tools/mc-crawl.sh` 包装）/ Agent-Reach 专用工具（bili、yt-dlp、Exa、RSS、Jina） | 禁止让模型自己驱动 Chromium 搜索平台；禁止裸调 MediaCrawler API |
| **L3 URL 深度读取** | 已有具体 URL 后读正文 | `fetch-url <URL>`（自动 HTTP → Obscura → Jina → CDP） | 禁止为读单页临时手写 CDP/Playwright 脚本（验证接管经 cdp-solve.sh，见 §4） |
| **L4 登录态内容** | 必须登录才可见（知乎/小红书/X/微博/Reddit 等） | Chromium CDP（`fetch-url --cdp-first`，Reddit 只读复用既有 tab）或 MediaCrawler | 不做站内搜索（**X 站内搜索例外**：仅经 `/root/.dsh/tools/x-search.sh`） |
| **L5 批量采集** | "找 20 篇 / 采集 100 帖 / 抓评论 / 统计" | MediaCrawler（`/root/.dsh/tools/mc-crawl.sh`）/ 平台专用工具 | 禁止浏览器逐帖点击；每次采集结束确认无遗留工作页 |

## 1. 第一层：SearXNG + Exa（所有搜索的第一入口）

- `web_search(queries)` 即本机 SearXNG（provider: searxng）。直连 API：`curl -s --data-urlencode 'q=<词>' -d 'format=json' http://127.0.0.1:8080/search`。
- **引擎现状不背口诀**：用 `nas-stack-status.sh` 的 `searxng.suspended / responsive` 实时看。全挂 → 见 nas-core §6（等 60s 一次，仍挂如实报告）。
- **英文长尾 / 技术文档 / site: 限定**：Exa via mcporter（免 Key）：`mcporter call exa.web_search_exa query="..." numResults=5`、`includeDomains=["reddit.com"]`（SearXNG 不传导 `site:`）。

### 1.1 web_search 内联操作符（provider 支持，不改 tool schema）

在查询词里直接写（多个可组合）：
- `lang:en` / `lang:zh` —— 覆盖自动语言路由（含 CJK → zh-CN + bing/sogou/baidu；否则 en + brave/bing/duckduckgo）
- `engines:brave,duckduckgo` —— 指定引擎
- `fresh:week` / `fresh:month` / `fresh:year` —— 新鲜度（对不支持 time_range 的 bing 追加年份词 + 按 publishedDate 过滤）
- `pageno:2` —— 取第 2 页补足结果
- 结果每条带 `engine` 与日期（无日期标 `(no date)`），垃圾域（microsoft/instagram/126 邮箱页等）与跟踪参数已按 host+path 去重。

## 2. 第二层：平台专用工具

- **知乎 搜索/批量**：MediaCrawler——一律经 `/root/.dsh/tools/mc-crawl.sh '<json body>'` 启动（body 同 `POST /api/crawler/start`，字段名以 `/openapi.json` 的 CrawlerStartRequest 为准：`crawler_type` / `keywords` / `max_notes_count` / `save_option`；错误 body 脚本 3 秒内报错，不会白等）。数据落 `/home/docker/mediacrawler/data/zhihu/jsonl/`
- **B站**：Agent-Reach B站搜索 API `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=<词>&page=1`（带 UA）；批量/字幕另走 MediaCrawler / yt-dlp
- **YouTube**：Agent-Reach yt-dlp（字幕/元数据，境外加 `--proxy http://172.28.0.10:7890`）
- **Reddit**：**读取 = `fetch-url <url> --cdp-first` 自动走 `old.reddit.com`**（www 新版帖子页有 reCAPTCHA 闸，old 版可直读；输出 url=原地址+read_url=实际地址）；无网络时降级只读复用同站已加载 tab / 镜像站 / 搜索索引并如实标注
- **X/Twitter**：**登录态站内搜索** = `/root/.dsh/tools/x-search.sh '<关键词>' [--latest]`（X 是实时信息优先源；临时 tab 自动关闭）；读具体帖 = `fetch-url <x-url> --cdp-first`
- **全网语义**：Exa via mcporter（见 §1）
- **RSS/网页**：feedparser / Jina（`curl -x http://172.28.0.10:7890 https://r.jina.ai/<URL>`，r.jina.ai 需经 mihomo）
- **小红书/抖音/微博**：MediaCrawler（登录态失效识别见 nas-core §5）→ 未配置时仅可 CDP 读已确定 URL

## 3. 第三层：统一 URL 读取层（fetch-url v3）

宿主命令：`fetch-url <URL>`（唯一入口，通道全部藏在工具内）。

自动路由（从便宜到昂贵）：**PDF** → pdftotext；**视频页** → 默认提示专用工具（yt-dlp / B站 API / MediaCrawler），`--render` 才用 Chromium；**静态页** → HTTP + 本地正文提取（直连失败自动走 mihomo）；**CF 盾/JS 壳/正文过短** → Obscura 本地隐身引擎（挑战页自动换代理重试；HTTP 壳页 <800 字时复核取优）→ 降级 Jina；**动态/登录态**（小红书、抖音、X 默认 CDP 优先）→ Chromium CDP（智能等待 + finally 关临时 tab）；**Reddit** → 自动 `.json`。

参数：`--cdp-first` · `--no-cdp` · `--render` · `--deep`（多通道对比取最优）· `--max-chars N` · `--budget N`（全局时间预算秒，默认 90；各通道从剩余预算分配；HTTP 404/410/451 为终态不级联）· `--batch urls.txt`（并发默认 3 上限 4，Obscura 层并发上限 2）。

输出 JSON：`{url, title, author, published, retrieved_at, elapsed_s, method, login_state, quality_score, content_chars, content}`；`method` ∈ http | obscura | jina | cdp | cdp-render | pdf | reddit-json | hint(SERP 拒绝) | none(终态失败)；失败带 `error` + `tried_methods`/`errors`，退出码非 0。

URL 只能来自搜索结果、站内导航或用户给出（nas-core §7：禁止猜路径）。

## 4. 第四层：Chromium 使用原则

- CDP `http://172.19.0.2:9222`（固定 IP；标签页纪律见 nas-core §4）。
- 定位：**登录态浏览器 + 动态网页读取器**。只打开：搜索结果筛选后的具体 URL、登录态页面。
- **永远不做**：打开搜索引擎 → 输入关键词 → 等渲染 → 抓 DOM 的搜索流程。
- 需要人工长期使用浏览器时用 Web UI `https://192.168.1.220:3001`。
- **页面出现滑块/人机验证**（fetch-url CDP 通道读到验证页/报风控）：用 `/root/.dsh/tools/cdp-solve.sh` 自助接管——`open <url>` 重开标签（fetch-url 的临时 tab 失败即关）→ `shot` 截图（read_image）判断 → `slider`/`drag`/`click` 操作 → `wait` 确认 → `close` 标签 → 重跑 `fetch-url --cdp-first`。上限每轮 3 次/3 分钟；短信/扫码/登录类交用户。除此之外仍然禁止手动驱动 Chromium。

## 5. 平台路由速查表

| 平台 | 搜索/批量 | 读具体页面 |
|---|---|---|
| 知乎 | MediaCrawler | `fetch-url`（静态可读；登录内容 CDP） |
| 小红书 | MediaCrawler（需登录配置） | CDP（登录态，fetch-url 默认 CDP 优先） |
| 抖音 | MediaCrawler（需登录配置） | CDP（同上） |
| B站 | Agent-Reach 搜索 API；批量 MediaCrawler | 视频页默认提示专用工具；详情页 `fetch-url --render` |
| YouTube | yt-dlp（字幕/元数据） | yt-dlp；必要时 `fetch-url --render` |
| Reddit | 实时参考源：`fetch-url <url> --cdp-first`（自动 old.reddit.com） | 同左；无网络降级复用 tab / 镜像 / 索引并标注 |
| X/Twitter | **实时参考源：`/root/.dsh/tools/x-search.sh`** | `fetch-url <帖子URL> --cdp-first`（登录态直读） |
| 微博 | MediaCrawler | `fetch-url`/CDP |
| PDF/论文 | — | `fetch-url <pdf-url>`（自动 pdftotext） |
| 开放 Web | **SearXNG 第一**（Exa 补英文长尾） | `fetch-url`（本地提取优先） |

## 6. 深度调查标准工作流（"调查/研究/最近/真实反馈/比较/找很多资料"）

1. 先 `ledger search`（第 4 阶段上线；未上线时查历史产物）→ 2. SearXNG/Exa 多个关键词（用 §1.1 操作符控制语言/引擎/新鲜度）→ 3. 收集候选 URL → 4. 按平台分类 → 5. 平台专用工具（MediaCrawler/Agent-Reach）→ 6. 需要登录态才 Chromium → 7. `fetch-url` 读正文 → 8. 去重 → 9. 交叉验证 → 10. **按证据等级标注（nas-core §3）** → 11. 按 §6.1 模板总结。

### 6.1 深度调查报告固定模板（结论性报告必须包含）

```
### 结论                    ← 一句话，标注整体证据强度
### 已确认事实              ← S/A 级，逐条带 URL
### 高可信用户证据          ← 登录态原文（A 级）或强交叉（B 级），带 URL
### 未证实信息              ← C/D 级，逐条标注"未证实/平台搜索快照"
### 推断                    ← D 级，写明依据与可证伪点
### 证据来源                ← 按 URL 汇总，标注等级与抓取方式
```

（证据等级定义与表述规则、快照≠原文、四层分离——见 nas-core §3。）

### 6.2 满足触发条件时用 workflow 模板

涉及 ≥3 个平台或 ≥8 个 URL 的深度调查，用 `/root/.dsh/skills/nas-search/workflows/deep-research.md`的流水线模板（规划 → 并行采集子代理 → 综合）而不是单代理串行；API 速查见 nas-core 附录 A。

## 7. 边界与红线

见 nas-core §8（安全红线）与 §7（实验治理）。本技能额外强调：
- 采集必须经 `/root/.dsh/tools/mc-crawl.sh` 启动（body 校验 + tab 基线 + unreachable 如实报错已内建）。
- 不新增搜索引擎/浏览器项目；Obscura 属已确认的 fetch-url 通道层，模型不直接调用。
- MediaCrawler 采集控制频率，遵守平台条款。
