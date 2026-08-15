# Agent Note: ACP virtual team — peer ACP agent processes as persistent team members

Status: implemented

English | [中文](2026-08-16-acp-virtual-team.zh.md)

## Problem

The harness user asked for a virtual AI team: long-lived members that keep their own persona, model, and persisted multi-topic conversations, communicate peer-to-peer (main ↔ member, member ↔ member), and appear in the GUI as a roster with per-topic chat history. The existing delegation paths do not provide this: subagents are short-lived, initiator-owned children whose sessions belong to the parent session and die with it, and a continuable mirror is still a single-session extension of the caller. Members must be independent agent processes that own their sessions and survive the main instance.

## Decision

A team member is an **independent ACP agent process** (JSON-RPC over stdio), and the team is a peer connection between the main instance and those processes. ACP is the transport seam because it is the harness's automation-only agent protocol: a member runs any ACP-capable agent, declares its session capabilities, and owns its sessions.

- `packages/acp/acp` — the dsh-acp server now advertises `loadSession: true` and `sessionCapabilities.list`, and implements `session/list` (`listSessions`) and `session/load` (`loadSession`). `loadSession` is idempotent, seeds the session's event stream, and streams the persisted history back as `user_message_chunk` / `agent_message_chunk` notifications; an unknown session id rejects with a request error. This is what lets the caller (the main instance) decide which existing topic to continue, or create a new one with `session/new`.
- `packages/team/team` (`@deepseek-ai/dsh-team`) — the host team service. `Config.members[]` declares members (id/title/description/command/args/cwd/env/permission). `MemberConnection` spawns and initializes the process on first use, then exposes `listSessions`, `loadSession`, `readHistory` (replays the load stream), `newSession`, and `chat` (prompt + wait for the settled reply). Cooperative teardown closes the process; a dispose-all effect runs on service unload.
- `packages/team/tool-team` (`@deepseek-ai/dsh-tool-team`) — model tools `member_sessions` (list a member's topics) and `member_chat` (chat on a chosen or new topic), so the main agent itself can work with members.
- `packages/host/apiproxy` — a `team` API domain (`team.list` / `team.sessions` / `team.history` / `team.newSession` / `team.chat`) served over the standard RPC carrier, delegating to `ctx.team`; absent the team service it reports the domain unavailable.
- `packages/client/ui-team` (`@deepseek-ai/dsh-client-ui-team`) — the Web team view: a `sidebar.footer.action` entry toggles a `shell.overlay` panel that lists the roster, a member's own topics, a topic's replayed history, and the composer for a chosen topic. All data crosses `api.team.*` through the formal host API (the connection's `IApiClient`), never a hand-rolled fetch bridge.
- The "ACP 团队模式" agent preset (`~/.dsh/.agent-presets/team/`) mounts the tool-team row for sessions that want the model-facing member tools.

Member sessions and their history live **in the member processes**; the main instance only lists, loads, and drives them. Members are not subagents and not mirrors — the delegation stack is not involved.

## Alternatives considered

### Subagent / continuable-mirror delegation

The harness's own delegation: initiator-owned children, parent-session-bound history, lifecycle tied to the caller. Rejected by the user explicitly — members must own their sessions and outlive the main session; this path also cannot give members independent multi-topic lives or peer-to-peer communication.

### A single-model "grok-style" integration

The user cited external agents (hermes, grok) as *examples* of what an agent is, not as the subject. A bespoke single-provider integration was rejected for scope and naming: the real concept is the agent protocol itself, so the team is built on ACP and works with any ACP-capable member process.

## Consequences

- Members are fully independent processes: they keep running and keep their sessions even when the main instance is gone; the main instance reconnects and continues a topic through `session/load`.
- The GUI shows each member's own topics and per-topic history; switching topics is a `loadSession` on the member, not a local view.
- Every member consumes real resources (process, API quota) and real commands can execute on their behalf; the roster is deployment-configured (`Config.members`), and an unconfigured deployment shows an empty roster.
- The team surface is read/drive only: the panel keeps no durable copy of member conversations, and chat returns the settled reply (no streaming in the panel yet).
