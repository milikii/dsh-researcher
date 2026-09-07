/*
 * Node half of @dsh-local/provider-proxy-settings: the provider-proxy capability.
 *
 * Routes SELECTED model providers through an HTTP proxy at the llm/stream
 * waterfall: for a matching provider/model the request is re-issued with
 * curl --proxy instead of the adapter's direct fetch; everything else passes
 * through untouched. Config lives in the `provider-proxy` settings namespace
 * (proxyUrl + per-provider enabled map), which also surfaces the plugin card
 * in Settings → Plugins (可配置).
 *
 * This is the durable, restart-safe replacement of the old session-scoped
 * dynamic plugin (prxy-7 / ppxy-8 / ppxy-9): mounted from the web profile's
 * cordis.patch.yml, it survives `dsh web` restarts.
 */

import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'provider-proxy'

/** Hard dependencies. */
export const inject = ['subprocess']

/** Settings namespace carrying the proxy configuration (GUI card section). */
const NAMESPACE = settingsNamespace('provider-proxy')

const Config = z.object({
  proxyUrl: z.string().default('http://192.168.1.220:7890'),
  enabled: z.dict(z.boolean()).default({ 'opencode-go': true }),
})

// ---------- provider facts (generated from the installed pi-ai catalog) ----------
// Each provider: routes = [{ api, base, keyEnv?, match?|models? }]; match/models are
// model selectors used when a provider has multiple endpoints. Supported wire
// protocols: 'openai-completions' and 'anthropic-messages'.

