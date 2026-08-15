# @deepseek-ai/dsh-tool-self-cognition

English | [中文](README.zh.md)

The self-cognition entry: a system-prompt section that tells the agent it can evolve by editing its own source checkout, plus the read-only `self_cognition` tool that reports the live composition. Mounted by the `cordis` agent preset.

## What it does

Two contributions on the agent plane:

- A `harness:self-cognition` prompt section at order `-97`, between `harness:source` and the persona. When a source checkout is detected it names the absolute root and the workflow entry points; when none exists it says so instead of advertising a path this deployment does not have.
- One tool, `self_cognition()`, on `ctx.tools`. Every call re-reads live state — nothing is cached: the source checkout root, the session's agent preset with its flattened plugin entries (`agentPresets.readEntries`), and every non-group Loader entry with its enabled state and fiber phase.

## Source checkout detection

At mount time the package walks up from its own module URL to the first directory carrying `pnpm-workspace.yaml`, `AGENTS.md`, and `packages/`. Finding none means the deployment carries no source checkout — a normal installed-profile state, reported as `sourceCheckout.available: false`, not an error.

## Routing: source vs dynamic

Permanent capabilities belong to source edits mounted through a preset's `cordis.yml` (the `self-development` skill in the `cordis` preset carries that workflow); temporary, session-scoped, or experimental extensions belong to dynamic Cordis plugins (the `cordis-plugin-development` skill). The section text and both skills state this split in both directions, so the agent picks an existing path instead of improvising one.

## Configuration

None.

## Rendering

The canonical result renders as indented JSON text. The tool declares no presenters, so surfaces fall back to the `generic` card.

## Export shape

A function/namespace plugin: named exports `name` / `inject` / `apply`, no default export ([docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)). It injects `loader`, `systemPrompt`, and `tools`; the preset roster is optional and read through `ctx.get('agentPresets')`.

## Model Experience

### System prompt

#### What the model sees

One section named `harness:self-cognition`. The available variant interpolates the absolute checkout root detected at mount time; the unavailable variant replaces the source-editing guidance with a plain statement that this deployment carries no checkout.

##### Self-cognition section (source checkout available)

```markdown
You are running on DeepSeek Harness from its source checkout at <absolute checkout root>. You can evolve yourself permanently by editing that checkout: read `AGENTS.md` and `docs/architecture.md` first, then load the `self-development` skill for the full workflow. Source changes take effect on the next process start; they never hot-reload into this session.

The `self_cognition` tool reports your live composition: mounted plugins, the agent preset this session was composed from, and its plugin entries.

Temporary, session-scoped, or experimental extensions belong to dynamic Cordis plugins instead — load the `cordis-plugin-development` skill for those, and do not edit the checkout for one-off needs.
```

##### Self-cognition section (no source checkout)

```markdown
You are running on DeepSeek Harness. The `self_cognition` tool reports your live composition: mounted plugins and the agent preset this session was composed from. This deployment does not carry the harness source checkout, so source-level self-development is unavailable here; temporary or session-scoped extensions can still be built as dynamic Cordis plugins — load the `cordis-plugin-development` skill for those.
```

#### Token effect

Small fixed input cost on every request where this plugin is in scope; the variant is chosen once at mount.

#### KV Cache effect

Prefix-stable while the plugin and its detected checkout root are unchanged. Mounting or disposing the plugin invalidates reuse from this section onward.

### Tool schema

#### What the model sees

The model sees the generated [`self_cognition` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-self-cognition).

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle changes may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

The call takes no arguments. A success returns one JSON object: `sourceCheckout` (`available` plus `root` when detected), `preset` (the session preset `id` with its flattened `entries` of `{ id, name, disabled }`, or `unavailable: true` with a `reason`), and `plugins` (one row per mounted non-group plugin: `id`, `name`, `enabled`, and `fiberPhase`, which is `null` for a disposed or never-started entry). A session whose preset id no longer resolves fails loud as a tool error from the roster.

#### Token effect

The result grows with the mounted-plugin and preset-entry counts and stays in call history until compaction.

#### KV Cache effect

Append-only; the result follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Mount-time root detection** — the checkout root is resolved once when the plugin mounts; moving the checkout takes effect on the next process start, like any source change.
- **Preset entries need the roster** — compositions without `agentPresets` (for example headless) report `preset.unavailable` with the reason; the tool never guesses at a composition source.
- **Read-only by design** — self-modification happens through source edits plus a process restart; this package deliberately registers no write path.
