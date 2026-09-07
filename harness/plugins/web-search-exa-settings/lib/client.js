/*
 * Browser half of @dsh-local/web-search-exa-settings: the Settings → Plugins
 * card for the `web-search-exa` namespace — a collapsible PluginCard clone of
 * the official ui-settings-plugins cards (li > header button + disclosure body
 * + staged draft model with 保存/放弃 footer). Built in the
 * window.__ModuleLoader__ bundle format; the factory must stay fully
 * self-contained (only `require` and the injected client services).
 */
window.__ModuleLoader__.load({
  id: "@dsh-local/web-search-exa-settings",
  factory: function (require) {
    const react = require("react");

    const NAMESPACE = "web-search-exa";
    const inject = ["slots", "settingsScope"];

    const FIELDS = [
      { key: "apiKey", label: "API Key", type: "secret", inputMode: null, hint: "Exa API 密钥。留空并保存 = 保持当前值；清除覆盖可恢复为配置/环境变量中的值。" },
      { key: "baseURL", label: "Base URL", type: "text", inputMode: null, hint: "Exa 端点基址，/search 自动追加。默认 https://api.exa.ai" },
      { key: "searchType", label: "Search Type", type: "select", inputMode: null, options: ["auto", "keyword", "neural"], hint: "Exa 检索模式：auto（自动）、keyword（关键词）、neural（语义）。" },
      { key: "numResults", label: "Num Results", type: "number", inputMode: "numeric", hint: "未携带 maxResults 时的默认结果数（可留空）。" },
      { key: "highlightsPerResult", label: "Highlights / Result", type: "number", inputMode: "numeric", hint: "每条结果请求的高亮摘要句数，默认 1。" }
    ];

    /** Draft sentinel: the field's user override should be cleared on save. */
    const CLEAR = Symbol("clear");

    /* Official PluginCard.module.css equivalents as inline styles. */
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
      body: { borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 16px", paddingBottom: 8 },
      readOnly: { color: "var(--dsw-alias-label-tertiary)", margin: "12px 0 0", fontSize: 12, lineHeight: 1.5 },
      footer: { borderTop: "1px solid var(--dsw-alias-border-l2)", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "12px 0 4px", display: "flex" },
      failed: { minWidth: 0, color: "var(--dsw-alias-label-error)", flex: 1, margin: 0, fontSize: 12, lineHeight: 1.5 },
      discard: { appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", background: "none", borderRadius: 8, padding: "5px 14px", fontSize: 13, lineHeight: 1.5 },
      save: { appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid transparent", borderRadius: 8, padding: "5px 14px", fontSize: 13, lineHeight: 1.5, background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)" },
      field: { flexDirection: "column", gap: 6, padding: "12px 0", display: "flex" },
      fieldHead: { alignItems: "center", gap: 8, display: "flex" },
      label: { minWidth: 0, color: "var(--dsw-alias-label-primary)", flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.5 },
      badgeMuted: { whiteSpace: "nowrap", color: "var(--dsw-alias-label-tertiary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
      badgeOn: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 500, lineHeight: "17px" },
      reset: { font: "inherit", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", background: "none", border: "none", padding: 0, fontSize: 12, lineHeight: 1.5 },
      input: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", height: 34, font: "inherit", color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "0 12px", fontSize: 13, lineHeight: 1.5, width: "100%", boxSizing: "border-box" },
      hint: { color: "var(--dsw-alias-label-tertiary)", margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 },
      disabled: { opacity: 0.4, cursor: "default" }
    };

    /** One plugin card controller: mirrors the scope into a store + write actions. */
    function ExaCardController(scope) {
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

    function ExaSettingsCard(props) {
      const snap = react.useSyncExternalStore(props.card.subscribe, props.card.getSnapshot);
      const [open, setOpen] = react.useState(false);
      const [drafts, setDrafts] = react.useState({});
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);

      const loading = snap.status !== "ready" && snap.status !== "idle";
      const writable = snap.writable === true && !loading;
      const user = snap.user || {};
      const base = snap.base || {};

      const dirty = FIELDS.some((meta) => drafts[meta.key] !== undefined);

      const name = "Web Search Exa";
      const description = "网页搜索的 Exa 后端（Provider id: exa）；保存后热生效，无需重启。";

      const stage = (field, text) => {
        setDrafts((prev) => ({ ...prev, [field]: text }));
        setFailed(false);
      };
      const stageClear = (field) => {
        setDrafts((prev) => ({ ...prev, [field]: CLEAR }));
        setFailed(false);
      };
      const discard = () => {
        setDrafts({});
        setFailed(false);
      };

      const save = async () => {
        const staged = FIELDS
          .map((meta) => ({ meta, draft: drafts[meta.key] }))
          .filter((entry) => entry.draft !== undefined);
        if (staged.length === 0) return;
        for (const entry of staged) {
          const { meta, draft } = entry;
          if (meta.type === "number" && draft !== CLEAR) {
            const text = String(draft).trim();
            if (text.length > 0 && !/^[1-9][0-9]*$/.test(text)) {
              setFailed(true);
              return;
            }
          }
        }
        setSaving(true);
        setFailed(false);
        try {
          for (const entry of staged) {
            const { meta, draft } = entry;
            if (draft === CLEAR) {
              await props.actions.unset(meta.key);
              continue;
            }
            if (meta.type === "secret") {
              const text = String(draft).trim();
              if (text.length > 0) await props.actions.set(meta.key, text);
              continue;
            }
            const text = String(draft).trim();
            if (text.length === 0) {
              await props.actions.unset(meta.key);
            } else if (meta.type === "number") {
              await props.actions.set(meta.key, Number(text));
            } else {
              await props.actions.set(meta.key, text);
            }
          }
          setDrafts({});
        } catch (error) {
          setFailed(true);
        } finally {
          setSaving(false);
        }
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
        dirty ? react.createElement("span", { style: S.pending }, "未保存") : null,
        react.createElement(ChevronIcon, { open })
      ),
        open ? react.createElement("div", { style: S.body },
          loading ? react.createElement("p", { style: S.readOnly }, "加载设置中…") :
          !writable ? react.createElement("p", { style: S.readOnly }, "当前设置不可写（无宿主设置服务或只读）。") :
            FIELDS.map((meta) => {
              const overridden = user != null && Object.prototype.hasOwnProperty.call(user, meta.key);
              const current = user[meta.key] !== undefined ? user[meta.key] : base[meta.key] !== undefined ? base[meta.key] : "";
              const draft = drafts[meta.key];
              const display = draft === undefined ? String(current || "") : draft === CLEAR ? "" : String(draft);
              const clearing = draft === CLEAR;
              const controlId = "web-search-exa-" + meta.key;
              return react.createElement("div", { key: meta.key, style: S.field },
                react.createElement("div", { style: S.fieldHead },
                  react.createElement("label", { style: S.label, htmlFor: controlId }, meta.label),
                  clearing
                    ? react.createElement("span", { style: S.badgeOn }, "将清除")
                    : overridden
                      ? react.createElement("span", { style: S.badgeOn }, "已覆盖")
                      : react.createElement("span", { style: S.badgeMuted }, "默认"),
                  overridden || clearing
                    ? react.createElement("button", {
                        type: "button",
                        style: S.reset,
                        disabled: saving,
                        onClick: () => {
                          if (clearing) {
                            setDrafts((prev) => {
                              const next = { ...prev };
                              delete next[meta.key];
                              return next;
                            });
                          } else {
                            stageClear(meta.key);
                          }
                        }
                      }, clearing ? "取消清除" : "清除覆盖")
                    : null
                ),
                meta.type === "select"
                  ? react.createElement("select", {
                      id: controlId,
                      style: S.input,
                      disabled: saving,
                      value: display,
                      onChange: (event) => stage(meta.key, event.target.value)
                    }, meta.options.map((option) => react.createElement("option", { key: option, value: option }, option)))
                  : react.createElement("input", {
                      id: controlId,
                      style: { ...S.input, ...(saving ? S.disabled : {}) },
                      type: meta.type === "secret" ? "password" : "text",
                      inputMode: meta.inputMode || undefined,
                      disabled: saving,
                      placeholder: meta.type === "secret" && String(current || "").length > 0 ? "••••••（已配置，留空保持不变）" : "",
                      value: display,
                      onChange: (event) => stage(meta.key, event.target.value)
                    }),
                react.createElement("p", { style: S.hint }, meta.hint)
              );
            }),
          react.createElement("div", { style: S.footer },
            failed ? react.createElement("p", { style: S.failed, role: "status" }, "保存失败：请检查输入（数字需为正整数）。") : null,
            react.createElement("button", {
              type: "button",
              style: { ...S.discard, ...(!dirty || saving ? S.disabled : {}) },
              disabled: !dirty || saving,
              onClick: discard
            }, "放弃"),
            react.createElement("button", {
              type: "button",
              style: { ...S.save, ...(!dirty || saving ? S.disabled : {}) },
              disabled: !dirty || saving,
              onClick: save
            }, saving ? "保存中…" : "保存")
          )
        ) : null
      );
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      const controller = new ExaCardController(scope);
      ctx.effect(() => scope.subscribe(() => {}), "web-search-exa: card scope sync");
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: NAMESPACE,
        id: NAMESPACE,
        order: 20,
        label: "Web Search Exa",
        inject: () => ({ card: controller.store, actions: controller.actions })
      }, ExaSettingsCard));
    }

    return { apply, inject };
  }
});