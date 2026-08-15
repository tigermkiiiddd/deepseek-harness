# Agent Note: Self-cognition entry and source-level self-development

Status: implemented

English | [中文](2026-08-15-self-cognition-entry.zh.md)

## Problem

The harness teaches its agent exactly one self-extension path: the dynamic Cordis toolset (`@deepseek-ai/dsh-tool-cordis` plus the `cordis-plugin-development` skill), whose defining property is that everything it builds is process-local and gone on restart. The prompt claims dynamic plugins are "one available implementation mechanism", but the other mechanism — editing the harness's own source checkout — was never documented anywhere the model can see: no prompt section, no skill, no tool. The `harness:source` section names a checkout path only in the Web bundle behind `surfaceContext`, and teaches no workflow.

The predictable failure showed up in practice: an agent asked for self-knowledge improvised an orphan package (`tool-selfops`) with hardcoded deployment values, no mount point, no tests, and no README — not because the model is careless, but because no guidance existed for what "correct" looks like. Meanwhile users who want a permanent capability get a temporary plugin, and users who want a quick experiment risk source edits, because nothing routes between the two.

## Decision

The `cordis` agent preset — already the "develop the harness itself" composition — gains a source-level self-development entry with three parts.

**Self-cognition plugin** ([`@deepseek-ai/dsh-tool-self-cognition`](../../../../packages/extensions/tool-self-cognition/README.md)). A `harness:self-cognition` prompt section (order `-97`) tells the agent it runs from a source checkout (absolute path interpolated) and can evolve by editing it, with changes taking effect on the next process start — never hot-reloaded. When no checkout is detected (an installed profile), the section says so instead of advertising a missing path. The read-only `self_cognition` tool re-reads live state per call: the checkout root (walking up from the module URL to the first directory with `pnpm-workspace.yaml` + `AGENTS.md` + `packages/`), the session's preset id with its flattened plugin entries via `agentPresets.readEntries`, and every non-group Loader entry with enabled state and fiber phase. No deployment value is hardcoded; everything comes from live services.

**`self-development` skill** (`apps/cli/config/agent-presets/cordis/skills/self-development/SKILL.md`). The source-editing workflow: confirm the checkout via `self_cognition`, read `AGENTS.md` and `docs/architecture.md`, design as a plugin on documented extension points, implement per `docs/cookbook/adding-a-package.md` / `adding-a-tool.md`, mount through the preset's `cordis.yml` plus the resolver manifest, verify with focused checks, and finish with bilingual README and Agent Note. It states plainly that source edits take effect on the next process start and must never be claimed live in the current session.

**Explicit two-path routing.** `tool-cordis`'s system prompt now says a dynamic Plugin is the wrong home for a permanent capability and points at `self-development` when a checkout is reported; `cordis-plugin-development` opens with a lifetime routing table; the new section and skill carry the reverse rule (one-off needs must not touch the checkout). Each path names the other, so the agent selects rather than improvises.

The improvised `tool-selfops` package was deleted in the same change; it was untracked, unmounted, and its hardcoded `expectedConfigNote` is exactly the failure mode this entry exists to prevent.

## Alternatives considered

- **Runtime hot-reload self-development** — letting the agent replace its own packages in the live process. Rejected: it couples self-modification to the most fragile lifecycle machinery in the runtime for little gain; a restart is cheap, and the dynamic toolset already covers the process-local case. The user-facing contract "edit source, restart, verify" is also what every repository check (typecheck, build, snapshot) already assumes.
- **Mounting the entry in `standard` (or every) preset** — rejected: agents that are not developing the harness would pay a standing prompt and tool cost for a capability they should never use, and telling every coding agent it may rewrite its own runtime invites scope creep. The `cordis` preset is the opt-in composition for this work.
- **A new dedicated `self-dev` preset** — rejected as duplication: the `cordis` preset already carries the dynamic toolset and the development skills; a fork would drift.
- **Repairing `tool-selfops` instead of replacing it** — rejected: its design was a settings/config reader with fabricated values, not a composition reporter; nothing in it was worth keeping, and it was never mounted or tracked.
- **Prompt-only self-cognition (no tool)** — rejected: a static section cannot answer "what am I made of right now" (preset entries, fiber states), and baking live facts into the prompt would violate the model-visible ⟺ logged rule's spirit by staleness.

## Consequences

An agent in the `cordis` preset now has a documented, verified path from "add a capability to yourself" to a mounted, tested package — and an explicit rule for when NOT to use it. The cost is a standing prompt section and one tool schema in that preset only, plus snapshot churn whenever the section text or routing guidance changes (model-visible text). Source checkout detection trusts filesystem markers (`pnpm-workspace.yaml` + `AGENTS.md` + `packages/`); a foreign directory tree mimicking all three would be misread as the harness checkout, which is accepted as a same-machine trust assumption. The routing edits touch `tool-cordis`'s model-facing prompt, so the dynamic-plugin guidance and the source path must be kept consistent as either evolves.
