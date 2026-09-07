/*
 * Node half of @dsh-local/web-search-exa-settings: the Exa search provider
 * wired into the `ctx.web` seam, plus the `web-search-exa` settings section.
 *
 * The official @deepseek-ai/dsh-web-search-exa package registers only the
 * provider (options fixed at boot from the patch or $EXA_API_KEY). This half
 * additionally installs a settings namespace so the browser card (lib/client.js)
 * can edit apiKey / baseURL / searchType / numResults / highlightsPerResult,
 * and re-resolves options on every search so GUI edits hot-apply.
 */

import { ExaSearchProvider } from '@deepseek-ai/dsh-web-search-exa'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace carrying the provider's options (GUI card section). */
const EXA_SETTINGS_NAMESPACE = settingsNamespace('web-search-exa')

const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'
const EXA_DEFAULT_SEARCH_TYPE = 'auto'
const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1

/**
 * Same schema as the official package (apiKey falls back to $EXA_API_KEY).
 * Plain string, matching upstream: the settings describe round-trips the
 * value so the browser card can show/reset the override; the card renders it
 * in a password input.
 */
const Config = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  searchType: z.union(['auto', 'keyword', 'neural']),
  numResults: z.number().step(1).min(1),
  highlightsPerResult: z.number().step(1).min(1),
})

/**
 * Project one resolved settings section into the options the provider serves
 * its next search with. Env fallback stays here rather than in the provider.
 */
function resolveOptions(ctx, config) {
  const literalApiKey =
    config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    apiKey: literalApiKey ?? launchEnvironmentOf(ctx).get('EXA_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
    highlightsPerResult: config.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }
}

/**
 * The official provider captures its options once at construction. This
 * subclass refreshes them on every availability check and search, so settings
 * edits hot-apply without re-registering the provider.
 */
class DynamicExaSearchProvider extends ExaSearchProvider {
  #resolve

  constructor(resolve) {
    super({})
    this.#resolve = resolve
  }

  available() {
    this.options = this.#resolve()
    return super.available()
  }

  async search(request, signal) {
    this.options = this.#resolve()
    return super.search(request, signal)
  }
}

/** Mount the settings section and register the Exa provider with `ctx.web`. */
export function apply(ctx, config) {
  let current = () => config
  installSettingsSection(ctx, EXA_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(
    new DynamicExaSearchProvider(() => resolveOptions(ctx, current()))
  )
}