---
name: nas-core
description: NAS 研究栈共用基座（nas-search / nas-shop 都先加载本技能）：基础设施清单与 nas-stack-status 实时状态、内网代理规则、证据等级 S/A/B/C/D 与表述规则、Chromium 标签页纪律、登录态失效识别、失败降级链与停止条件、实验治理。凡涉及 基础设施 / 证据等级 / 标签页 / 登录态 / 代理 / 降级 的问题先读本技能。
---

# NAS 研究栈基座 —— nas-core

> 本技能只放两套研究栈（nas-search / nas-shop）**共用且不随日期变化**的规则。
> 登录态、引擎健康、冷却等**易变状态一律不写在这里**——用 `/root/.dsh/tools/nas-stack-status.sh` 实时查看，禁止引用旧结论。

## 1. 基础设施清单（服务名 · 地址 · 用途）

| 服务 | 地址 | 用途 |
|---|---|---|
| SearXNG | 容器 `searxng`，宿主机 `http://127.0.0.1:8080` | `web_search` 的后端（provider 已固定） |
| Chromium CDP | `http://172.19.0.2:9222`（ai-browser 网络，**必须 IP 直连**，Chrome 拒绝非 IP Host 头） | 登录态网页读取器；Web UI `https://192.168.1.220:3001` |
| MediaCrawler | `http://192.168.1.220:8088` | 中文平台批量采集，一律经 `/root/.dsh/tools/mc-crawl.sh` 启动（禁止裸调 API） |
| Obscura | 容器 `obscura`，`127.0.0.1:9223` | 本地隐身读取引擎（Rust+V8，stealth 指纹）；已接入 fetch-url 的 CF 盾/JS 壳层，模型不直接调用 |
| mihomo 代理 | 宿主机 `192.168.1.220:7890` / 容器网络 `172.28.0.10:7890` | 境外出口 |
| fetch-url | `/usr/local/bin/fetch-url` | 统一 URL 读取入口（HTTP → Obscura → Jina → CDP 自动路由） |
| cdp-solve | `/root/.dsh/tools/cdp-solve.sh` | 人机验证自助接管（临时操控 Chromium）：list/open/close/eval/shot/click/drag/slider/wait；自动持 CDP 锁；截图落 /tmp/cdp-solve/；只用于滑块/点选验证，短信/扫码/登录类不用 |
| 工具目录 | `/root/.dsh/tools/` | shop-search.sh · shop_search_cdp.py · mc-crawl.sh · x-search.sh · nas-stack-status.sh |
| cookie-keepalive | `/root/01/keepalive/` | systemd timer 每日两轮给登录 Cookie 续期；结果看 `/root/01/keepalive/status.json`；手动跑 `run.sh` |
| cosdata | `/root/01/cosdata/cosdata` | 本地化妆品成分库（零网络毫秒级，B 级证据） |
| 证据账本 | `/root/01/ledger/ledger`（第 4 阶段上线） | 跨会话历史记录（先查账本再实时刷新） |

运行状态、登录态、引擎健康、冷却/needs_human：**`/root/.dsh/tools/nas-stack-status.sh`**（JSON；`--markdown` 出表格，25 秒内完成，子项失败只置 null）。

## 2. 内网代理规则

