/**
 * `@dsh-local/web-search-searxng` core: pure, dependency-free helpers for
 * query operator parsing, engine routing, junk filtering, canonical dedupe and
 * snippet decoration. Provider code (`index.js`) only does HTTP + assembly.
 *
 * @module @dsh-local/web-search-searxng/core
 */

/** Default junk domains, host-suffixed; config `junkDomains` appends more. */
const DEFAULT_JUNK_DOMAINS = [
	"microsoft.com",
	"apps.microsoft.com",
	"msn.com",
	"bing.com",
	"live.com",
	"office.com",
	"instagram.com",
	"facebook.com",
	"126.com",
	"mail.163.com",
	"smart.mail.126.com"
];

/** CJK detection used by the automatic language/engine routing. */
const CJK_RE = /[一-鿿぀-ヿ가-힯]/;

/** Inline operator patterns, recognized as whitespace-delimited tokens. */
const OPERATOR_RES = [
	{ name: "lang", re: /^lang:([a-zA-Z-]+)$/ },
	{ name: "engines", re: /^engines:([a-zA-Z0-9_,]+)$/ },
	{ name: "fresh", re: /^fresh:(day|week|month|year)$/ },
	{ name: "pageno", re: /^pageno:(\d+)$/ }
];

/** Default engine lists used by `routeQuery` (auto rules). */
const ZH_ENGINES = ["bing", "sogou", "baidu"];
const EN_ENGINES = ["brave", "bing", "duckduckgo"];
const FRESH_NO_BING_FALLBACK = ["sogou", "brave", "duckduckgo"];
const ZH_SITE_ENGINES = ["sogou", "baidu", "bing"];
const EN_SITE_ENGINES = ["brave", "duckduckgo", "bing"];

/** Tracking query parameters dropped by `canonicalUrl`. */
const TRACKING_PARAMS = new Set(["msockid", "fbclid", "gclid", "spm", "from", "ref", "_t"]);

/**
 * Parse inline operators out of a raw query string; `site:` is preserved.
 * @param {string} raw raw user query (may contain `lang:`/`engines:`/`fresh:`/`pageno:`)
 * @returns {{query: string, lang: string|undefined, engines: string[]|undefined, fresh: string|undefined, pageno: number|undefined}}
 */
export function parseQuery(raw) {
	const tokens = String(raw ?? "").split(/\s+/).filter((t) => t.length > 0);
	const query = [];
	let lang;
	let engines;
	let fresh;
	let pageno;
	for (const token of tokens) {
		let matched = false;
		for (const { name, re } of OPERATOR_RES) {
			const m = token.match(re);
			if (!m) continue;
			matched = true;
			if (name === "lang") lang = m[1];
			else if (name === "engines") engines = m[1].split(",").map((s) => s.trim()).filter(Boolean);
			else if (name === "fresh") fresh = m[1];
			else if (name === "pageno") pageno = Number(m[1]);
			break;
		}
		if (!matched) query.push(token);
	}
	return { query: query.join(" "), lang, engines, fresh, pageno };
}

/**
 * Route a parsed query to SearXNG language/engines/time_range parameters.
 * @param {{query: string, lang: string|undefined, engines: string[]|undefined, fresh: string|undefined}} parsed output of `parseQuery`
 * @returns {{language: string, engines: string[], timeRange: string|undefined}}
 */
export function routeQuery(parsed) {
	const hasCjk = CJK_RE.test(parsed.query);
	const hasSite = /(^|\s)site:[^\s]+/i.test(parsed.query);
	let engines;
	if (parsed.engines && parsed.engines.length > 0) {
		engines = parsed.engines.slice();
	} else if (hasSite) {
		// SearXNG does not pass `site:` through to bing; route site-queries to
		// engines that handle the operator (user can still override with engines:).
		engines = (hasCjk ? ZH_SITE_ENGINES : EN_SITE_ENGINES).slice();
	} else if (hasCjk) {
		engines = ZH_ENGINES.slice();
	} else {
		engines = EN_ENGINES.slice();
	}
	const language = parsed.lang || (hasCjk ? "zh-CN" : "en");
	let timeRange;
	if (parsed.fresh) {
		timeRange = parsed.fresh;
		const i = engines.indexOf("bing");
		if (i !== -1) engines.splice(i, 1);
		if (engines.length === 0) engines = FRESH_NO_BING_FALLBACK.slice();
	}
	return { language, engines, timeRange };
}

/**
 * Decide whether a search hit is junk (default blacklist domains plus
 * single/double-character Wikipedia entries), optionally extended by config.
 * @param {string} url result URL
 * @param {string} [title] result title (kept for signature symmetry / future rules)
 * @param {string[]} [extraDomains] extra junk domains appended to the default blacklist
 * @returns {boolean} true when the hit should be dropped
 */
export function isJunk(url, title, extraDomains = []) {
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return false;
	}
	const host = u.hostname.toLowerCase();
	const domains = DEFAULT_JUNK_DOMAINS.concat(extraDomains || []);
	for (const d of domains) {
		const domain = d.toLowerCase();
		if (host === domain || host.endsWith("." + domain)) return true;
	}
	return /\/wiki\/[A-Za-z]{1,2}$/.test(u.pathname);
}

/**
 * Strip tracking parameters, fragment and normalization noise to get a dedupe key.
 * @param {string} url raw result URL
 * @returns {string} canonical URL used as the dedupe key
 */
export function canonicalUrl(url) {
	try {
		const u = new URL(String(url));
		u.hash = "";
		for (const key of [...u.searchParams.keys()]) {
			if (TRACKING_PARAMS.has(key) || key.startsWith("utm_")) u.searchParams.delete(key);
		}
		u.hostname = u.hostname.toLowerCase();
		let s = u.toString();
		while (s.endsWith("/") && !s.endsWith("://")) s = s.slice(0, -1);
		return s;
	} catch {
		return String(url);
	}
}

/**
 * Remove duplicate results by canonical URL, keeping the first occurrence.
 * @param {Array<{url: string}>} results raw result objects
 * @returns {Array<{url: string}>} deduplicated results
 */
export function dedupe(results) {
	const seen = new Set();
	const out = [];
	for (const r of results) {
		if (!r || !r.url) continue;
		const key = canonicalUrl(r.url);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}

/**
 * Concatenate multiple result pages in order, then dedupe across pages.
 * @param {Array<Array<{url: string}>>} pages per-page result arrays
 * @returns {Array<{url: string}>} merged, deduplicated results
 */
export function mergePages(pages) {
	return dedupe(pages.flat());
}

/**
 * Prepend an attribution tag `(engine · date)` to a result snippet.
 * @param {{snippet: string, publishedDate?: string, engine?: string|string[]}} result raw SearXNG result
 * @param {string} engine engine label used when the result carries none
 * @returns {{snippet: string}} a shallow copy of the result with the tagged snippet
 */
export function decorate(result, engine) {
	const own = Array.isArray(result.engine) ? result.engine.join(",") : (result.engine || "");
	const label = own || engine || "searxng";
	const date = String(result.publishedDate ?? "").trim().slice(0, 10);
	const tag = date ? `(${label} · ${date})` : `(${label} · no date)`;
	return { ...result, snippet: `${tag} ${result.snippet ?? ""}`.trim() };
}

export {
	DEFAULT_JUNK_DOMAINS,
	CJK_RE
};