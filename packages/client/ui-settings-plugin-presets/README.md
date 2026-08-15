# @deepseek-ai/dsh-client-ui-settings-plugin-presets

English | [中文](README.zh.md)

Read-only **By preset** tab for Web Settings → Plugins. The browser plugin registers one localized `settings.plugins.tab` contribution with id `by-preset`; the Plugins section owns the navigation entry and tab chrome. It performs no API call during plugin activation. Selecting the tab for the first time mounts it and lazily calls `api.agentPresets.list()`, then `api.agentPresets.readEntries()` for each non-broken preset.

The tab renders one collapsible card per preset. Each card header shows the preset display name (falling back to its id), a trust badge, and a default badge when the preset is the deployment default. Expanding a card reveals its flattened plugin entries: the short module name plus the entry id, with disabled rows muted and marked. Broken presets show their broken reason instead of entries; a failed per-preset read is isolated to that card so the rest of the roster remains visible. Loading, empty, and generic failure states stay local to the mounted component, and a failed roster read can be retried without exposing transport details. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package only visualizes a Host-owned deployment snapshot in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per Settings mount or retry** — the tab does not subscribe to roster changes or automatically refetch after reconnect; switching tabs preserves the current snapshot, while reopening Settings obtains a new one.
- **Read-only preset view** — the tab offers no preset authoring, copying, or deletion controls.
