# Agent Note: ACP client access team rebuild

Status: implemented

English | [中文](2026-08-16-acp-client-access-team-rebuild.zh.md)

## Problem

The first cut of the ACP virtual team ([the original Agent Note](2026-08-16-acp-virtual-team.md)) left the harness on the agent side of the protocol only: `dsh-acp` answered external clients, but harness itself had no ACP *client* seam to drive other agent processes. The stop-gap `packages/team/team` implementation behaved like a partial, hand-rolled client: it spawned members lazily, scrubbed their environment of credentials, polled for liveness, reduced member output to plain text, kept no capabilities, and wrote the roster only to memory. That violated the core design constraints (C1–C7) that define what a team member is: an independent ACP agent process the harness connects to as a client, with explicit lifecycle, full protocol fidelity, and durable roster.

## Decision

The team subsystem is rebuilt around a real ACP client access layer. The harness connects to member processes over stdio JSON-RPC as the ACP client; members are independent agents that own their own sessions and persistence. The implementation follows the C1–C7 constraints recorded in the design plan.

### C1 — Client role, not ownership

The harness holds the stdio pipes and the UI aggregation, but it does not own a member's model loop, system prompt, tools, or session data. Member sessions live in the member process and are persisted by the member's own storage. The harness only lists, loads, and drives turns through the ACP protocol.

### C2 — Protocol surface speaks

`MemberConnection` completes the ACP `initialize` handshake and stores the returned `agentCapabilities`. The GUI renders capabilities truthfully: a member without `sessionCapabilities.list` gets no history entry, and a member without `loadSession` shows only new turns. Every `session/update` notification is forwarded losslessly as a `team/member-update` event, carrying text chunks, thought chunks, tool calls, plans, and usage. `session/request_permission` is surfaced as a `team/permission-requested` event and answered through `team.permission`; with no subscriber the member's configured `permission` policy answers automatically.

### C3 — GUI is an aggregator, member view is a projection

The Web GUI adds a global visualization lane (`shell.topbar`) with one node per agent — the main instance plus every member — and links showing the star topology. Node color reflects the live member status pushed by the host. Selecting a member replaces the main view with `MemberView` (ui-team, registered into `shell.overlay`), which projects the member's own topics, the selected topic's conversation streamed from ACP, tool cards, plans, and permission dialogs. The view is driven by the protocol stream, not by reinterpreting harness `SessionEvent` semantics.

### C4 — Team is a deployment shape, not a mode

The team capability is always present when the `team` plugin is loaded. A profile's `cordis.patch.yml` declares members under `team.config.members`; model tools (`member_add`, `member_remove`, `member_start`, `member_stop`, `member_restart`, `member_sessions`, `member_chat`) are mounted permanently by the web-app bundle in the host plane. There is no "team mode" preset and no per-session opt-in.

### C5 — Explicit lifecycle, explicit environment, status push

`start`, `stop`, and `restart` are first-class service methods and model tools. Members with `autostart: true` (the default) are started when the service loads after the roster is merged; operations on a stopped member fail loud instead of lazily spawning. The spawned process inherits the **full parent environment** (credentials included), with `config.env` layered over it. The external status vocabulary is exactly `idle` / `running` / `offline` / `failed`: `idle` means connected with no turn in flight, `running` means a prompt turn is in flight, `offline` means the process is not running, and `failed` means start failed. `connecting` is an internal transition state: during startup a member reads as `offline`. Every migration emits a `team/status` event; the GUI and tools receive pushes, never polls.

### C6 — Roster is deployment data and must persist

The roster (who is in the team and how to spawn them) is the only team state the harness persists. Runtime-added members are written immediately to the `team` storage domain; `removeMember` attempts deletion and logs failures without crashing. On restart the persisted roster is merged with `Config.members`, with config staying authoritative over duplicate ids, and every autostarting member is re-raised.

### C7 — Honest boundary

Under stdio ACP the client owns the pipes: a member process spawned by the harness terminates when the harness terminates. Members that advertise `loadSession` restore their own session history after a restart through their own persistence, not through the harness.

## Alternatives considered

### Patch the lazy, polling, text-only implementation

This would have left the wrong foundation in place: a member that is not a real ACP client would keep inventing semantics (scrubbed env, polling, reduced output, in-memory roster) that contradict the protocol. Rejected in favor of rebuilding the access layer on the actual ACP client contract.

### Keep "team mode" as a preset

A preset that mounts the tool row only for selected sessions was attractive because it matched the first cut. Rejected because the team is a deployment-level capability: once agent servers are declared, every session should be able to add and drive members; gating it behind a session-mode preset would hide the capability from the model arbitrarily.

## Consequences

- The harness can now act as an ACP client toward any ACP-capable agent process, making every dsh instance a potential mesh node: it can be driven as an agent by external clients (`dsh-acp`) and drive other agents as a client (`dsh-team`).
- Member output is streamed and rendered with full protocol fidelity; the GUI is a projection rather than a hand-rolled summary.
- The roster survives restarts, so runtime-added members are re-raised automatically unless `autostart: false`.
- Members are trusted peers that inherit the parent environment; operators must treat member commands and credentials with the same care as the harness process itself.
- `connecting` is deliberately not an observable state; consumers see `offline` during startup and rely on `team/status` pushes for transitions.