- shell 会话默认带 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=192.168.1.220:7890`。
- 工具脚本（mc-crawl / shop-search / fetch-url 等）已内置 `no_proxy`，无需手工处理。
- **手工 curl** 发往 `192.168.1.220:<port>`（MediaCrawler 8088、Web UI 3001）与 `172.19.0.x`（Chromium CDP 9222）的命令必须前置 `no_proxy='*' NO_PROXY='*'`，否则被送进 mihomo 折返 502/空响应。`127.0.0.1:8080`（SearXNG）不受影响。

## 3. 证据等级 S/A/B/C/D（强制标注）

| 等级 | 定义 | 用途 |
|---|---|---|
| **S 级** | 官方公告、官方产品页、官方帮助中心、官方账号/客服明确表述 | 核心事实 |
| **A 级** | 登录态直接读取的平台原文、原帖、原视频、原评论（含登录态商品/备案页价格与成分表） | 核心事实 |
| **B 级** | 可靠新闻媒体、专业网站、多个独立来源交叉确认；本地权威库（cosdata = EU CosIng + NMPA IECIC） | 辅助事实 |
| **C 级** | 搜索引擎摘要、平台搜索结果快照、比价站快照、缓存库价格（时间未知） | 只能当**线索**，必须标「缓存/快照」 |
| **D 级** | 单一用户爆料、未经验证截图、论坛转述、模型推测 | 必须标注「未证实/推断」 |

**表述规则**：
1. 搜索/平台**快照 ≠ 原文**：只拿到标题/时间/点赞/摘要时只能写「搜索结果显示……」（C 级），禁止写「已读取原文」（A 级才可）。等级取决于实际获得的内容，不因工具名自动升级。
2. 多来源合流时区分四层：① 官方确认（S）② 用户实际观察（A/C）③ 社群流传（C/D）④ 模型推断（D，注明依据）——不混成一个事实。
3. 内测/灰度/返现/门槛/发布时间等无官方确认的，写「有多条用户/社群证据指向……（C/D 级，未获官方确认）」。
4. `from_cache: true` 的结果沿用原通道等级（登录态 A 级仍是 A），但「检索时间」必须填 `cached_at`。
5. 来源冲突不选边，并列呈现；关键结论尽量保留 URL 与抓取时间。

## 4. Chromium 标签页纪律

- 本次任务创建的每个临时 tab 必须记录 targetId：创建 → 访问 → 读取 → 关闭，成功/失败/超时一律 cleanup（工具层已内建）。
- **只关闭本任务/本工具记录过的 tab，绝不关用户原有 tab**；无法安全判断时宁可不关。
- 普通任务同时最多 2–4 个临时页面；批量交给工具脚本串行执行。
- shop-search v2 按平台复用购物标签（TTL 5 分钟，上限 2 个，`close all` 清理；needs_human 的标签先由 agent 经 cdp-solve 接管自助处理，失败再保留给用户，处理完 clear-cooldown）。
- **验证接管纪律（cdp-solve）**：只操作 needs_human 保留标签或自己 open 的标签，绝不碰用户其他标签；截图落 /tmp/cdp-solve/（read_image 查看，css 坐标 = 截图像素 / scale）；每轮验证自助上限 3 次尝试 / 3 分钟；只做滑块/点选类，短信/扫码/登录类直接交用户。
- Chromium 资源配额（CPU 4 核 / RAM 6 GiB / 核显直通）**未经用户确认不得修改**；内存增长先关无用临时 tab → 降并发 → 等待释放，绝不改容器配置。

## 5. 登录态失效识别

- **MediaCrawler 报 DataFetchError「您当前登录的账号没有权限访问」** = 登录态过期（不是风控）：停止重试，提示用户到 https://192.168.1.220:3001 重新登录，重登即恢复。
- **NMPA 官网直连 412**（瑞数式 JS 反爬）：查备案信息一律 `fetch-url --cdp-first`；其登录会话长挂会过期，读取失败时提醒用户重登。
- 登录态是否在，先读 `/root/01/keepalive/status.json`（last_run + logged_in/logged_out）判断是刚掉还是一直没登，再决定是否提示用户重登；平台级以工具返回的 `login_state` 为准。
- **风控 ≠ 登录失效**：滑块/punish 页是风控（先经 cdp-solve 自助，失败再交真人，见 §6 与各技能 needs_human 协议），登录 Cookie 仍然有效。

## 6. 失败降级链与停止条件

- **同一通道失败 2 次即降级换路**；禁止 sleep 后原样重试（等待不能解决风控/挂起，只会浪费时间）。
- 工具返回 `needs_human` / `cooldown` / `quota exceeded` / `unreachable` 时**立即停止该通道的一切调用**。其中**验证类 needs_human（滑块/点选/punish/x5sec）例外**：先按 cdp-solve 自助协议接管处理（shot → slider/drag → wait，≤3 次/3 分钟），通过后 clear-cooldown 重跑原命令；自助失败或纯 quota/cooldown 才如实告知用户并降级到可用通道（说明「该平台当前只有 X 级线索」）。
- 引擎全部挂起（SearXNG）：等 60s 冷却再试一次，仍挂则如实报告（重启 searxng 容器属部署操作，须用户确认）。
- 深度任务先查证据账本 `ledger search`（第 4 阶段上线前查历史结果与既往产物），只对缺失/过期项做实时刷新。

## 7. 实验治理

- 临时实验脚本（CDP/Playwright/新工具原型）只能放 `/root/01/lab/`，且**事先征得用户同意**；正式任务流程禁止临时手写 CDP 脚本（工具失败后的诊断除外，同样遵守标签页清理规则）。
- **人机验证接管不是实验**：滑块/验证页一律经 `/root/.dsh/tools/cdp-solve.sh` 操作（自带 CDP 锁与标签纪律），禁止为过验证临时手写 CDP/Playwright 脚本。
- 会话结束前：实验脚本要么合并进 `/root/.dsh/tools/` 正式工具，要么归档到 `/root/01/archive/<主题>/`（附 README 说明做什么/结论/合并到哪）。
- URL 只能来自搜索结果、站内导航或用户给出，**禁止猜路径**（404 不是渲染问题）。
- `site:` 需求的替代：Exa `includeDomains=["domain.com"]`（`mcporter call exa.web_search_exa query="..." includeDomains=[...]`）或 `engines:brave,duckduckgo`（SearXNG 不传导 `site:`）。

## 8. 安全红线（两套栈一致）

- 不导出、不输出、不上传 Cookie；登录态只在 NAS 本地（Chromium Profile、工具脚本内部）使用。
- 不申请付费 API Key（Shopme/Exa 等免 Key 通道不受限）。
- 不修改任何容器、部署结构、配额与 `/root/.dsh/tools` 现有脚本本体（工具自身缺陷报给用户，由用户决定是否修）。
- 采集遵守平台条款、控制频率；不虚构库存/销量/优惠券/历史低价。

## 附录 A：workflow / subagent API 速查（2026-09-04 实机探测确认）

**workflow 工具**（两预设均已挂载）：参数 `meta`（必需 `name` + `description`；可选 `phases: [{title, model?, provider?}]`）、`script`（纯 JS 函数体，允许顶层 await，**不含** `export const meta`，末尾 `return <json>`）、`args`（可选 JSON 对象，脚本内以 `args` 全局暴露）。脚本内可用 hook（无 Node/文件/定时器 API）：

- `agent(prompt, opts)` — 起一个子代理到完成。`opts.schema`（对象根 JSON Schema，仅 type/properties/required/items/enum/const/oneOf）时返回校验后的结构化对象，否则返回最终文本；子代理普通失败返回 **null**（用 `filter(Boolean)` 容错）。
- `opts.label`（显示名）· `opts.phase`（进度组，对应 meta.phases 的 title）· `opts.model`（按子代理覆盖模型，如 `any/claude-opus-5`；默认 flash）· `opts.provider`。
- `parallel(thunks)` — 并发跑零参函数并**全量等待**（屏障）；任一 thunk 抛错该项为 null。
- `pipeline(items, ...stages)` — 逐项过各阶段，**无跨阶段屏障**；stage 收 `(prev, item, index)`；单个 stage 抛错该 item 落 null 并跳过其后阶段。
- `phase(title)` / `log(message)` — 进度叙述。
- 误用（未知选项/坏 schema/超并发与总量上限 1000/单次 parallel 或 pipeline 条目 >4096）会**杀死整个脚本**，不会降级为 per-item null。
- 返回值过 JSON 边界（函数/循环/undefined 等被拒）；父模型只看到最终 JSON 与子代理计数。

**CDP 串行锁**：所有驱动 Chromium 的工具共用 `/tmp/cdp.lock`（flock 独占，等待上限 240s）：fetch-url 的 cdp/cdp-render 通道（超时返回 `error="cdp lock timeout"`）、shop-search 的 docker 调用、x-search、mc-crawl 的采集启动。并行流水线里 CDP 通道天然串行；锁超时按普通失败降级换路（nas-core §6）。MediaCrawler 采集的**持续期**不持锁（600s 采集会饿死其他工具），只有启动动作持锁——如需完全互斥，先跑完 mc-crawl 再起 CDP 子代理。

实测样例（两并行 echo 子代理 + 聚合）见 `/root/01/refactor-phase5-report.md` §2。
