---
name: nas-shop
description: 电商购物研究栈：商品实时搜索、跨平台比价、找平替、1688 货源分析。凡涉及 比价/价格对比/哪里买便宜/最低价/找平替/平价替代/1688货源/批发价/淘宝价/京东价/拼多多/抖音商城/购物研究 的任务一律先加载本技能，按 L0-L5 路由执行：shop-search.sh v2 登录态平台搜索（1688 默认桌面版通道；jd 稳定；taobao/tmall 间歇；滑块/验证经 cdp-solve 自助接管，needs_human 兜底人工）→ Shopme cloud 免 Key 兜底（仅 taobao/xhs）→ web_search 评测攻略 → MediaCrawler 种草口碑。实时价必须带检索时间戳与证据等级，缓存价永远标 C 级。
---

# NAS 电商购物研究栈 —— nas-shop 路由指南

> **先加载 nas-core**（本技能的基座）：基础设施清单与实时状态、内网代理规则、证据等级表（含 from_cache 表述）、标签页纪律、失败降级链都在那里，本技能只写电商路由。运行状态（登录态/冷却/needs_human/配额）用 `/root/.dsh/tools/nas-stack-status.sh` 实时查看，不引用旧结论。

## 0. 路由总则（按顺序，能低层不高层）

| 层 | 场景 | 使用 | 禁止 |
|---|---|---|---|
| **L0 商品实时搜索** | 任何「搜商品/比价/查价格/找货源」起点 | `/root/.dsh/tools/shop-search.sh <platform> <keyword>`（登录态 CDP，本栈核心） | 禁止手动驱动 Chromium 开平台搜索页抓取 |
| **L0.5 云库兜底** | 平台风控/未登录/交叉验证 | `/root/.dsh/tools/shop-search.sh cloud[:taobao\|xhs] <keyword>`（免 Key，缓存价 C 级；**仅 taobao / xhs，tmall 上游不支持**） | 禁止把缓存价当实时价 |
| **L1 开放 Web** | 评测/攻略/历史价格（慢慢买、什么值得买）/平台政策/真假鉴别 | `web_search`（SearXNG） | — |
| **L2 平台内容** | 小红书种草笔记、抖音带货内容 | MediaCrawler（`/root/.dsh/tools/mc-crawl.sh`）；B站走 Agent-Reach API | 禁止浏览器逐条点击 |
| **L3 URL 深读** | 商品详情页/旗舰店页/参数页 | `fetch-url <URL>`（`--cdp-first` 走登录态） | 禁止手写 CDP 脚本（人机验证接管经 cdp-solve.sh，见 §1.1） |
| **L4 登录态** | Chromium 只打开**已确定 URL** | fetch-url `--cdp-first`；站内搜索唯一例外 = 经 `/root/.dsh/tools/shop-search.sh` | 禁止 Chromium 手动站内搜索 |
| **L5 批量** | 多平台/多关键词串行 | `/root/.dsh/tools/shop-search.sh` 循环（严守频控）或 MediaCrawler | 禁止并行开多 tab |

## 1. shop-search.sh v2 用法（L0 核心）

```
用法: /root/.dsh/tools/shop-search.sh <platform> <keyword> [page] [--pages N] [--scroll N] [--fresh] [--wait-human N]
      /root/.dsh/tools/shop-search.sh close [platform|all] | status | clear-cooldown <platform>
platform: 1688:desktop（1688 默认桌面版 s.1688.com）| 1688（仅用户明确要求时用，移动版滑块高发）| jd | taobao | tmall | pdd | douyin | cloud[:taobao|xhs]
环境变量: SHOP_CLOUD_SORT=relevance|price_asc|price_desc|sales_desc · SHOP_SEARCH_DEBUG=1
退出码:   0 正常（含如实降级）· 2 频控 · 3 参数错 · 4 基础设施故障 · 5 冷却/needs_human/配额用尽
```