const PROVIDER_FACTS = {
  "ant-ling": [
    {
      "api": "openai-completions",
      "base": "https://api.ant-ling.com/v1",
      "keyEnv": "ANT_LING_API_KEY"
    }
  ],
  "anthropic": [
    {
      "api": "anthropic-messages",
      "base": "https://api.anthropic.com",
      "keyEnv": "ANTHROPIC_API_KEY"
    }
  ],
  "cerebras": [
    {
      "api": "openai-completions",
      "base": "https://api.cerebras.ai/v1",
      "keyEnv": "CEREBRAS_API_KEY"
    }
  ],
  "cloudflare-ai-gateway": [
    {
      "api": "openai-completions",
      "base": "https://gateway.ai.cloudflare.com/v1",
      "keyEnv": "CLOUDFLARE_API_KEY"
    },
    {
      "api": "anthropic-messages",
      "base": "https://gateway.ai.cloudflare.com/v1",
      "keyEnv": "CLOUDFLARE_API_KEY",
      "match": [
        "^claude"
      ]
    }
  ],
  "cloudflare-workers-ai": [
    {
      "api": "openai-completions",
      "base": "https://api.cloudflare.com/client/v4/accounts/REPLACE_ACCOUNT/ai/v1",
      "keyEnv": "CLOUDFLARE_API_KEY"
    }
  ],
  "deepseek": [
    {
      "api": "openai-completions",
      "base": "https://api.deepseek.com",
      "keyEnv": "DEEPSEEK_API_KEY"
    }
  ],
  "fireworks": [
    {
      "api": "anthropic-messages",
      "base": "https://api.fireworks.ai/anthropic",
      "keyEnv": "FIREWORKS_API_KEY",
      "models": [
        "accounts/fireworks/models/deepseek-v3.1-250828"
      ]
    },
    {
      "api": "openai-completions",
      "base": "https://api.fireworks.ai/inference",
      "keyEnv": "FIREWORKS_API_KEY",
      "models": [
        "accounts/fireworks/models/deepseek-v3.1-250828"
      ]
    }
  ],
  "github-copilot": [
    {
      "api": "anthropic-messages",
      "base": "https://api.individual.githubcopilot.com",
      "keyEnv": "COPILOT_API_KEY",
      "models": [
        "claude-opus-4-1-20250801",
        "claude-sonnet-4-5-20250929"
      ]
    },
    {
      "api": "openai-completions",
      "base": "https://api.individual.githubcopilot.com",
      "keyEnv": "COPILOT_API_KEY",
      "models": [
        "claude-opus-4-1-20250801",
        "claude-sonnet-4-5-20250929"
      ]
    }
  ],
  "groq": [
    {
      "api": "openai-completions",
      "base": "https://api.groq.com/openai/v1",
      "keyEnv": "GROQ_API_KEY"
    }
  ],
  "huggingface": [
    {
      "api": "openai-completions",
      "base": "https://router.huggingface.co/v1",
      "keyEnv": "HF_TOKEN"
    }
  ],
  "kimi-coding": [
    {
      "api": "openai-completions",
      "base": "https://api.kimi.com/coding",
      "keyEnv": "KIMI_API_KEY",
      "match": [
        "^kimi"
      ]
    }
  ],
  "minimax": [
    {
      "api": "anthropic-messages",
      "base": "https://api.minimax.io/anthropic",
      "keyEnv": "MINIMAX_API_KEY"
    }
  ],
  "minimax-cn": [
    {
      "api": "anthropic-messages",
      "base": "https://api.minimaxi.com/anthropic",
      "keyEnv": "MINIMAX_CN_API_KEY"
    }
  ],
  "mistral": [
    {
      "api": "openai-completions",
      "base": "https://api.mistral.ai",
      "keyEnv": "MISTRAL_API_KEY"
    }
  ],
  "moonshotai": [
    {
      "api": "openai-completions",
      "base": "https://api.moonshot.ai/v1",
      "keyEnv": "MOONSHOT_API_KEY"
    }
  ],
  "moonshotai-cn": [
    {
      "api": "openai-completions",
      "base": "https://api.moonshot.cn/v1",
      "keyEnv": "MOONSHOT_API_KEY"
    }
  ],
  "nvidia": [
    {
      "api": "openai-completions",
      "base": "https://integrate.api.nvidia.com/v1",
      "keyEnv": "NVIDIA_API_KEY"
    }
  ],
  "openai": [
    {
      "api": "openai-completions",
      "base": "https://api.openai.com/v1",
      "keyEnv": "OPENAI_API_KEY"
    }
  ],
  "opencode": [
    {
      "api": "anthropic-messages",
      "base": "https://opencode.ai/zen",
      "keyEnv": "OPENCODE_API_KEY",
      "match": [
        "^claude",
        "^qwen3"
      ]
    },
    {
      "api": "openai-completions",
      "base": "https://opencode.ai/zen/v1",
      "keyEnv": "OPENCODE_API_KEY",
      "match": [
        "^big",
        "^deepseek",
        "^glm",
        "^grok",
        "^kimi",
        "^laguna",
        "^ling",
        "^mimo",
        "^minimax",
        "^nemotron",
        "^north"
      ]
    }
  ],
  "opencode-go": [
    {
      "api": "anthropic-messages",
      "base": "https://opencode.ai/zen/go",
      "keyEnv": "OPENCODE_API_KEY",
      "models": [
        "minimax-m3",
        "qwen3.7-max",
        "qwen3.7-plus"
      ]
    },
    {
      "api": "openai-completions",
      "base": "https://opencode.ai/zen/go/v1",
      "keyEnv": "OPENCODE_API_KEY",
      "match": [
        "^deepseek",
        "^glm",
        "^hy3",
        "^kimi",
        "^mimo"
      ]
    }
  ],
  "openrouter": [
    {
      "api": "openai-completions",
      "base": "https://openrouter.ai/api/v1",
      "keyEnv": "OPENROUTER_API_KEY"
    }
  ],
  "qwen-token-plan": [
    {
      "api": "openai-completions",
      "base": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "keyEnv": "QWEN_TOKEN_PLAN_API_KEY"
    }
  ],
  "qwen-token-plan-cn": [
    {
      "api": "openai-completions",
      "base": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "keyEnv": "QWEN_TOKEN_PLAN_CN_API_KEY"
    }
  ],
  "radius": [
    {
      "api": "openai-completions",
      "base": "https://api.radius.cisco.com/v1",
      "keyEnv": "RADIUS_API_KEY"
    }
  ],
  "together": [
    {
      "api": "openai-completions",
      "base": "https://api.together.ai/v1",
      "keyEnv": "TOGETHER_API_KEY"
    }
  ],
  "vercel-ai-gateway": [
    {
      "api": "openai-completions",
      "base": "https://ai-gateway.vercel.sh",
      "keyEnv": "AI_GATEWAY_API_KEY"
    }
  ],
  "xai": [
    {
      "api": "openai-completions",
      "base": "https://api.x.ai/v1",
      "keyEnv": "XAI_API_KEY"
    }
  ],
  "xiaomi": [
    {
      "api": "openai-completions",
      "base": "https://api.xiaomi.com/v1",
      "keyEnv": "XIAOMI_API_KEY"
    }
  ],
  "xiaomi-token-plan-ams": [
    {
      "api": "openai-completions",
      "base": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "keyEnv": "XIAOMI_TOKEN_PLAN_AMS_API_KEY"
    }
  ],
  "xiaomi-token-plan-cn": [
    {
      "api": "openai-completions",
      "base": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "keyEnv": "XIAOMI_TOKEN_PLAN_CN_API_KEY"
    }
  ],
  "xiaomi-token-plan-sgp": [
    {
      "api": "openai-completions",
      "base": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "keyEnv": "XIAOMI_TOKEN_PLAN_SGP_API_KEY"
    }
  ],
  "zai": [
    {
      "api": "openai-completions",
      "base": "https://api.z.ai/api/paas/v4",
      "keyEnv": "ZAI_API_KEY"
    }
  ],
  "zai-coding-cn": [
    {
      "api": "openai-completions",
      "base": "https://api.z.ai/coding",
      "keyEnv": "ZAI_CODING_CN_API_KEY"
    }
  ]
}

// ---------- live configuration ----------

/** Active proxy configuration; refreshed from the settings section on change. */
let state = { proxyUrl: '', enabled: {} }

/** Normalize an arbitrary resolved section into the state shape. */
function normalize(value) {
  const out = { proxyUrl: '', enabled: {} }
  if (value && typeof value === 'object') {
    if (typeof value.proxyUrl === 'string') out.proxyUrl = value.proxyUrl
    if (value.enabled && typeof value.enabled === 'object' && !Array.isArray(value.enabled)) {
      for (const [p, v] of Object.entries(value.enabled)) {
        if (v === true) out.enabled[p] = true
      }
    }
  }
  return out
}

function enabledList() {
  return Object.entries(state.enabled).filter(([, v]) => v === true).map(([p]) => p).sort()
}

