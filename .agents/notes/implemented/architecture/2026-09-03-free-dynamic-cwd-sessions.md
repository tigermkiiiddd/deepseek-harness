# Agent Note: Free (dynamic-cwd) sessions — relative-path resolution without a fixed directory

Status: implemented

English | [中文](2026-09-03-free-dynamic-cwd-sessions.zh.md)

## Problem

`SessionHeader.cwd` has always been optional, so the session core already supports a session created without a working directory. But every model-facing tool that resolves a relative path against the session's workspace did `header.cwd ?? process.cwd()`: a session with no immutable cwd silently resolved relative paths against the server's launch directory. That is an implicit, non-recoverable working directory — a relative path in such a session could land anywhere inside the deployment's process cwd regardless of what the model intended, and there was no way for the model to choose a directory at runtime.

The immutable `SessionHeader.cwd` is deliberately frozen at creation (`deepFreeze`, persisted as storage metadata). It cannot be changed mid-session, and for sessions that should be free — not pinned to any one directory — it is never set at all.

## Decision

Introduce the concept of a **free (dynamic-cwd) session**: a session whose `SessionHeader.cwd` is absent. Its effective working directory is a runtime value the model can switch with a new `set_cwd` tool, persisted as a durable `session/cwd` event so it survives resume and replay. Tool relative-path resolution follows a single, authoritative chain that never falls back to `process.cwd()`:

1. an explicit absolute path — used as-is (works for every session);
2. else the session's effective cwd: the immutable `header.cwd` for fixed sessions, or the last `session/cwd` event for free sessions;
3. else — a free session with no directory yet and a relative path — reject with `no session working directory: pass an absolute path, or set one with the set_cwd tool`.

A fixed session (one that HAS a header cwd) is unchanged: it ignores any `session/cwd` event and never receives one from `set_cwd`, which rejects it.

### Where the pieces live

- `packages/core/session/src/current-cwd.ts` — `currentSessionCwd(session)`: the one authoritative resolver. Fixed sessions return `header.cwd`; free sessions return the last `session/cwd` event, else `undefined`. Every consumer (fs tools, search, bash, pwsh, sandbox policy, system prompt `{{cwd}}`) uses it, so the dynamic directory behaves identically across surfaces.
- `SessionEventMap['session/cwd']` — a durable, log-only, whole-snapshot event (`{ cwd: string }`). Appending it persists the current directory; replay folds it back. It is not a `SurfaceEventType`, so it never produces model messages by itself. The generator (`gen-persistence-catalog`) admitted it into `KNOWN_SESSION_EVENT_TYPES`.
- `packages/fs/tool-fs/src/set-cwd.ts` — the `set_cwd` model tool. Validates an absolute path and the session is free, then appends `session/cwd`.
- `packages/fs/tool-fs/src/session-cwd.ts` — `sessionCwd`/`sessionResolveOptions` now route through `currentSessionCwd`; relative-with-no-directory on a free session throws the refusal.
- `packages/fs/tool-fs-search/src/search-core.ts` — `runRipgrep` derives its spawn `workdir` through `currentSessionCwd`; a free session with no directory refuses (`SEARCH_NO_CWD`) rather than spawning from `process.cwd()`.
- `packages/shell/tool-bash`, `packages/shell/tool-pwsh` — `resolveWorkdir` returns the effective cwd and refuses a no-directory free session for a relative/omitted `workdir`.
- `packages/sandbox/sandbox-policy` — the `workspace-write` root resolves through `currentSessionCwd` (still falling back to the configured deployment root so a workspace-write boundary always has a concrete root).
- `packages/core/agent-loop` — the `{{cwd}}` prompt variable resolves through `currentSessionCwd`.
- Web GUI — the workspace picker flow gains a **Free session** entry that calls the new `ctx.workspaces.startFreeSession()` (a `session.create({})`, no workspace). Free sessions already land in the ungrouped bucket: the workspace entity refuses to attach a headerless-cwd session to a directory workspace, and the client groups such sessions under `group.ungrouped`.

## Alternatives considered

### Store the dynamic cwd in the header

`header.cwd` is immutable and kept outside the conversation log as storage metadata. Widening it to a mutable field would (a) require a persistence schema change, (b) blur "the directory the session was created in" with "the directory the session currently uses", and (c) fail the repository invariant that model-visible inputs be reconstructable from the log. A `session/cwd` event keeps the two concerns distinct and satisfies "Model-visible ⟺ logged" for free.

### Keep `process.cwd()` as the no-cwd fallback

This is the behavior being removed. The whole problem is that a free session then silently targets the server's working directory, which both surprises the model and is unrecoverable. Refusing with a clear `set_cwd` remedy is the honest alternative the user selected.

## Consequences

- A free session's tool calls act on a single, logged, switchable directory; the model can move between directories with `set_cwd` and the change persists across resume.
- A fixed session's behavior is byte-for-byte unchanged; it never sees a `session/cwd` event and `set_cwd` rejects it.
- Relative paths in a free session with no directory fail loudly instead of silently landing in `process.cwd()`.
- Because the directory is a durable event, replay/history reconstruction sees the same directory that a resumed session uses.
- The default fallback to `process.cwd()` remains only for genuinely agent-less (non-session) tool calls and for sandbox policy's configured deployment root, never for a session the model drives.
- Under `workspace-write` sandbox policy, a free session's writable boundary IS its current `set_cwd` directory and moves with every switch (accepted 2026-08-15: roaming is the free session's point; `workspace-write` confines the present write location, not lifetime reach). The semantics are stated where the model can see them: the `set_cwd` tool description, the `tool:set-cwd` prompt section, and the `sandbox:policy` context render.

## Invariant

`currentSessionCwd` checks `header.cwd` first and always returns it for a fixed session, so a `session/cwd` event can never override an immutable fixed directory. `set_cwd` additionally refuses a fixed session at the source.
