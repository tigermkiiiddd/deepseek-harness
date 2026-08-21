# Agent Note: first-class `dsh` team members

Status: implemented

English | [中文](2026-08-16-first-class-dsh-team-members.zh.md)

## Problem

The ACP virtual team lets users add long-lived members that run any ACP server, but every member had to be configured with a custom `command` and `args`. There was no built-in way to make a member be "another dsh" — a peer harness process that runs the same installation as the coordinator, reads the user's saved settings and credentials, and keeps its own sessions isolated. Users who wanted a first-class dsh teammate had to hand-craft a command line and manage home-directory isolation themselves.

## Decision

Add `kind: 'dsh'` as a first-class member kind. When a member is configured (or added at runtime) with `kind: 'dsh'`, the harness resolves the spawn specification itself:

- `command` and `args` are forbidden; the member is launched as `dsh --profile acp`.
- The current Node executable and script are reused, but Node debug/inspect flags are stripped so the child does not collide on the parent's debug port.
- `DSH_HOME` is set to a per-member directory under the main harness home (`<main-home>/members/<member-id>`), so sessions and attachments are isolated.
- `DSH_MAIN_HOME` points back at the coordinator's home, so the member reads the same `settings.yaml`, `.credentials.yaml`, and other home-local files.

The implementation is split across the capability seam:

- `packages/team/team/src/resolve.ts` — `resolveMemberSpec()` expands `kind: 'dsh'` into a `ResolvedMemberSpawnSpec` and validates the mutual exclusion with `command`/`args`.
- `packages/team/team/src/member.ts` — `MemberConnection.spawnSpec()` consumes the resolved spec; `inheritedMemberEnv()` layers `DSH_HOME` / `DSH_MAIN_HOME` after `config.env` so explicit per-member entries still win.
- `packages/team/team/src/index.ts` — the roster record stores `kind`, the reconstruction path spreads it back into `MemberConfig`, and `apply()` now awaits the persisted roster before autostart so `ctx.plugin(team)` settles with the full roster visible.
- `packages/team/team/src/spec.ts` / `types.ts` — durable roster shape and runtime types carry `kind?: 'dsh'` and make `command`/`args` optional.
- `packages/team/tool-team/src/index.ts` — `member_add` accepts `kind: 'dsh'` and omits `command`/`args` from the schema when the kind is chosen.
- `packages/host/apiproxy/src/api/team.ts` and `team.schema.ts` — wire views include `kind` and allow `command` to be omitted.
- `packages/boot/app-boot/src/profile.ts` — new `acp` profile template maps to `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']`.
- `packages/bundle/acp-app` — the bundle patch layer that turns `dsh-base` into an automation-only ACP server: mounts `dsh-acp`, redirects `settings-file` and `credentials-local` to `DSH_MAIN_HOME`, disables HMR, and reserves stdout for ACP JSON-RPC.

Tests cover `resolveMemberSpec()` (argv, env, inspect-flag stripping, validation), kind round-trip through the durable roster, and the `acp` profile auto-init in `app-boot`.

## Alternatives considered

### Hard-code `dsh --profile acp` in the tool schema only

Rejected: the spawn resolution belongs in the team service, not the tool. The same `kind: 'dsh'` member must work whether it is added from config, the model tool, the host API, or future seams, so the expansion is centralized in `resolveMemberSpec()`.

### Reuse the main `DSH_HOME` for the member

Rejected: the member's sessions and attachments would collide with the coordinator's. A per-member home under the main home keeps isolation while still being anchored to the same installation and settings.

### Inherit settings by copying files into the member home

Rejected: copying is racy and would require the team service to know the internal layout of settings and credentials. `DSH_MAIN_HOME` lets the existing settings/credentials providers read from the coordinator home natively.

## Consequences

- A `kind: 'dsh'` member is the easiest way to spin up a peer dsh agent: no custom command, no manual home wiring, and the member uses the coordinator's model settings out of the box.
- The member process is still a trusted peer: it inherits the full parent environment (minus the `DSH_*` namespace) with per-member `env` layered on top.
- The durable roster stores `kind`, so a persisted `dsh` member is re-raised correctly after a restart.
- The `acp` profile is reserved for automation-only use; it has no Host, HTTP server, Web runtime, or browser plugin.
- Custom-command members continue to work unchanged; `kind` is optional and `command` remains required when `kind` is omitted.
