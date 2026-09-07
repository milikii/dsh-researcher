# price-compare 流水线模板（nas-shop workflows）

**适用条件**：比价/找平替且涉及 **≥2 个平台**。单平台或已查过账本（`ledger search` 新鲜）就单代理处理。
**前置**：关键词规范化（品类 + 核心特征，去营销词）；`ledger search "<关键词>" --table offers` 看历史。
**CDP 注意**：shop-search 的 1688:desktop/jd 通道在 CDP 锁下天然串行；cloud 与 ledger 查询可并行。任何子代理遇 needs_human/quota（退出码 5）**立即返回该状态，不重试**（验证接管由主代理统一用 cdp-solve 做，子代理不碰浏览器）。

## meta

```json
{
  "name": "price-compare-<关键词slug>",
  "description": "Parallel price comparison: ledger/cloud + jd + 1688 collection then fixed-column table",
  "phases": [
    {"title": "规范化"},
    {"title": "采集"},
    {"title": "成表"}
  ]
}
```

## script（全文；args: {"keyword": "...", "cloudSub": "taobao"}）

```js
phase("规范化");
const kw = args.keyword;   // 主代理已规范化：品类+核心特征，去品牌词/营销词
log("关键词: " + kw);

phase("采集");
const raw = await parallel([
  () => agent(
    `查历史：bash 运行 /usr/local/bin/ledger search "${kw}" --table offers --json 与 ledger search "${kw}" --table pages --json。` +
    `输出一行 JSON：{"channel":"ledger","offers":[...前10条{platform,title,price_raw,repeat_rate,shop_age,retrieved_at,evidence}]}` +
    `{"fresh":true|false}（最近 7 天内有记录则 fresh=true）。不写其他文字。`,
    { label: "ledger", phase: "采集" }),
  () => agent(
    `云库兜底：bash 运行 /root/.dsh/tools/shop-search.sh cloud:${args.cloudSub || "taobao"} "${kw}"。` +
    `输出一行 JSON：{"channel":"cloud","products":<原样 products 数组>,"error":...}。C 级缓存价。不写其他文字。`,
    { label: "cloud", phase: "采集" }),
  () => agent(
    `京东实时：bash 运行 /root/.dsh/tools/shop-search.sh jd "${kw}"（超时传 timeoutMs 120000）。` +
    `输出一行 JSON：{"channel":"jd","login_state":...,"products":<原样>,"error":...,"needs_human":...}。` +
    `退出码 5 或 needs_human=true 时原样返回该状态字段，禁止重试。不写其他文字。`,
    { label: "jd", phase: "采集" }),
  () => agent(
    `1688 货源：bash 运行 /root/.dsh/tools/shop-search.sh 1688:desktop "${kw}" --pages 2（超时传 timeoutMs 180000）。` +
    `输出一行 JSON：{"channel":"1688","login_state":...,"products":<原样>,"error":...,"needs_human":...}。` +
    `退出码 5 或 needs_human=true 时原样返回该状态字段，禁止重试、禁止换关键词。不写其他文字。`,
    { label: "1688", phase: "采集" }),
]);

phase("成表");
// null-safe：子代理可能返回非 JSON 文本（实测会带 markdown 围栏），逐个解析
const collected = raw.map((r) => {
  if (r === null || r === undefined) return null;
  if (typeof r === "object") return r;
  const s = String(r).replace(/```json|```/g, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : { channel: "raw", raw: s.slice(0, 400) }; }
  catch (e) { return { channel: "raw", raw: s.slice(0, 400) }; }
}).filter(Boolean);
const table = await agent(
  `读以下比价 JSON，生成比价表：固定列 平台|商品(短标题)|价格|店铺|链接|检索时间|证据等级。` +
  `规则（nas-shop §5）：缓存价/cloud=C 级且与 A 级分列；ledger 历史标「账本历史 retrieved_at」；` +
  `1688 行附 复购率/店龄/MOQ；表末固定免责行「以上为检索时点价格快照，实时变动，下单前以页面实价为准。」；` +
  `汇总 needs_human 状态（如有，写平台与 open_in_webui 链接）。\n${JSON.stringify(collected)}`,
  { label: "table", phase: "成表" });
return { channels: collected.map(c => (c && c.channel) ? c.channel : "unknown"),
         needs_human: collected.some(c => c && c.needs_human), table };
```

（子代理输出务必要求「只输出一行 JSON、不要 markdown 代码块」；聚合端仍做 null-safe 解析——实测子代理偶尔会带 ``` 围栏。）

## 子代理提示词契约

- 每个子代理**只跑一条命令**，输出一行原样 JSON；不重试（工具自身的配额/冷却/缓存已内建）。
- needs_human / quota（退出码 5）：原样带回状态字段；验证类 needs_human 主代理先用 cdp-solve 自助（nas-shop §1.1，≤3 次），失败才转述给用户（open_in_webui 链接 + tab id）。

## 失败处理

- 某通道失败/null：其余通道照常成表，表格注明「X 通道本轮不可用（原因）」。
- 1688 needs_human：表格照常（用 ledger/cloud 数据）；主代理先按 nas-shop §1.1 用 cdp-solve 自助（≤3 次），失败再把 Web UI 链接和标签告诉用户，等 `clear-cooldown` 后重跑该通道。
- 全通道失败：返回空 channels，回退单代理诊断（`nas-stack-status.sh`）。
