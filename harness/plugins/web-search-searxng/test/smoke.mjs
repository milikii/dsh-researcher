/**
 * smoke.mjs — web-search-searxng 核心逻辑冒烟测试（只 import ../lib/core.js）。
 *
 * 覆盖：
 *  · parseQuery 内联操作符剥离（lang:/engines:/fresh:）
 *  · routeQuery 自动语言/引擎路由（CJK → zh-CN + bing）
 *  · isJunk 默认黑名单
 *  · canonicalUrl 跟踪参数清理
 *  · 真实 SearXNG 请求：用 core 的参数组装逻辑对中文查询拉 2 页（engines=bing），
 *    过滤去重后 count>=15（若第 2 页为空，允许 >=10 并标 page2_empty=true）、junk=0。
 *
 * 运行：node /root/.dsh/plugins/web-search-searxng/test/smoke.mjs
 * 退出码 0 = 全部通过。输出单个 JSON 对象。
 */

import { parseQuery, routeQuery, isJunk, canonicalUrl, dedupe } from "../lib/core.js";

const SEARXNG = "http://127.0.0.1:8080";
const checks = [];

function record(name, ok, detail) {
	checks.push({ name, ok, detail });
}

// ── 1. parseQuery ────────────────────────────────────────────────────────────
{
	const p = parseQuery("DITO wifi calling lang:en engines:brave fresh:week");
	record("parseQuery lang", p.lang === "en", p.lang);
	record("parseQuery engines", JSON.stringify(p.engines) === '["brave"]', JSON.stringify(p.engines));
	record("parseQuery fresh", p.fresh === "week", p.fresh);
	record("parseQuery query", p.query === "DITO wifi calling", p.query);
}

// ── 2. routeQuery ────────────────────────────────────────────────────────────
{
	const zh = routeQuery(parseQuery("欧莱雅黑精华 成分表"));
	const en = routeQuery(parseQuery("openai pricing"));
	record("routeQuery 中文 → zh-CN", zh.language === "zh-CN", zh.language);
	record("routeQuery 中文 engines 含 bing", zh.engines.includes("bing"), JSON.stringify(zh.engines));
	record("routeQuery 英文 → en", en.language === "en", en.language);
	const siteEn = routeQuery(parseQuery("deepspeed vs vllm site:reddit.com"));
	record("routeQuery site: 英文 → brave/duckduckgo/bing",
		JSON.stringify(siteEn.engines) === JSON.stringify(["brave", "duckduckgo", "bing"]),
		JSON.stringify(siteEn.engines));
	const siteZh = routeQuery(parseQuery("黑精华 成分 site:zhihu.com"));
	record("routeQuery site: 中文 → sogou/baidu/bing",
		JSON.stringify(siteZh.engines) === JSON.stringify(["sogou", "baidu", "bing"]),
		JSON.stringify(siteZh.engines));
	const siteOverride = routeQuery(parseQuery("x site:a.com engines:brave"));
	record("routeQuery site: + 显式 engines: 不被覆盖",
		JSON.stringify(siteOverride.engines) === JSON.stringify(["brave"]),
		JSON.stringify(siteOverride.engines));
}

// ── 3. isJunk ────────────────────────────────────────────────────────────────
{
	record("isJunk microsoft", isJunk("https://www.microsoft.com/en-us?msockid=1") === true,
		String(isJunk("https://www.microsoft.com/en-us?msockid=1")));
	record("isJunk guidechem", isJunk("https://china.guidechem.com/x.html") === false,
		String(isJunk("https://china.guidechem.com/x.html")));
}

// ── 4. canonicalUrl ──────────────────────────────────────────────────────────
{
	const got = canonicalUrl("https://a.com/p?msockid=1&x=2#f");
	record("canonicalUrl 去跟踪参数", got === "https://a.com/p?x=2", got);
}

// ── 5. 真实 SearXNG 请求（2 页，engines=bing） ────────────────────────────────
const LIVE_QUERY = "欧莱雅黑精华 成分表";

// 与 lib/index.js 一致的参数组装逻辑（此处只依赖 core 的输出）
function buildUrl(pageno) {
	const routed = routeQuery(parseQuery(LIVE_QUERY));
	const url = new URL(`${SEARXNG}/search`);
	url.searchParams.set("q", LIVE_QUERY);
	url.searchParams.set("format", "json");
	url.searchParams.set("safesearch", "0");
	url.searchParams.set("language", routed.language);
	url.searchParams.set("engines", "bing");
	url.searchParams.set("pageno", String(pageno));
	url.searchParams.set("categories", "general");
	return url;
}

let page1 = [];
let page2 = [];
let liveError = null;
try {
	page1 = (await (await fetch(buildUrl(1))).json()).results ?? [];
	page2 = (await (await fetch(buildUrl(2))).json()).results ?? [];
} catch (e) {
	liveError = String(e);
}
const page2Empty = liveError === null && page2.length === 0;
const rawHits = liveError === null ? [...page1, ...page2] : [];
const filteredHits = liveError === null
	? dedupe(rawHits.filter((r) => !isJunk(r.url ?? "", r.title ?? "")))
	: [];
const junkCount = liveError === null ? rawHits.filter((r) => isJunk(r.url ?? "", r.title ?? "")).length : -1;
const threshold = page2Empty ? 10 : 15;
const countOk = liveError === null && filteredHits.length >= threshold;
record("live 请求无异常", liveError === null, liveError ?? "ok");
record(`live 过滤去重后 count>=${threshold}`, countOk,
	`count=${filteredHits.length} page1=${page1.length} page2=${page2.length}`);
record("live junk=0", junkCount === 0, `junk=${junkCount}`);
record("live page2_empty 标记", page2Empty === (page2.length === 0), `page2_empty=${page2Empty}`);

const allPass = checks.every((c) => c.ok);
const out = {
	ok: allPass,
	checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })),
	live: {
		query: LIVE_QUERY,
		engines: "bing",
		language: routeQuery(parseQuery(LIVE_QUERY)).language,
		page1_count: page1.length,
		page2_count: page2.length,
		page2_empty: page2Empty,
		filtered_count: filteredHits.length,
		junk: junkCount,
		error: liveError,
	}
};
console.log(JSON.stringify(out, null, 2));
process.exit(allPass ? 0 : 1);