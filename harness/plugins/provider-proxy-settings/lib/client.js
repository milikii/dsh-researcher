/*
 * Browser half of @dsh-local/provider-proxy-settings: the Settings → Plugins
 * card for the `provider-proxy` namespace — a collapsible PluginCard clone of
 * the official ui-settings-plugins cards (li > header button + disclosure body
 * + staged draft model with 保存/放弃 footer). Built in the
 * window.__ModuleLoader__ bundle format; the factory must stay fully
 * self-contained (only `require` and the injected client services).
 *
 * Unlike the old session-scoped dynamic plugin card (which talked to the host
 * over package-private RPC), this card is a plain settings-namespace surface:
 * reads/writes go through ctx.settingsScope bound to `provider-proxy`, so it
 * survives restarts like every other plugin card.
 */
window.__ModuleLoader__.load({
  id: "@dsh-local/provider-proxy-settings",
  factory: function (require) {
    const react = require("react");

    const NAMESPACE = "provider-proxy";
    const inject = ["slots", "settingsScope"];

    /** Static provider directory: [key, displayName, supported] — mirrors the
     *  node half's PROVIDER_FACTS plus the llm-pi-ai configurable providers.
     *  supported=0 means the provider's wire protocol cannot be proxied. */
    const PROVIDERS = [
      ['agent', 'AgentRouter (openai-responses)', 0],
      ['ant-ling', 'Ant Ling', 1],
      ['anthropic', 'Anthropic', 1],
      ['any', 'AnyRouter (anthropic-messages)', 1],
      ['arak', 'WindHub (openai-completions)', 1],
      ['cerebras', 'Cerebras', 1],
      ['cloudflare-ai-gateway', 'Cloudflare AI Gateway', 1],
      ['cloudflare-workers-ai', 'Cloudflare Workers AI', 1],
      ['deepseek', 'Deepseek', 1],
      ['deepseek-official', 'DeepSeek 官方', 1],
      ['fireworks', 'Fireworks', 1],
      ['github-copilot', 'GitHub Copilot', 1],
      ['glm', 'AgentRouter GLM (openai-completions)', 1],
      ['groq', 'Groq', 1],
      ['huggingface', 'Huggingface', 1],
      ['kimi-coding', 'Kimi Coding', 1],
      ['minimax', 'Minimax', 1],
      ['minimax-cn', 'Minimax Cn', 1],
      ['mistral', 'Mistral', 1],
      ['moonshotai', 'Moonshotai', 1],
      ['moonshotai-cn', 'Moonshotai Cn', 1],
      ['nvidia', 'Nvidia', 1],
      ['openai', 'Openai', 1],
      ['opencode', 'Opencode', 1],
      ['opencode-go', 'Opencode Go', 1],
      ['openrouter', 'Openrouter', 1],
      ['qwen-token-plan', 'Qwen Token Plan', 1],
      ['qwen-token-plan-cn', 'Qwen Token Plan Cn', 1],
      ['radius', 'Radius', 1],
      ['together', 'Together', 1],
      ['vercel-ai-gateway', 'Vercel AI Gateway', 1],
      ['xai', 'Xai', 1],
      ['xiaomi', 'Xiaomi', 1],
      ['xiaomi-token-plan-ams', 'Xiaomi Token Plan Ams', 1],
      ['xiaomi-token-plan-cn', 'Xiaomi Token Plan Cn', 1],
      ['xiaomi-token-plan-sgp', 'Xiaomi Token Plan Sgp', 1],
      ['zai', 'Zai', 1],
      ['zai-coding-cn', 'Zai Coding Cn', 1],
    ];

    /** Same component styles as the official PluginCard.module.css. */
    const S = {
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 12, listStyle: "none", transition: "border-color .16s, background .16s", margin: 0 },
      cardOpen: { background: "var(--dsw-alias-bg-layer-2)", borderColor: "var(--dsw-alias-label-dimmed)" },
      header: { appearance: "none", width: "100%", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", background: "none", border: 0, borderRadius: 12, alignItems: "center", gap: 12, padding: "14px 16px", display: "flex" },
      headText: { flexDirection: "column", flex: 1, gap: 4, minWidth: 0, display: "flex" },
      name: { color: "var(--dsw-alias-label-primary)", fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
      description: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: 1.5 },
      chevron: { color: "var(--dsw-alias-label-tertiary)", flex: "none", transition: "transform .16s" },
      chevronOpen: { transform: "rotate(180deg)" },
      pending: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, flex: "none", padding: "1px 8px", fontSize: 11, fontWeight: 500, lineHeight: "17px" },
      badgeOn: { whiteSpace: "nowrap", color: "#14b46a", borderRadius: 999, flex: "none", padding: "1px 8px", fontSize: 11, fontWeight: 500, lineHeight: "17px" },
      badgeMuted: { whiteSpace: "nowrap", color: "var(--dsw-alias-label-tertiary)", borderRadius: 999, flex: "none", padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
      body: { borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 16px", paddingBottom: 8 },
      readOnly: { color: "var(--dsw-alias-label-tertiary)", margin: "12px 0 0", fontSize: 12, lineHeight: 1.5 },
      footer: { borderTop: "1px solid var(--dsw-alias-border-l2)", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "12px 0 4px", display: "flex" },
      failed: { minWidth: 0, color: "var(--dsw-alias-label-error)", flex: 1, margin: 0, fontSize: 12, lineHeight: 1.5 },
      discard: { appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", background: "none", borderRadius: 8, padding: "5px 14px", fontSize: 13, lineHeight: 1.5 },
      save: { appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid transparent", borderRadius: 8, padding: "5px 14px", fontSize: 13, lineHeight: 1.5, background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)" },
      field: { flexDirection: "column", gap: 6, padding: "12px 0", display: "flex" },
      label: { minWidth: 0, color: "var(--dsw-alias-label-primary)", flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.5 },
      route: { alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", display: "flex", marginTop: 6 },
      routeOff: { opacity: 0.55 },
      routeText: { flexDirection: "column", gap: 2, flex: 1, minWidth: 0, display: "flex" },
      routeName: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      routeSub: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all" },
      tag: { fontSize: 11, padding: "2px 8px", borderRadius: 999, color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l2)", whiteSpace: "nowrap" },
      tagOn: { color: "#14b46a", borderColor: "rgba(0,180,80,.55)" },
      tagOff: { opacity: 0.55, fontStyle: "italic" },
      count: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 4 },
      input: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", height: 34, font: "inherit", color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "0 12px", fontSize: 13, lineHeight: 1.5, width: "100%", boxSizing: "border-box" },
      hint: { color: "var(--dsw-alias-label-tertiary)", margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 },
      disabled: { opacity: 0.4, cursor: "default" }
    };

    /** Card controller: mirrors the settings scope into a store + write actions. */
    function ProxyCardController(scope) {
      const listeners = new Set();
      let snapshot = scope.getSnapshot();
      const emit = () => {
        snapshot = scope.getSnapshot();
        for (const listener of listeners) listener();
      };
      scope.subscribe(emit);
      return {
        store: {
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          getSnapshot() {
            return snapshot;
          }
        },
        actions: {
          set: (field, value) => scope.set(field, value),
          unset: (field) => scope.unset(field)
        }
      };
    }

    function ChevronIcon({ open }) {
      return react.createElement("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        style: { ...S.chevron, ...(open ? S.chevronOpen : {}) }
      }, react.createElement("path", { d: "M4 6l4 4 4-4" }));
    }

    /** Resolve the enabled map from the snapshot (user override over base). */
    function resolveEnabled(snap) {
      const user = snap && snap.user && typeof snap.user === "object" ? snap.user : {};
      const base = snap && snap.base && typeof snap.base === "object" ? snap.base : {};
      const out = {};
      for (const source of [base, user]) {
        if (source.enabled && typeof source.enabled === "object" && !Array.isArray(source.enabled)) {
          for (const [p, v] of Object.entries(source.enabled)) {
            if (v === true) out[p] = true;
          }
        }
      }
      return out;
    }

    function ProxySettingsCard(props) {
      const snap = react.useSyncExternalStore(props.card.subscribe, props.card.getSnapshot);
      const [open, setOpen] = react.useState(false);
      const [drafts, setDrafts] = react.useState({});
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);

      const loading = snap.status !== "ready" && snap.status !== "idle";
      const writable = snap.writable === true && !loading;
      const user = (snap.user && typeof snap.user === "object") ? snap.user : {};
      const base = (snap.base && typeof snap.base === "object") ? snap.base : {};
      const proxyUrl = String(
        drafts.proxyUrl !== undefined ? drafts.proxyUrl :
        user.proxyUrl !== undefined ? user.proxyUrl :
        base.proxyUrl !== undefined ? base.proxyUrl : ""
      );
      const enabled = resolveEnabled(snap);
      const draftEnabled = drafts.enabled;

      const enabledCount = PROVIDERS.filter(([, , supported]) => supported === 1)
        .filter(([key]) => (draftEnabled !== undefined ? draftEnabled[key] : enabled[key]) === true).length;
      const resolvedProxyUrl = drafts.proxyUrl !== undefined ? String(drafts.proxyUrl) : proxyUrl;

      const name = "Provider 代理（provider-proxy）";
      const description = resolvedProxyUrl
        ? "代理 " + resolvedProxyUrl + (enabledCount > 0 ? " · " + enabledCount + " 个供应商走代理" : "")
        : "未启用（全部直连）";

      const dirty = drafts.proxyUrl !== undefined || drafts.enabled !== undefined;

      const save = async () => {
        setSaving(true);
        setFailed(false);
        try {
          if (drafts.proxyUrl !== undefined) {
            const text = String(drafts.proxyUrl).trim();
            if (text.length > 0) {
              await props.actions.set("proxyUrl", text);
            } else {
              await props.actions.unset("proxyUrl");
            }
          }
          if (drafts.enabled !== undefined) {
            const next = { ...enabled };
            for (const [key] of PROVIDERS) {
              if (drafts.enabled[key] === true) next[key] = true;
              else if (drafts.enabled[key] === false) delete next[key];
            }
            if (Object.keys(next).length > 0) {
              await props.actions.set("enabled", next);
            } else {
              await props.actions.unset("enabled");
            }
          }
          setDrafts({});
        } catch (error) {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };

      const toggle = (key, checked) => {
        setDrafts((prev) => {
          const next = { ...(prev.enabled !== undefined ? prev.enabled : enabled) };
          if (checked) next[key] = true;
          else delete next[key];
          return { ...prev, enabled: next };
        });
        setFailed(false);
      };

      return react.createElement("li", {
        style: { ...S.card, ...(open ? S.cardOpen : {}) }
      }, react.createElement("button", {
        type: "button",
        style: S.header,
        "aria-expanded": open,
        "aria-label": (open ? "折叠：" : "展开：") + name,
        onClick: () => setOpen(!open)
      },
        react.createElement("span", { style: S.headText },
          react.createElement("span", { style: S.name }, name),
          react.createElement("span", { style: S.description }, description)
        ),
        enabledCount > 0
          ? react.createElement("span", { style: S.badgeOn }, enabledCount + " 走代理")
          : react.createElement("span", { style: S.badgeMuted }, "直连"),
        dirty ? react.createElement("span", { style: S.pending }, "未保存") : null,
        react.createElement(ChevronIcon, { open })
      ),
        open ? react.createElement("div", { style: S.body },
          loading ? react.createElement("p", { style: S.readOnly }, "加载设置中…") :
          !writable ? react.createElement("p", { style: S.readOnly }, "当前设置不可写（无宿主设置服务或只读）。") :
            react.createElement("div", null,
              react.createElement("div", { style: S.field },
                react.createElement("div", { style: { ...S.label, fontSize: 12, opacity: 0.8 } }, "代理地址 proxyUrl"),
                react.createElement("input", {
                  style: { ...S.input, ...(saving ? S.disabled : {}) },
                  type: "text",
                  disabled: saving,
                  placeholder: "http://127.0.0.1:7890",
                  value: proxyUrl,
                  onChange: (event) => {
                    setDrafts((prev) => ({ ...prev, proxyUrl: event.target.value }));
                    setFailed(false);
                  }
                }),
                react.createElement("p", { style: S.hint }, "留空并保存 = 全部直连（关闭代理拦截）。")
              ),
              react.createElement("div", { style: S.field },
                react.createElement("div", { style: { ...S.label, fontSize: 12, opacity: 0.8 } }, "需要代理的供应商（可多选；勾选后走代理，不勾选直连）"),
                react.createElement("p", { style: S.count },
                  "共 " + PROVIDERS.length + " 个，可代理 " + PROVIDERS.filter(([, , s]) => s === 1).length + " 个，已勾选 " + enabledCount + " 个"
                ),
                PROVIDERS.map(([key, displayName, supported]) => {
                  const checked = (draftEnabled !== undefined ? draftEnabled[key] : enabled[key]) === true;
                  return react.createElement("label", {
                    key: key,
                    style: { ...S.route, ...(!checked ? S.routeOff : {}) }
                  },
                    react.createElement("input", {
                      type: "checkbox",
                      checked,
                      disabled: saving || supported !== 1,
                      title: supported === 1 ? "勾选后该供应商的模型调用走代理" : "该供应商没有可代理的端点信息",
                      onChange: (event) => toggle(key, event.target.checked)
                    }),
                    react.createElement("span", { style: S.routeText },
                      react.createElement("span", { style: S.routeName }, displayName),
                      react.createElement("span", { style: S.routeSub }, key)
                    ),
                    react.createElement("span", {
                      style: { ...S.tag, ...(checked ? S.tagOn : {}), ...(supported !== 1 ? S.tagOff : {}) }
                    }, supported !== 1 ? "暂不支持" : checked ? "走代理" : "直连")
                  );
                })
              ),
              react.createElement("div", { style: S.footer },
                failed ? react.createElement("p", { style: S.failed, role: "status" }, "保存失败：请检查输入。") : null,
                react.createElement("button", {
                  type: "button",
                  style: { ...S.discard, ...(!dirty || saving ? S.disabled : {}) },
                  disabled: !dirty || saving,
                  onClick: () => setDrafts({})
                }, "放弃"),
                react.createElement("button", {
                  type: "button",
                  style: { ...S.save, ...(!dirty || saving ? S.disabled : {}) },
                  disabled: !dirty || saving,
                  onClick: save
                }, saving ? "保存中…" : "保存")
              )
            )
        ) : null
      );
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      const controller = new ProxyCardController(scope);
      ctx.effect(() => scope.subscribe(() => {}), "provider-proxy: card scope sync");
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: NAMESPACE,
        id: NAMESPACE,
        order: 30,
        label: "Provider 代理",
        inject: () => ({ card: controller.store, actions: controller.actions })
      }, ProxySettingsCard));
    }

    return { apply, inject };
  }
});