输出 JSON：`{platform, keyword, retrieved_at, login_state, products[], error, channel, evidence, elapsed_s, from_cache?, cached_at?, needs_human?, reason?, tab?, open_in_webui?, cooldown_until?, pages?}`。`login_state` 是平台登录态的唯一权威信号（yes/no/unknown，绝不猜）；`error` 里带降级建议。

- **1688 默认走桌面版通道**（`1688:desktop`，s.1688.com，`--pages N` 翻页）——移动版 m.1688（裸 `1688`，`SHOP_1688_MOBILE=1` 才放行）滑块风控高发（老被 punish 页拦截），**仅用户明确要求时用**；桌面版两次中转页后自动禁用 24h 是工具保护机制，不要试图绕过。
- **--pages N**（1–3）：jd / 1688:desktop 翻页。**一条关键词优先加大页码拿更多结果，禁止用多个关键词变体连续试**（这是触发风控的主因）。
- **--scroll N**：移动版 1688（仅明确要求时）滚动加载次数（默认 4，上限 8）。
- **--fresh** 忽略缓存；**--wait-human N** 在 needs_human 时原地等用户处理（卡片出现即继续）。
- `status` 查看各平台配额用量/冷却/needs_human/可复用标签；`close all` 立即清理本工具的标签。
- 配额（每平台 interval/每小时/每天）：1688 120s/6/30 · 1688:desktop 180s/6/30 · jd 30s/12/60 · taobao/tmall 120s/4/12 · pdd 60s/6/20 · cloud 10s/60/500。同平台同关键词 30 分钟内重复调用直接命中缓存（`from_cache: true`，不消耗配额）。

### 1.1 风控与人机协作协议（强制）

看到 **`needs_human: true`**（或退出码 5 + `error: cooldown: ...`）时：

1. **立即停止该平台的一切调用**——不 sleep 重试、不换关键词变体硬试、不绕道通道。
2. **验证类（reason 含 滑块/验证/punish/x5sec）先 agent 自助**，用 `/root/.dsh/tools/cdp-solve.sh` 接管保留标签：
   a. `cdp-solve.sh list` 找目标 tab → `shot <tab>` 截图（`read_image` 查看；css 坐标 = 截图像素 / scale）；
   b. 标准滑块先 `cdp-solve.sh slider <tab>` 自动尝试；不标准用 `drag <tab> x1 y1 x2 y2`（按截图坐标）或 `click`；
   c. `cdp-solve.sh wait <tab> 20` 确认离开验证页（solved=true）；
   d. 通过后 `shop-search.sh clear-cooldown <platform>` → **重跑同一命令**（不是换关键词）。
   每轮验证自助上限 3 次尝试 / 3 分钟；**点选文字、短信、扫码、登录类（如 pdd 的 login.html 是未登录）不自助**，直接交给用户。
3. 自助失败或非验证类：把 `open_in_webui` 链接（https://192.168.1.220:3001）和 `tab` 告诉用户，请其在 Web UI 里手动完成滑块/登录；可选 `--wait-human 180` 原地等待（工具每 3 秒重采样，卡片出现自动继续提取）。
4. 用户确认处理完后：`shop-search.sh clear-cooldown <platform>`，然后**重跑同一命令**（不是换关键词）。
5. 同平台连续 2 次空结果会自动写 300s 冷却；1688 桌面两次中转页自动禁用 24h——这些都是工具层的保护，不要试图绕过。

## 2. 平台通道基线（以每次返回的 login_state / needs_human 为准）