function settingsFor(ctx, provider) {
  try {
    const settings = ctx.get('settings');
    if (settings && typeof settings.get === 'function') {
      const pi = settings.get('llm-pi-ai');
      if (pi && pi.providers && pi.providers[provider]) {
        const prof = pi.providers[provider];
        return {
          apiKeyEnv: typeof prof.apiKeyEnv === 'string' ? prof.apiKeyEnv : undefined,
          baseURL: typeof prof.baseURL === 'string' ? prof.baseURL : undefined,
          api: typeof prof.api === 'string' ? prof.api : undefined,
          models: Array.isArray(prof.models) ? prof.models : undefined,
          headers: prof.headers && typeof prof.headers === 'object' && !Array.isArray(prof.headers)
            ? prof.headers
            : undefined,
          present: true,
        };
      }
      if (provider === 'deepseek-official') {
        const ds = settings.get('llm-deepseek');
        if (ds) {
          return {
            apiKeyEnv: typeof ds.apiKeyEnv === 'string' ? ds.apiKeyEnv : undefined,
            baseURL: typeof ds.baseURL === 'string' ? ds.baseURL : undefined,
            api: 'openai-completions',
            present: true,
          };
        }
      }
    }
  } catch (e) { /* ignore */ }
  return {};
}

// The wire routes (api + baseURL + key env + model selector) for one provider.
function resolveRoutes(ctx, provider) {
  const s = settingsFor(ctx, provider);
  if (provider === 'deepseek-official') {
    if (!s.present) return [];
    return [{ api: 'openai-completions', baseURL: s.baseURL || 'https://api.deepseek.com', keyEnv: s.apiKeyEnv || 'DEEPSEEK_API_KEY' }];
  }
  const facts = PROVIDER_FACTS[provider];
  if (facts) {
    const left = s.present && s.baseURL
      ? [{ api: s.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions', baseURL: s.baseURL, keyEnv: s.apiKeyEnv, models: s.models, headers: s.headers }]
      : [];
    const routes = facts.map((r) => ({
      api: r.api,
      baseURL: r.base,
      keyEnv: s.apiKeyEnv || r.keyEnv,
      match: r.match,
      models: r.models,
      headers: s.headers,
    }));
    return left.length ? left : routes;
  }
  if (s.present && s.baseURL) {
    const api = s.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
    return [{ api, baseURL: s.baseURL, keyEnv: s.apiKeyEnv, models: s.models, headers: s.headers }];
  }
  return [];
}

function matchRoute(ctx, provider, model) {
  if (state.enabled[provider] !== true) return undefined;
  const routes = resolveRoutes(ctx, provider);
  for (const r of routes) {
    if (r.models) {
      if (r.models.includes(model)) return r;
      continue;
    }
    if (r.match) {
      if (r.match.some((pat) => new RegExp(pat).test(model))) return r;
      continue;
    }
    return r;
  }
  return undefined;
}

// The full provider list shown in the plugin card / config tools.
async function getConfig(ctx) {
  const displayNames = {};
  try {
    const llm = ctx.get('llm');
    if (llm && typeof llm.listConfigurableProviders === 'function') {
      for (const d of await llm.listConfigurableProviders()) if (d && d.provider) displayNames[d.provider] = d.displayName || d.provider;
    }
  } catch (e) { /* ignore */ }
  try {
    const llm = ctx.get('llm');
    if (llm && typeof llm.listProviders === 'function') {
      for (const p of await llm.listProviders()) if (p && p.id) displayNames[p.id] = displayNames[p.id] || p.name || p.id;
    }
  } catch (e) { /* ignore */ }
  const names = new Set([...Object.keys(PROVIDER_FACTS), ...Object.keys(displayNames)]);
  const providers = [];
  for (const p of [...names].sort()) {
    const routes = resolveRoutes(ctx, p);
    providers.push({
      key: p,
      displayName: displayNames[p] || p,
      supported: routes.length > 0,
      enabled: state.enabled[p] === true,
      routes: routes.map((r) => ({ api: r.api, base: r.baseURL })),
    });
  }
  return { proxyUrl: state.proxyUrl || '', providers };
}

function stripSlash(url) {
  return url.replace(/\/+$/, '');
}

// ---------- message serialization (openai-completions / anthropic-messages) ----------

function textOfBlocks(blocks) {
  let out = '';
  for (const b of blocks || []) {
    if (b.type === 'text') out = out === '' ? b.text : out + '\n' + b.text;
    else if (b.type === 'image') return null;
  }
  return out;
}

function toolText(toolBlock) {
  let out = '';
  for (const b of toolBlock.content || []) {
    if (b.type === 'text') out += b.text;
    else if (b.type === 'image') return null;
    else {
      try { out += JSON.stringify(b); } catch (e) { out += String(b); }
    }
  }
  return out;
}

function mergeMessages(options, api) {
  const merged = [];
  for (const msg of options.messages || []) {
    if (!msg || !msg.content) continue;
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
    const merges = prev !== undefined && (api === 'openai-completions'
      ? msg.role === prev.role && (msg.role === 'user' || msg.role === 'assistant')
      : msg.role === prev.role);
    if (merges) {
      for (const b of msg.content) prev.content.push(b);
    } else {
      merged.push({ role: msg.role, content: Array.isArray(msg.content) ? [...msg.content] : [msg.content] });
    }
  }
  return merged;
}

function serialize(options, api) {
  if (api === 'openai-completions') return serializeOpenAI(options);
  if (api === 'anthropic-messages') return serializeAnthropic(options);
  return null;
}

function serializeOpenAI(options) {
  const systemParts = [];
  if (options.system) systemParts.push(options.system);
  const messages = [];
  for (const msg of mergeMessages(options, 'openai-completions')) {
    if (msg.role === 'system') {
      const t = textOfBlocks(msg.content);
      if (t === null) return null;
      if (t !== '') systemParts.push(t);
      continue;
    }
    if (msg.role === 'user') {
      const textParts = [];
      const toolResults = [];
      for (const b of msg.content) {
        if (b.type === 'tool-result') toolResults.push(b);
        else if (b.type === 'text') textParts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') return null;
        else textParts.push({ type: 'text', text: JSON.stringify(b) });
      }
      if (textParts.length === 1) messages.push({ role: 'user', content: textParts[0].text });
      else if (textParts.length > 1) messages.push({ role: 'user', content: textParts });
      for (const tool of toolResults) {
        const content = toolText(tool);
        if (content === null) return null;
        messages.push({ role: 'tool', tool_call_id: tool.toolCallId, content });
      }
    } else if (msg.role === 'assistant') {
      const text = [], reasoning = [], toolCalls = [];
      for (const b of msg.content) {
        if (b.type === 'text') text.push(b.text);
        else if (b.type === 'reasoning') reasoning.push(b.text);
        else if (b.type === 'tool-call') toolCalls.push({ id: b.id, name: b.name, arguments: b.arguments || '' });
        else if (b.type === 'image') return null;
      }
      const m = { role: 'assistant', content: text.length > 0 ? text.join('') : null };
      if (toolCalls.length > 0) {
        m.tool_calls = toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));
      }
      if (reasoning.length > 0) m.reasoning_content = reasoning.join('');
      messages.push(m);
    }
  }
  if (messages.length === 0) return null;
  const body = { model: options.model, messages, stream: true };
  if (systemParts.length > 0) body.messages = [{ role: 'system', content: systemParts.join('\n\n') }, ...messages];
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.stop && options.stop.length > 0) body.stop = options.stop;
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object' } },
    }));
  }
  return body;
}

