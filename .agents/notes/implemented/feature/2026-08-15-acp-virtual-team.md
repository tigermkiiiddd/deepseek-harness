# Agent Note: DSH ACP virtual team — members own their sessions

Status: implemented

English | [中文](2026-08-15-acp-virtual-team.zh.md)

## Problem

The harness had no way to run a team of **persistent, independent ACP agent processes** as first-class members: `dsh-subagent-acp` drives one-shot children only, subagent continuable children are parent-owned mirror sessions (rejected design, see history), and nothing let a caller browse a member's own conversation topics and choose to continue one or open a new one.

## Decision

A member is a persistent ACP agent process that **owns its sessions and their history**; the harness only connects and drives it through the Agent Client Protocol. Three new packages plus a server enhancement:

1. **`dsh-acp` server session capabilities** — `session/list` (persisted topics, cwd-filterable) and `session/load` (resume a persisted session by seeding its event log into a fresh agent). `loadSession` additionally **replays the topic's history** to the client as `user_message_chunk` / `agent_message_chunk` notifications, the protocol's contract for rendering a topic without a second read path. Capabilities are declared (`loadSession: true`, `sessionCapabilities.list`).
2. **`@deepseek-ai/dsh-team`** — the `team` service owns one process per configured member (`members` roster: `command`/`args`/`cwd`/`env`/`permission`). Operations: `list`, `listSessions`, `loadSession`, `readHistory` (load + collect the replayed history), `newSession`, `chat`, `close`, `disposeAll`. Members respawn on demand; their persisted topics remain listable/loadable through the member's own persistence. `cwd` binds at first use (config wins, else the first caller session's workspace).
3. **`@deepseek-ai/dsh-tool-team`** — model-facing `member_sessions` and `member_chat` (continue a `topic` or `new_topic`).
4. **`@deepseek-ai/dsh-client-ui-team`** — the Web team view: a sidebar action toggling an overlay panel (roster → topics → replayed history → composer), driven by JSON-RPC-style fetch routes (`/api/team/*`) bridged to the team service.

## Alternatives considered

- **Continuable subagent mirror sessions** (the earlier implementation) — rejected by the team requirement: members are first-class agents with their own sessions, not parent-owned children.
- **A GUI-side mirror of member conversations** — rejected: the member's own history is the truth; the panel reads it through `loadSession`'s replay.
- **Remote (typert) methods for the browser bridge** — deferred: the `/api/team/*` HTTP bridge is simpler and the panel is a first version; a Remote surface can replace it without touching the service.

## Consequences

- Members = independent ACP processes (dsh-acp-demo instances with their own presets, or any ACP server such as Grok's CLI); each owns its topics and memory. The harness never mirrors or stores member sessions.
- Callers (the model via tools, the user via the team view) browse a member's topics and choose to continue or start fresh — the ACP-native model the requirement asked for.
- Deployments configure the roster in the host `team` row (`members: []` by default) and mount `tool-team` in agent presets.
- Covered by keyless integration tests: acp session list/load/history (7), team service (8), tool-team (3), all against the scripted mock ACP agent over real stdio.
- Known limitations: one process per member (no pooling), local workspaces only, remote tool calls opaque, no member-to-member direct messaging yet, panel styling is minimal.