| 平台 | 通道状态 | 说明 |
|---|---|---|
| 京东 jd | ✓ 稳定 | 登录态实时价（A级）：price=到手价、orig_price=原价、已售/店铺齐全；广告卡已过滤；支持 --pages |
| 1688:desktop | ⚠ 默认通道 | s.1688.com：--pages 1-3 翻页；中转页（soft_block）两次后自动禁用 24h 是工具保护；出滑块/验证先 cdp-solve 自助（§1.1），失败交人 |
| 1688（移动版） | ✗ 已弃用默认 | m.1688.com 滑块风控高发（老被 punish 页拦截）；仅用户明确要求（SHOP_1688_MOBILE=1）时用；需登录态降低风控 |
| 淘宝 taobao | ⚠ 间歇可用 | x5sec 概率性拦截商品列表（登录态本身正常）：成功=A级实时价；被拦时 needs_human/如实报错 → 立即降级 cloud，不要连续重试 |
| 天猫 tmall | ⚠ 间歇可用 | 同淘宝通道（结果并入 s.taobao.com） |
| 拼多多 pdd | ✗ 未登录 | login.html 判 needs_human；提示用户在 Web UI（https://192.168.1.220:3001）登录 |
| 抖音 douyin | ✗ 桌面版无商品搜索 | 工具直接报 unsupported（不开标签页）；改 cloud / MediaCrawler |
| cloud | ✓ 兜底 | Shopme 云库（免 Key）：**仅 taobao / xhs**（tmall 上游已移除），C 级线索 + 交叉验证 |

登录态变化时（用户登录了新平台）直接重跑对应平台即可，工具自动检测。

## 3. 比价标准工作流

1. **关键词规范化**：品类 + 款式 + 材质/规格，去营销词（「爆款」「ins同款」）。
2. **先查账本**：`ledger search '<关键词>'`，已有且未过期的平台直接复用（标「账本历史 + retrieved_at」），只补缺。
2. **多平台搜索**：`/root/.dsh/tools/shop-search.sh` 逐平台串行（已登录平台优先：jd → 1688 → taobao/tmall；每个间隔 ≥30s）。
3. **cloud 交叉验证**：`/root/.dsh/tools/shop-search.sh cloud <kw>`，核对价格量级（只当 C 级线索）。4. **同款判定**：标题/主图/规格匹配；不确定标「疑似同款」。
5. **输出比价表**（固定列）：平台 | 商品（短标题）| 价格 | 店铺 | 链接 | 检索时间 | 证据等级。
6. **券/满减/会员价**：页面明确展示的单独列出（`orig_price` vs `price` 即官方直降/到手价）。
7. **异常低价**（明显低于主流价）加风险提示。
8. **结论与建议**。
9. 表末固定附：「以上为检索时点价格快照，实时变动，下单前以页面实价为准。」
10. **多平台（≥2）比价用流水线模板** `/root/.dsh/skills/nas-shop/workflows/price-compare.md`（规范化 → 并行采集 ledger/cloud/jd/1688 → 成表；CDP 锁天然串行，遇 needs_human 立即上抛）；API 速查见 nas-core 附录 A。

## 4. 找货源/平替工作流（1688）

1. 从用户给的链接/图/关键词拿到零售商品（链接用 `fetch-url --cdp-first` 读）。
2. **关键词拆解**：品类词 + 核心特征，去品牌词/店铺词/营销词。
3. **先 `ledger search '<关键词>' --table offers`**（历史价格/MOQ/复购率/公司档案都在账本里；offer 详情用 `ledger offer <id>`、公司用 `ledger company`）—— '<关键词>'`（第 4 阶段上线；当前先查历史结果缓存与既往会话产物，避免重复抓取）→ 再用**一条规范化关键词** `/root/.dsh/tools/shop-search.sh 1688:desktop '<拆解后的关键词>' --pages 2`（拿更多结果靠加大页码，不靠换词重搜）→ 详情页用 `fetch-url --cdp-first https://detail.1688.com/offer/<id>.html`（详情页未被风控，是安全通道）。
4. 按 **MOQ（起订量）、阶梯价、回头率、销量** 筛选（返回字段已含 moq 与回头率）。
5. **成分对比（成分宣称类商品必做）**：拿到双方成分表后 → `cosdata analyze` 各自解析（中文表直接分析，无需翻译）→ 对齐功能与风险标注（⚠ 致痘/致敏/EU 禁限用）→ 再下平替结论；成分不对齐时如实写「成分不对齐，非严格平替」。证据等级：cosdata 解析 = B 级，商品详情页/备案成分表（登录态读取）= A 级。
6. **输出价差表**：零售价 vs 1688 批发价，标注 MOQ 与混批规则。
7. 经验值提示：零售价通常为批发价 2–3 倍；询问是否需要一件代发选项。
8. 同款判定不确定时必须写「疑似同厂/同款（D 级推断）」。
9. 原料价格地板法（可选加强）：1688 搜「成分 INCI 名 + 原料」拿每公斤报价，反推成品概念性添加（如 ¥1–7 挂牌「二裂酵母精华」≈ 概念性添加）。