function serializeAnthropic(options) {
  const systemBlocks = [];
  if (options.system) systemBlocks.push({ type: 'text', text: options.system });
  const messages = [];
  for (const msg of mergeMessages(options, 'anthropic-messages')) {
    if (msg.role === 'system') {
      const t = textOfBlocks(msg.content);
      if (t === null) return null;
      systemBlocks.push({ type: 'text', text: t });
      continue;
    }
    if (msg.role === 'user') {
      const parts = [];
      for (const b of msg.content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'tool-result') {
          const content = toolText(b);
          if (content === null) return null;
          parts.push({ type: 'tool_result', tool_use_id: b.toolCallId, content, ...(b.isError ? { is_error: true } : {}) });
        } else if (b.type === 'image') return null;
        else parts.push({ type: 'text', text: JSON.stringify(b) });
      }
      if (parts.length > 0) messages.push({ role: 'user', content: parts });
    } else if (msg.role === 'assistant') {
      const parts = [];
      for (const b of msg.content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'reasoning') parts.push({ type: 'thinking', thinking: b.text });
        else if (b.type === 'tool-call') {
          let input = {};
          try { input = JSON.parse(b.arguments || '{}'); } catch (e) { input = {}; }
          parts.push({ type: 'tool_use', id: b.id, name: b.name, input });
        } else if (b.type === 'image') return null;
      }
      if (parts.length > 0) messages.push({ role: 'assistant', content: parts });
    }
  }
  if (messages.length === 0) return null;
  const body = { model: options.model, max_tokens: options.maxTokens || 8192, stream: true, messages };
  if (systemBlocks.length > 0) body.system = systemBlocks;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.stop && options.stop.length > 0) body.stop_sequences = options.stop;
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object' },
    }));
  }
  return body;
}

// ---------- stream state + SSE translation ----------

function makeState(api) {
  return { api, blocks: [], byKey: new Map(), usageInput: undefined, usageOutput: undefined, finishReason: undefined, stopReason: undefined };
}

function ensureOpenAIBlock(state, blockType, key) {
  let b = state.byKey.get(key);
  if (!b) {
    b = { type: blockType, index: state.blocks.length, id: undefined, name: undefined, text: '', started: false };
    state.byKey.set(key, b);
    state.blocks.push(b);
  }
  return b;
}

function startOpenAIBlock(state, b) {
  if (b.started) return [];
  b.started = true;
  return [{ type: 'block-start', index: b.index, blockType: b.type }];
}

function translateChunk(state, data) {
  if (state.api === 'openai-completions') return translateOpenAIChunk(state, data);
  return translateAnthropicChunk(state, data);
}

function translateOpenAIChunk(state, data) {
  let ev;
  try { ev = JSON.parse(data); } catch (e) { return []; }
  const out = [];
  const choice = Array.isArray(ev.choices) && ev.choices[0] ? ev.choices[0] : undefined;
  const delta = choice && choice.delta ? choice.delta : {};
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    const b = ensureOpenAIBlock(state, 'reasoning', 'reasoning');
    b.text += delta.reasoning_content;
    out.push(...startOpenAIBlock(state, b));
    out.push({ type: 'reasoning-delta', index: b.index, text: delta.reasoning_content });
  }
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    const b = ensureOpenAIBlock(state, 'text', 'content');
    b.text += delta.content;
    out.push(...startOpenAIBlock(state, b));
    out.push({ type: 'text-delta', index: b.index, text: delta.content });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const key = 'tool:' + String(tc.index);
      const b = ensureOpenAIBlock(state, 'tool-call', key);
      if (tc.id) b.id = tc.id;
      if (tc.function && typeof tc.function.name === 'string' && tc.function.name.length > 0) b.name = tc.function.name;
      out.push(...startOpenAIBlock(state, b));
      if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments.length > 0) {
        b.text += tc.function.arguments;
        out.push({
          type: 'tool-call-delta',
          index: b.index,
          id: b.id || '',
          ...(b.name ? { name: b.name } : {}),
          argumentsDelta: tc.function.arguments,
        });
      }
    }
  }
  if (ev.usage && typeof ev.usage === 'object') state.usageOpenAI = ev.usage;
  if (choice && choice.finish_reason) state.finishReason = choice.finish_reason;
  return out;
}

