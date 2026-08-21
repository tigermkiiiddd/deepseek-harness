# Agent Note: Rerun truncates and rebuilds the session in place

Status: implemented

English | [中文](2026-08-16-rerun-truncates-and-rebuilds-in-place.zh.md)

## Problem

The user-message re-run / re-edit actions sent the text as an ordinary prompt into the same session: every later message and reply stayed in the log and in the model's context. A first fork-based fix was rejected as product behavior — it created a real branch session in the sidebar for every re-run, which is what the existing branch action already offers. The demanded semantic is in-place: the conversation goes back to just before that message, later content is physically gone, and the session keeps its identity.

## Decision

Rerun is a same-id truncate-and-rebuild across three layers:

- **Persistence** (`dsh-session-persistence` + JSONL/SQLite backends): `PersistenceCoordinator.truncate(id, keepSeqs)` rewrites the durable log to exactly the events with `seq < keepSeqs`, refusing live sessions and foreign format versions. JSONL rewrites the whole artifact (zstd framing forbids byte cuts) with the same synced-temp-file-plus-atomic-publish discipline as repair; SQLite deletes the tail rows and bumps the revision in one transaction. Truncating to zero leaves a materialized header-only session that stays listed.
- **Agent layer** (`dsh-agent` / `dsh-agent-loop`): `ctx.agents.reseed({ sessionId, keepSeqs, meta?, agentOptions?, setup? })` captures the live log's prefix, disposes the live handle (stops the loop, unregisters, unwinds), truncates durable storage, then re-creates the agent under the same session id with the prefix as seed. The header carries over (meta overrides); agent options default to the live agent's.
- **Wire and client**: `session.rerun { sessionId, atSeq }` computes the cut — the last `turn/end` before the anchor, extended forward through out-of-band events but stopping before `agent/inbox/spliced`, because a followup message's admission splice lands before its `turn/start` and would otherwise re-admit the dropped message into the rebuilt inbox. A live session reseeds; a persisted-not-live session is truncated directly. `rerun-unavailable` rejects a past-end anchor. The client's `rerunUserMessage(seq, text)` awaits `sessions.rerun`, which re-baselines the open window (`resync()`, since every seq cursor is stale), then queues the text as an ordinary prompt. The re-edit editor this verb serves is [the in-place editor decision](2026-08-16-reedit-edits-in-place.md).

## Alternatives considered

**Fork to a child session, then prompt there.** Rejected as product behavior: every re-run adds a real branch session to the sidebar, duplicating the existing branch action ([fork decision](../feature/2026-06-30-session-store-fork-api.md)); the user wants the conversation itself rewound.

**Surgical in-place log mutation without rebuilding the agent.** Rejected: every plugin, projection, telemetry cursor, and client window keys on the append-only, monotonic-seq invariant ([event-sourced sessions](../architecture/2026-06-11-event-sourced-sessions.md)); rewriting under a live agent strands all of them. Rebuild-under-same-id reuses the one path that already replays a prefix into fresh state — seeding.

**Graceful cancel of a running turn before truncation.** Unnecessary: any running turn sits inside the dropped region, so its orderly `turn/end` would be truncated away regardless; disposal stops the loop and the rebuild starts clean.

## Consequences

Later content is physically absent from the durable log and the rebuilt agent's context — the model provably cannot see it. The queue and all transient turn state die with the old agent. The session keeps its id, title history (events before the cut), cwd, lineage, and workspace attachment, so the sidebar is unchanged. The initiating client's window re-baselines after the RPC; a second tab connected to the same session is not force-resynced and shows a stale tail until it reconnects. A failed rerun leaves the session untouched. Host tests pin the cut (including the splice back-up), the empty first-turn prefix, cold-session truncation, and the error taxonomy; agent-loop tests pin disposal, durable truncation, and continuation; persistence contract tests pin both backends.