## 5. 价格证据等级（强制标注）

完整等级表与表述规则见 **nas-core §3**。电商侧要点：

- **S 级** 品牌官方渠道（官网/官方旗舰店页）明确标价 → 基准价。
- **A 级** 登录态实时读取的平台搜索页/商品页价格（**必须带检索时间戳**）→ 实时价核心依据。
- **C 级** Shopme cloud 缓存价（时间未知）、搜索引擎摘要、比价站快照 → 只能当线索，必须标「缓存价」。
- **D 级** 推断（「疑似同款」「大概能砍到」）→ 必须标「推断」。

铁律：cloud 缓存价永远 C 级，禁止与登录态实时价混列同一证据等级；每条价格标注「检索时间 + 通道 + 证据等级」。`from_cache: true` 的结果沿用原通道等级（A 级登录态读取仍是 A 级），但比价表「检索时间」列必须填 `cached_at`。

## 6. 配额与标签页规则

- **标签按平台复用**：工具为每平台保留一个购物标签（状态文件 /tmp/shop-search/tab-<platform>.json），连续搜索在同一标签内导航；空闲 5 分钟（SHOP_TAB_TTL）自动关闭；可复用标签总数上限 2；`close all` 立即清理。
- **needs_human 的标签优先由 agent 经 cdp-solve 自助处理**（只操作该标签；不参与 TTL 清扫与 close all）；自助失败保留给用户处理，处理完 `clear-cooldown` 后原标签可复用。
- 每平台配额与最小间隔由工具强制（见 §1 配额表；status 可查用量）；缓存命中不消耗配额。
- 批量需求 = 串行循环（平台间可连续，同平台等间隔/配额）；普通任务同时最多 2–4 个临时页面。
- Chromium 配额（CPU 4 核 / RAM 6 GiB / 核显直通）不得改动。
- 禁止：导出/上传/输出 Cookie；申请新付费 API Key；修改 SearXNG/MediaCrawler/Chromium/Agent-Reach 部署；返利导流；虚构「全网最低价」；代用户下单；采集支付信息。

## 7. 与 nas-search / cosdata 的分工

| 需求 | 技能 |
|---|---|
| 商品搜索、比价、找货源、批发价、找平替 | **nas-shop**（本技能） |
| 通用搜索、深度调查、评测口碑深调、平台内容批量采集、URL 阅读 | **nas-search** |
| 成分分析/成分表/INCI/这个成分是什么/有没有风险/成分对比 | **cosdata**（`/root/01/cosdata/cosdata`，本地零网络毫秒级，B 级；中文表直接 `analyze` 无需翻译）——第一站，上网只做补充 |
| 两者都需要时（如「调研这个品类的口碑再比价」） | 先 nas-search 查口碑 → nas-shop 比价（或反之，按任务重心） |

涉及时事/新闻类的价格背景（如「最近显卡为什么涨价」）→ nas-search；具体某型号哪里买便宜 → nas-shop；美妆护肤品的成分平替判定 → nas-shop 比价 + cosdata 成分对比（见第 4 节步骤 5）。
