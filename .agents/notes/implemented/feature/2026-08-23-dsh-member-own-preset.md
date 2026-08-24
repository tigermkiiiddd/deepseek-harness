# Agent Note: dsh members own their preset

Status: implemented

English | [中文](2026-08-23-dsh-member-own-preset.zh.md)

## Problem

Every team member was supposed to be a unique agent with its own persona, but `member_add` carried no way to give one: a `dsh` member relaunched the same installation as the coordinator and composed from the deployment's default preset. Two shapes were rejected before this one: picking an id out of the shared preset roster (a member would share its persona with every other agent that named the same id), and a runtime `member_persona` switch tool over ACP session config options (built, then cut by the user — switching personas per session is not what "each member is a unique person" means).

## Decision

A member's persona is data written into the member's own home at creation. `MemberConfig` gains an optional `preset` field — a YAML top-level list of plugin rows (persona, tools, prompt sections) — and `member_add` exposes it as a parameter. Only `kind: 'dsh'` members carry one; `resolveMemberSpec` fails loud on a preset without `kind: 'dsh'`, because only dsh members have a harness home to hold it.

At creation, `seedMemberHome` seeds the composition into `<memberHome>/.agent-presets/<presetId>/agent.cordis.yml` and points the member's settings at it (`agent-presets.default`), so every session the member creates composes from its own preset instead of the deployment default. The preset id is derived from the member id (lowercased, non-`[a-z0-9]` runs collapsed to `-`) and must satisfy the preset-id grammar; a composition that fails the loader's shape check rejects `addMember` loud — validation lives in one place, `compositionTextProblem`, extracted from `dsh-agent-presets` discovery so the team package never re-implements the entry-list rules.

Seeding is idempotent per home: an existing member home is never re-seeded, so a restart cannot clobber edits the member made to its own composition — the same guarantee the settings and credentials copies already had. Config-declared and roster-restored dsh members seed at load (warn on failure, boot continues); runtime additions seed in `addMember` (fail loud). The roster record carries the preset text, so a member whose home was deleted out from under it gets its own preset restored from the roster on restart.

The ACP bridge composes each created agent from the mounted preset roster (`presets.mount(agentCtx)`); that is the only route a member's own persona takes into effect. There is no runtime persona-switching tool: the `member_persona` addition and the ACP persona config option were removed, leaving the model selector as the sole session config option alongside the already-shipped `member_model`.

## Alternatives considered

**Pick an id from the shared preset roster.** Rejected by the user: presets are a shared catalog; a member that names one shares its persona with every other agent that names it. Each member is to be unique, so each gets its own composition.

**A `member_persona` runtime switch (ACP session config option).** Built and then rejected by the user as the wrong feature: per-session persona switching contradicts "each member is a unique person." Removed from the bridge, the tool package, and their tests; the model selector stays because it backs the shipped `member_model`.

**Store the preset text in the roster record.** Adopted, not as the primary store (the member home is) but as durable state that survives home deletion: the roster already re-spawns the member, so restoring its persona from the same record is the cheapest correct recovery.

## Testing

`compositionTextProblem` is unit-tested directly in `dsh-agent-presets` (`!!js` accepted, non-list and malformed YAML rejected). `seedMemberHome` tests pin the preset path: composition lands at `<memberHome>/.agent-presets/<id>/agent.cordis.yml`, settings point at it while keeping every other section (YAML and JSON documents), the derived id sanitizes an unsanitized member id, a broken composition rejects loud, and a re-seed never overwrites the member's own edits. `resolveMemberSpec` rejects a preset without `kind: 'dsh'`; `member_add` passes the preset through to `addMember`. The ACP bridge tests keep asserting the model-only session config options.

## Consequences

A dsh member is now as unique as the composition written for it, with no shared-roster indirection and no runtime switching. The cost: the persona is fixed for that home's lifetime — changing it means editing the member home's preset file or removing and re-adding the member — and roster records grow by the size of each member's composition. Pre-release, both are acceptable; a later runtime-recompose feature would be a new decision, not a relaxation of this one.

This note extends the [ACP virtual team](2026-08-16-acp-virtual-team.md) and [ACP member model and provider configuration](2026-08-23-acp-member-model-and-provider-config.md), which own the member lifecycle, topic chat, and model/provider configuration.
