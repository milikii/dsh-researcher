# deep-research 流水线模板（nas-search workflows）

**适用条件**：用户要「调查/研究/多平台/最近真实评价」且涉及 **≥3 个平台或 ≥8 个 URL**。不满足就用单代理 + nas-search 路由。
**前置**：先 `ledger search "<主题>"`（历史直接复用）；`nas-stack-status.sh` 确认引擎健康。

## meta（填进 workflow 工具的 meta 参数）

```json
{
  "name": "deep-research-<主题slug>",
  "description": "Parallel deep research: cluster fan-out collection then synthesis with evidence grading",
  "phases": [
    {"title": "规划"},
    {"title": "采集"},
    {"title": "综合", "model": "any/claude-opus-5"}
  ]
}
```

（`model` 覆盖是**可选**的：默认全部走 deepseek-v4-flash；综合阶段可换更强模型，如 `any/claude-opus-5`、`agent/gpt-5.6-sol`。）

## script（全文；`<CLUSTERS>` 换成 2–4 个查询簇数组）

```js
phase("规划");
// 主代理（你）在调用前已把问题拆成 clusters；每个 {name, queries[], platforms[]}
const clusters = args.clusters;

phase("采集");
const outs = await parallel(clusters.map((c, i) => () =>
  agent(
    `你是采集子代理 ${c.name}。只做采集，不写长文。硬预算：最多 8 次工具调用、总时长 10 分钟，超限立即收尾。` +
    `查询簇：${JSON.stringify(c.queries)}。允许工具：web_search（SearXNG，操作符 lang:/engines:/fresh:）、` +
    `/usr/local/bin/fetch-url（带 --budget 60）${c.platforms && c.platforms.length ? "、" + c.platforms.join("、") : ""}。` +
    `停止条件：每个查询至少 3 个来源或预算耗尽。输出一行 JSON：` +
    `{"cluster":"${c.name}","sources":[{"url","title","retrieved_at","method","evidence","excerpt(≤600字)"}],` +
    `"claims":[{"text","evidence","source_urls":[]}],"gaps":[]}。不要输出其他文字。`,
    { label: c.name, phase: "采集" }));

phase("综合");
const collected = outs.filter(Boolean);
const report = await agent(
  `读以下采集 JSON，按 nas-search 报告模板产出结构化报告（结论/已确认事实(S,A)/高可信用户证据/未证实信息(C,D)/推断/证据来源），` +
  `每条关键结论带 URL 与证据等级；冲突来源并列不选边：\n${JSON.stringify(collected)}`,
  { label: "synthesis", phase: "综合" });
return { clusters: collected.length, sources: collected.reduce((n, c) => n + (c.sources || []).length, 0), report };
```

## 调用方式（workflow 工具）

`meta` = 上面的 JSON；`script` = 上面全文（clusters 从 args 读）；`args` = `{"clusters": [{"name": "官方与媒体", "queries": ["..."], "platforms": []}, ...]}`。

## 子代理提示词契约

- 只用 web_search + fetch-url（--budget 60）+ 允许的平台工具；≤300 字指令；硬预算 8 次调用 / 10 分钟。
- 输出**只有一行 JSON**（cluster/sources/claims/gaps）；不写自然语言长文。
- 证据等级按 nas-core §3；快照 ≠ 原文。

## 失败处理

- 子代理失败（返回 null）：`filter(Boolean)` 后继续；某簇全失败在最终 return 里如实减少 clusters 数，主代理转述时说明。
- 全部失败：workflow 正常返回 0 clusters，主代理回退单代理模式。
- fetch-url `error=cdp lock timeout`（锁等待 240s 超时）：说明 CDP 通道忙，让该子代理改用 web_search 摘要并降级标注 C 级。
- 需求变更：不重跑整个流水线，只对缺的簇单独补采。