function translateAnthropicChunk(state, data) {
  let ev;
  try { ev = JSON.parse(data); } catch (e) { return []; }
  const out = [];
  if (ev.type === 'message_start') {
    if (ev.message && ev.message.usage) state.usageInput = ev.message.usage;
  } else if (ev.type === 'content_block_start') {
    const cb = ev.content_block || {};
    const kind =
      cb.type === 'thinking' || cb.type === 'redacted_thinking' ? 'reasoning'
      : cb.type === 'tool_use' ? 'tool-call'
      : cb.type === 'text' ? 'text'
      : undefined;
    if (kind === undefined) return [];
    const idx = typeof ev.index === 'number' ? ev.index : state.blocks.length;
    let b = state.blocks[idx];
    if (!b) {
      b = { type: kind, index: idx, id: undefined, name: undefined, text: '' };
      state.blocks[idx] = b;
      out.push({ type: 'block-start', index: idx, blockType: kind });
    }
    if (kind === 'tool-call') {
      if (cb.id) b.id = cb.id;
      if (cb.name) b.name = cb.name;
    }
  } else if (ev.type === 'content_block_delta') {
    const idx = ev.index;
    const b = state.blocks[idx];
    if (!b) return [];
    const d = ev.delta || {};
    if (d.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) {
      b.text += d.text;
      out.push({ type: 'text-delta', index: idx, text: d.text });
    } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking.length > 0) {
      b.text += d.thinking;
      out.push({ type: 'reasoning-delta', index: idx, text: d.thinking });
    } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string' && d.partial_json.length > 0) {
      b.text += d.partial_json;
      out.push({
        type: 'tool-call-delta',
        index: idx,
        id: b.id || '',
        ...(b.name ? { name: b.name } : {}),
        argumentsDelta: d.partial_json,
      });
    }
  } else if (ev.type === 'message_delta') {
    if (ev.usage && typeof ev.usage.output_tokens === 'number') state.usageOutput = ev.usage.output_tokens;
    const stop = ev.delta && ev.delta.stop_reason;
    state.stopReason = stop === 'max_tokens' ? 'max-tokens' : stop === 'tool_use' ? 'tool-calls' : 'stop';
  }
  return out;
}

function normalizeUsage(u) {
  const out = {
    inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
    outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
  };
  if (typeof u.prompt_cache_hit_tokens === 'number') out.cacheReadTokens = u.prompt_cache_hit_tokens;
  if (typeof u.prompt_cache_miss_tokens === 'number') out.cacheWriteTokens = u.prompt_cache_miss_tokens;
  if (u.completion_tokens_details && typeof u.completion_tokens_details.reasoning_tokens === 'number') {
    out.reasoningTokens = u.completion_tokens_details.reasoning_tokens;
  }
  return out;
}

function finishChunks(state) {
  if (state.api === 'openai-completions') return finishOpenAIChunks(state);
  return finishAnthropicChunks(state);
}

function finishOpenAIChunks(state) {
  const out = [];
  for (const b of state.blocks) {
    let block;
    if (b.type === 'text') block = { type: 'text', text: b.text };
    else if (b.type === 'reasoning') block = { type: 'reasoning', text: b.text };
    else block = { type: 'tool-call', id: b.id, name: b.name, arguments: b.text };
    out.push({ type: 'block-end', index: b.index, block });
  }
  if (state.usageOpenAI) out.push({ type: 'usage', usage: normalizeUsage(state.usageOpenAI) });
  const reason =
    state.finishReason === 'tool_calls' ? { kind: 'tool-calls' }
    : state.finishReason === 'length' ? { kind: 'max-tokens' }
    : { kind: 'stop' };
  out.push({ type: 'finish', reason });
  return out;
}

function finishAnthropicChunks(state) {
  const out = [];
  for (let idx = 0; idx < state.blocks.length; idx++) {
    const b = state.blocks[idx];
    if (!b) continue;
    let block;
    if (b.type === 'text') block = { type: 'text', text: b.text };
    else if (b.type === 'reasoning') block = { type: 'reasoning', text: b.text };
    else block = { type: 'tool-call', id: b.id, name: b.name, arguments: b.text };
    out.push({ type: 'block-end', index: idx, block });
  }
  const usage = {
    inputTokens: state.usageInput && typeof state.usageInput.input_tokens === 'number' ? state.usageInput.input_tokens : 0,
    outputTokens: typeof state.usageOutput === 'number' ? state.usageOutput : 0,
  };
  if (state.usageInput && typeof state.usageInput.cache_read_input_tokens === 'number') usage.cacheReadTokens = state.usageInput.cache_read_input_tokens;
  if (state.usageInput && typeof state.usageInput.cache_creation_input_tokens === 'number') usage.cacheWriteTokens = state.usageInput.cache_creation_input_tokens;
  out.push({ type: 'usage', usage });
  out.push({ type: 'finish', reason: { kind: state.stopReason || 'stop' } });
  return out;
}

