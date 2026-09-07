/**
 * `@dsh-local/web-search-searxng`: registers a SearXNG-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-web-search-exa`
 * registers an adapter into `ctx.web`.
 *
 * The provider queries the self-hosted SearXNG JSON API (`GET /search?format=json`),
 * mapping `results[]` to the seam's normalized source shape. Entries without a
 * non-blank `content` snippet are dropped (the seam has no other field to
 * derive a snippet from).
 *
 * Routing / filtering / dedupe / operator parsing live in `lib/core.js` (pure,
 * dependency-free); this module only does HTTP + assembly:
 *   · inline operators `lang:`/`engines:`/`fresh:`/`pageno:` are stripped from
 *     the query and routed to SearXNG parameters (`language`, `engines`,
 *     `time_range`, `pageno`, `categories=general`); automatic CJK-based
 *     language/engine routing applies otherwise;
 *   · junk domains are filtered, results deduplicated by canonical URL and
 *     decorated with an `(engine · date)` snippet tag;
 *   · if page 1 yields fewer than `numResults` (nonzero), one more page
 *     (`pageno+1`) is fetched — at most 2 pages — then merged and truncated;
 *   · a request whose `engines` param returns 0 results while
 *     `unresponsive_engines` is non-empty is retried exactly once without the
 *     `engines` param (SearXNG default engines).
 *
 * @module @dsh-local/web-search-searxng
 */

import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
import { dedupe, decorate, isJunk, parseQuery, routeQuery } from "./core.js";

/** Stable id this provider registers under. */
const SEARXNG_PROVIDER_ID = "searxng";

/** Default SearXNG endpoint (host port of the NAS deployment). */
const SEARXNG_DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/** Attribution header sent on every request. */
const USER_AGENT = "deepseek-harness/0.0.1";

/** Default number of results per search call (config `numResults` overrides). */
const DEFAULT_NUM_RESULTS = 20;

/**
 * Map one SearXNG result to a normalized source, or `undefined` when it
 * carries no portable snippet (decorated `snippet` wins over raw `content`).
 */
function mapSearxngResult(result) {
	const snippet = ((result.snippet ?? result.content) ?? "").trim();
	if (snippet.length === 0) return void 0;
	return {
		url: result.url,
		...result.title != null && result.title.length > 0 ? { title: result.title } : {},
		snippet,
		...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {}
	};
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
class SearxngSearchProvider {
	options;
	id = SEARXNG_PROVIDER_ID;
	constructor(options) {
		this.options = options;
	}
	available() {
		return this.options.baseURL.length > 0 && URL.canParse(this.options.baseURL);
	}
	async search(request, signal) {
		const numResults = this.options.numResults ?? DEFAULT_NUM_RESULTS;
		const junkDomains = this.options.junkDomains ?? [];
		const parsed = parseQuery(String(request.query ?? ""));
		const routed = routeQuery(parsed);
		const enginesLabel = routed.engines.join(",");
		const pageno = parsed.pageno ?? 1;

		/** Assemble a SearXNG JSON API URL for one page. */
		const assemble = (page, includeEngines) => {
			const url = new URL(`${this.options.baseURL}/search`);
			url.searchParams.set("q", parsed.query);
			url.searchParams.set("format", "json");
			url.searchParams.set("safesearch", "0");
			url.searchParams.set("language", routed.language);
			if (includeEngines && routed.engines.length > 0) {
				url.searchParams.set("engines", routed.engines.join(","));
			}
			if (routed.timeRange !== void 0) url.searchParams.set("time_range", routed.timeRange);
			url.searchParams.set("pageno", String(page));
			url.searchParams.set("categories", "general");
			return url;
		};

		// Page 1; zero-result fallback: 0 hits + unresponsive engines → retry once
		// without the engines param (SearXNG default engines).
		let pageResp = await this.fetchJson(assemble(pageno, true), signal);
		let includeEngines = true;
		if (pageResp.results?.length === 0
			&& Array.isArray(pageResp.unresponsive_engines)
			&& pageResp.unresponsive_engines.length > 0) {
			pageResp = await this.fetchJson(assemble(pageno, false), signal);
			includeEngines = false;
		}
		let raw = pageResp.results ?? [];
		let cleaned = this.cleanRaw(raw, enginesLabel, junkDomains);
		// Second page (at most 2 pages total) when page 1 came up short; a page-2
		// failure keeps the page-1 results instead of degrading the whole call.
		if (cleaned.length < numResults && cleaned.length > 0) {
			try {
				const page2 = await this.fetchJson(assemble(pageno + 1, includeEngines), signal);
				raw = raw.concat(page2.results ?? []);
			} catch {
				// page 2 is best-effort; keep whatever page 1 produced
			}
		}
		const sources = this.cleanRaw(raw, enginesLabel, junkDomains)
			.slice(0, numResults)
			.map(mapSearxngResult)
			.filter((source) => source !== void 0);
		return { sources, truncated: false };
	}
	/** Filter junk domains and snippet-less hits, dedupe, decorate. */
	cleanRaw(raw, enginesLabel, junkDomains) {
		const kept = raw
			.filter((result) => !isJunk(result?.url ?? "", result?.title ?? "", junkDomains))
			.filter((result) => (result?.content ?? "").trim().length > 0);
		return dedupe(kept).map((result) => decorate(result, enginesLabel));
	}
	/** GET one SearXNG JSON envelope; redirects/errors/aborts map to WebError. */
	async fetchJson(url, signal) {
		let response;
		try {
			response = await fetch(url, {
				redirect: "error",
				headers: {
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (isAbortError(error)) throw new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`SearXNG search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			throw new WebError(`SearXNG error (HTTP ${response.status})`, "WEB_PROVIDER_ERROR");
		}
		try {
			return await response.json();
		} catch (error) {
			if (isAbortError(error)) throw new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL) {
	return URL.canParse(baseURL);
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-searxng";

/** The web seam this provider registers into. */
const inject = ["web"];

const Config = z.object({
	baseURL: z.string(),
	numResults: z.number().step(1).min(1).default(DEFAULT_NUM_RESULTS),
	junkDomains: z.array(z.string()).default([])
});

/** Register the SearXNG search provider with `ctx.web`. */
function apply(ctx, config) {
	ctx.web.registerSearchProvider(new SearxngSearchProvider({
		baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get("SEARXNG_BASE_URL")?.value ?? SEARXNG_DEFAULT_BASE_URL,
		...config.numResults !== void 0 ? { numResults: config.numResults } : {},
		...config.junkDomains !== void 0 ? { junkDomains: config.junkDomains } : {}
	}));
}

export {
	Config,
	SEARXNG_DEFAULT_BASE_URL,
	SEARXNG_PROVIDER_ID,
	SearxngSearchProvider,
	apply,
	inject,
	name
};