// ---------- SSE line reader (yields parsed events; captures raw body until the first event) ----------

async function* iterateSSE(stdout) {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataAcc = [];
  let seenEvent = false;
  let raw = '';
  const RAW_CAP = 16384;
  const flush = () => {
    if (dataAcc.length > 0) {
      const d = dataAcc.join('\n').trim();
      dataAcc = [];
      if (d !== '') {
        seenEvent = true;
        raw = '';
        return d;
      }
    }
    return undefined;
  };
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const d = flush();
        if (d !== undefined) yield { kind: 'data', data: d };
        continue;
      }
      if (!seenEvent && raw.length < RAW_CAP) raw += line + '\n';
      if (line.startsWith('data:')) dataAcc.push(line.slice(5).trimStart());
    }
  }
  buffer += decoder.decode();
  if (buffer !== '') {
    let line = buffer;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      const d = flush();
      if (d !== undefined) yield { kind: 'data', data: d };
    } else {
      if (!seenEvent && raw.length < RAW_CAP) raw += line + '\n';
      if (line.startsWith('data:')) {
        const d = line.slice(5).trimStart();
        dataAcc.push(d);
        const flushed = flush();
        if (flushed !== undefined) yield { kind: 'data', data: flushed };
      }
    }
  } else {
    const d = flush();
    if (d !== undefined) yield { kind: 'data', data: d };
  }
  yield { kind: 'end', raw: seenEvent ? '' : raw.trim() };
}

// ---------- HTTP status / failure classification ----------

function parseHttpStatus(raw) {
  if (!raw) return { status: 0, body: '' };
  const lines = raw.split('\n');
  let status = 0;
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (/^\d{3}$/.test(t)) { status = Number(t); cut = i; break; }
  }
  return { status, body: lines.slice(0, cut).join('\n').trim() };
}

function classifyHttp(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 413) return 'INVALID_REQUEST';
  if (status >= 500) return 'SERVER';
  return 'HTTP_' + status;
}

function extractError(text) {
  if (!text) return undefined;
  try {
    const j = JSON.parse(text);
    const e = j && (j.error || (Array.isArray(j.errors) && j.errors[0]));
    if (typeof e === 'string' && e) return e;
    if (e && typeof e.message === 'string' && e.message) return e.message;
    if (e && typeof e.msg === 'string' && e.msg) return e.msg;
    if (e && typeof e.error === 'string' && e.error) return e.error;
  } catch (e) { /* not JSON */ }
  return undefined;
}

function errorChunk(code, message, status) {
  const failure = { message, code };
  if (status) failure.status = status;
  return { type: 'finish', reason: { kind: 'error', failure } };
}

// ---------- credential resolution ----------

async function resolveApiKey(ctx, provider, keyEnv) {
  const s = settingsFor(ctx, provider);
  const envName = s.apiKeyEnv || keyEnv;
  if (!envName) return undefined;
  try {
    const creds = ctx.get('credentials');
    if (!creds || typeof creds.resolve !== 'function') return undefined;
    const r = await creds.resolve(envName);
    return r && typeof r.value === 'string' && r.value.length > 0 ? r.value : undefined;
  } catch (e) { return undefined; }
}

// ---------- opencode session header ----------

const FALLBACK_SESSION_UUID = crypto.randomUUID();

/** Stable per-conversation value for the x-opencode-session header ('auto'). */
function sessionHeaderFor(options) {
  const raw = options && options.sessionId !== undefined ? String(options.sessionId) : '';
  // Header values must stay printable ASCII so the curl -H rebuild stays valid.
  const clean = raw.replace(/[^\x20-\x7E]/g, '');
  return clean.length > 0 ? clean : FALLBACK_SESSION_UUID;
}

// ---------- the proxied call ----------

async function* callThroughProxy(ctx, route, proxyUrl, url, body, apiKey, options) {
  const started = Date.now();
  const api = route.api;
  const keyHeaders = api === 'anthropic-messages'
    ? ['-H', `x-api-key: ${apiKey}`, '-H', 'anthropic-version: 2023-06-01']
    : ['-H', `Authorization: Bearer ${apiKey}`];
  // Custom headers declared on the provider (e.g. anthropic-beta: context-1m-...)
  // must survive the proxy rebuild, otherwise relays that require them reject
  // the request with 400/429.
  const extraHeaders = [];
  for (const [name, value] of Object.entries(route.headers || {})) {
    if (typeof name !== 'string' || name === '' || value === undefined || value === null) continue;
    let headerValue = Array.isArray(value) ? value.join(', ') : String(value);
    // Console Go (opencode zen /go) requires a stable per-conversation session
    // id for routing and prompt caching; 'auto' maps it to the harness
    // session id stamped by the agent loop. See https://opencode.ai/docs/go/.
    if (name.toLowerCase() === 'x-opencode-session' && headerValue === 'auto') {
      headerValue = sessionHeaderFor(options);
    }
    extraHeaders.push('-H', `${name}: ${headerValue}`);
  }
  const argv = [
    'curl', '-sS', '-N', '--proxy', proxyUrl, '-w', '\n%{http_code}', '-X', 'POST', url,
    ...keyHeaders,
    ...extraHeaders,
    '-H', 'Content-Type: application/json',
    '-H', 'Accept: text/event-stream',
    '-H', 'User-Agent: dsh-provider-proxy/1',
    '--connect-timeout', '15',
    '--max-time', '600',
    '--data-binary', '@-',
  ];
  let handle;
  try {
    handle = ctx.get('subprocess').spawn({
      argv,
      cwd: '/',
      stdio: { stdin: { data: JSON.stringify(body) }, stdout: 'pipe', stderr: { maxBytes: 16384 } },
      graceMs: 2000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    console.error(`[provider-proxy] spawn failed: ${e && e.message}`);
    yield errorChunk('TRANSPORT', 'proxy spawn failed: ' + (e && e.message));
    return;
  }
  const state = makeState(api);
  let sawEvent = false;
  let raw = '';
  let outcome;
  try {
    for await (const ev of iterateSSE(handle.stdout)) {
      if (ev.kind === 'data') {
        sawEvent = true;
        yield* translateChunk(state, ev.data);
      } else {
        raw = ev.raw;
      }
    }
    outcome = await handle.done;
  } catch (e) {
    if (options.signal && options.signal.aborted) return;
    console.error(`[provider-proxy] stream error: ${e && e.stack || e}`);
    yield errorChunk('TRANSPORT', 'proxy stream error: ' + (e && e.message || e));
    return;
  } finally {
    handle.terminate();
  }
  let stderrText = '';
  try {
    const reader = handle.collected && handle.collected.stderr;
    if (reader && typeof reader.readFrom === 'function') stderrText = reader.readFrom(0).text || '';
  } catch (e) { stderrText = ''; }
  const { status, body: bodyText } = parseHttpStatus(raw);
  if (options.signal && options.signal.aborted) return;
  if (outcome.exitCode !== 0) {
    if (!sawEvent) {
      const curlMsg = (stderrText || '').split('\n').filter((l) => /^curl:/.test(l)).join(' ').trim() || `curl exited ${outcome.exitCode}`;
      console.error(`[provider-proxy] ${options.provider}/${options.model} transport failure: ${curlMsg}`);
      yield errorChunk('TRANSPORT', curlMsg);
    } else {
      console.error(`[provider-proxy] ${options.provider}/${options.model} died mid-stream (${outcome.exitCode})`);
      yield errorChunk('TRANSPORT', `proxy stream ended unexpectedly (curl ${outcome.exitCode})`);
    }
    return;
  }
  if (!sawEvent) {
    if (status >= 400) {
      const detail = extractError(bodyText) || bodyText || `HTTP ${status}`;
      console.error(`[provider-proxy] ${options.provider}/${options.model} HTTP ${status}: ${detail}`);
      yield errorChunk(classifyHttp(status), detail, status);
    } else {
      console.error(`[provider-proxy] ${options.provider}/${options.model} empty response`);
      yield errorChunk('EMPTY_RESPONSE', 'provider returned no stream' + (status ? ` (HTTP ${status})` : ''));
    }
    return;
  }
  yield* finishChunks(state);
  console.log(`[provider-proxy] ok ${options.provider}/${options.model} via ${api} (HTTP ${status || 200}, ${Date.now() - started}ms)`);
}

// ---------- the waterfall listener ----------

async function* proxyStream(ctx, options, next) {
  let route;
  try { route = matchRoute(ctx, options.provider, options.model); } catch (e) { route = undefined; }
  const proxyUrl = state.proxyUrl || '';
  const subprocess = ctx.get('subprocess');
  if (!route || !proxyUrl || !subprocess || typeof subprocess.spawn !== 'function') {
    yield* next();
    return;
  }
  const api = route.api;
  if (api !== 'openai-completions' && api !== 'anthropic-messages') { yield* next(); return; }
  let body;
  try { body = serialize(options, api); } catch (e) { body = null; }
  if (!body) {
    console.log(`[provider-proxy] ${options.provider}/${options.model}: unsupported message shape, passing through`);
    yield* next();
    return;
  }
  const apiKey = await resolveApiKey(ctx, options.provider, route.keyEnv);
  if (!apiKey) {
    console.log(`[provider-proxy] ${options.provider}/${options.model}: no api key resolved, passing through`);
    yield* next();
    return;
  }
  const url = api === 'anthropic-messages'
    ? `${stripSlash(route.baseURL)}/v1/messages`
    : `${stripSlash(route.baseURL)}/chat/completions`;
  try {
    yield* callThroughProxy(ctx, route, proxyUrl, url, body, apiKey, options);
  } catch (e) {
    console.error(`[provider-proxy] fatal: ${e && e.stack || e}`);
    yield errorChunk('TRANSPORT', 'proxy plugin error: ' + (e && e.message || e));
  }
}

// ---------- probe helper ----------

async function probeUrl(ctx, url, timeoutMs) {
  const subprocess = ctx.get('subprocess');
  if (!subprocess || typeof subprocess.spawn !== 'function' || !state.proxyUrl) {
    return { ok: false, error: 'subprocess service or proxyUrl unavailable' };
  }
  const started = Date.now();
  const argv = [
    'curl', '-sS', '--proxy', state.proxyUrl, '-o', '/dev/null',
    '-w', '%{http_code}',
    '--connect-timeout', '10',
    '--max-time', String(Math.max(1, Math.min(300, Math.floor((timeoutMs || 10000) / 1000)))),
    url,
  ];
  let handle;
  try {
    handle = subprocess.spawn({
      argv,
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 8192 } },
      graceMs: 2000,
    });
  } catch (e) {
    return { ok: false, error: 'spawn failed: ' + (e && e.message) };
  }
  const out = [];
  try {
    for await (const chunk of handle.stdout) out.push(new TextDecoder().decode(chunk));
  } catch (e) { /* ignore */ }
  const outcome = await handle.done;
  let stderrText = '';
  try {
    const reader = handle.collected && handle.collected.stderr;
    if (reader) stderrText = reader.readFrom(0).text || '';
  } catch (e) { /* ignore */ }
  const ms = Date.now() - started;
  const code = out.join('').trim();
  if (outcome.exitCode !== 0) {
    return { ok: false, proxy: state.proxyUrl, ms, curl: outcome.exitCode, error: (stderrText || '').split('\n').filter((l) => /^curl:/.test(l)).join(' ').trim() || `curl exited ${outcome.exitCode}` };
  }
  return { ok: /^2\d\d$/.test(code), proxy: state.proxyUrl, status: code ? Number(code) : undefined, ms };
}

// ---------- plugin ----------

export function apply(ctx, config) {
  state = normalize(config);
  let syncSource = () => normalize(config);
  installSettingsSection(ctx, NAMESPACE, Config, config, {
    setSource: (source) => {
      syncSource = source;
    },
    onChange: () => {
      let value;
      try { value = syncSource(); } catch (e) { value = undefined; }
      const next = normalize(value);
      const enabledChanged = JSON.stringify(Object.keys(next.enabled).sort()) !== JSON.stringify(Object.keys(state.enabled).sort())
        || JSON.stringify(next.enabled) !== JSON.stringify(state.enabled);
      if (next.proxyUrl !== state.proxyUrl || enabledChanged) {
        state = next;
        console.log(`[provider-proxy] config: proxy=${state.proxyUrl || '(disabled)'} enabled=[${enabledList().join(', ')}]`);
      }
    },
  });

  console.log(`[provider-proxy] loaded: proxy=${state.proxyUrl || '(disabled)'} providers=${Object.keys(PROVIDER_FACTS).length} enabled=[${enabledList().join(', ')}]`);

  ctx.on('llm/stream', (options, next) => proxyStream(ctx, options, next));

  // Model-facing tools (best effort: registration is app-scoped; whether a
  // session surfaces them depends on the tool presentation layer).
  try {
    ctx.tools.register({
      name: 'proxy_config_get',
      description: 'Show the current provider-proxy configuration: the proxy URL and every selectable provider with its enabled (route through proxy) state.',
      parameters: { type: 'object', properties: {} },
      execute: async () => JSON.stringify(await getConfig(ctx), null, 2),
    });
  } catch (e) {
    console.error(`[provider-proxy] tool registration failed: ${e && e.message}`);
  }
  try {
    ctx.tools.register({
      name: 'proxy_config_set',
      description: 'Update the provider-proxy configuration: set the proxy URL and/or enable (route through proxy) or disable (direct) providers. Provider ids are listed by proxy_config_get (e.g. opencode-go, openai, deepseek, anthropic, groq, openrouter).',
      parameters: {
        type: 'object',
        properties: {
          proxyUrl: { type: 'string', description: 'New proxy URL, e.g. http://127.0.0.1:7890. An empty string disables interception entirely.' },
          enable: { type: 'array', items: { type: 'string' }, description: 'Provider ids to route through the proxy (check).' },
          disable: { type: 'array', items: { type: 'string' }, description: 'Provider ids to stop routing through the proxy (uncheck).' },
        },
      },
      execute: async (args) => {
        const patch = { proxyUrl: args && args.proxyUrl, enabled: {} };
        if (args) {
          for (const key of args.enable || []) patch.enabled[key] = true;
          for (const key of args.disable || []) patch.enabled[key] = false;
        }
        const settings = ctx.get('settings');
        const next = { proxyUrl: typeof patch.proxyUrl === 'string' ? patch.proxyUrl.trim() : state.proxyUrl, enabled: { ...state.enabled } };
        for (const [p, v] of Object.entries(patch.enabled)) {
          if (typeof v === 'boolean') next.enabled[p] = v;
        }
        if (settings && typeof settings.update === 'function') {
          await settings.update('provider-proxy', next);
        }
        return JSON.stringify(await getConfig(ctx), null, 2);
      },
    });
  } catch (e) {
    console.error(`[provider-proxy] tool registration failed: ${e && e.message}`);
  }
  try {
    ctx.tools.register({
      name: 'proxy_route_probe',
      description: 'Probe whether a URL is reachable through the configured provider proxy (the proxyUrl of the provider-proxy plugin). Use it to verify proxy connectivity before relying on proxied model providers. Returns status code and latency.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL to probe, e.g. https://opencode.ai/zen/go/v1/models' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 10000)' },
        },
        required: ['url'],
      },
      execute: async (args) => {
        const result = await probeUrl(ctx, args && args.url ? String(args.url) : '', (args && args.timeoutMs) || 10000);
        return JSON.stringify(result, null, 2);
      },
    });
  } catch (e) {
    console.error(`[provider-proxy] tool registration failed: ${e && e.message}`);
  }

  // one-shot connectivity self-test at activation (does not touch the model route)
  try {
    void probeUrl(ctx, 'https://api.ipify.org', 12000)
      .then((r) => console.log(`[provider-proxy] self-test ${r.ok ? 'PASS' : 'FAIL'}: ${JSON.stringify(r)}`))
      .catch((e) => console.error(`[provider-proxy] self-test error: ${e && e.message}`));
  } catch (e) { /* ignore */ }
}