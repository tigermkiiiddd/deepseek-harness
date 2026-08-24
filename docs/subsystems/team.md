# Team

English | [中文](team.zh.md)

The team subsystem connects independent agent processes to the harness over the [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol): every member is a **complete agent** — its own preset, model, and persisted multi-topic conversations — and the main instance connects to members as an ACP client. The Web GUI shows a global visualization lane at the top of the frame and switches the frame to whichever agent's interface the user selects. The team is not the [subagent seam](subagent.md): members are trusted peers with their own processes and sessions, and the delegation stack is not involved.

Sources: [`packages/team/team`](../../packages/team/team), [`packages/team/tool-team`](../../packages/team/tool-team), the session capability in [`packages/acp/acp`](../../packages/acp/acp), the `team` API domain in [`packages/host/apiproxy`](../../packages/host/apiproxy), and the browser half in [`packages/client/ui-team`](../../packages/client/ui-team). The frame lane is declared by [`packages/client/ui-layout`](../../packages/client/ui-layout) (`shell.topbar`). The decision record is [the ACP virtual team Agent Note](../../.agents/notes/implemented/feature/2026-08-16-acp-virtual-team.md).

## Role model

ACP defines two roles; the same protocol, deployed differently, assigns them differently:

- **Agent** — the driven side: holds and persists sessions, executes tools. In the team, each **member process** is an Agent.
- **Client** — the driving side: lists, loads, and prompts sessions. The **main instance** (the dsh process behind this GUI) is a Client toward members.

The main instance has a dual identity: toward members it is a Client; toward external tools it is itself an Agent (the `dsh-acp` server). Roles follow the connection direction and never imply ownership: a member is not a subagent, and the main instance cannot decide a member's session life.

## Session capability (dsh-acp)

The `dsh-acp` server advertises `loadSession: true` and `sessionCapabilities.list` in `initialize` and implements `session/list` (`listSessions`) and `session/load` (`loadSession`). `loadSession` is idempotent: it seeds the session's event stream and streams the persisted history back as `user_message_chunk` / `agent_message_chunk` notifications; an unknown session id rejects with a request error. This is what lets a caller decide which existing topic to continue, or create a new one with `session/new`. Sessions live in the member process; the caller borrows them.

## The team service (`dsh-team`)

`Config.members[]` declares members — `id`, `title`, `description`, `kind`, `command`, `args`, `cwd`, `env`, `permission`, `autostart`. The service is the ACP client seam: `MemberConnection` spawns the member process, completes the `initialize` handshake, and keeps the member's `agentCapabilities` for the views.

The member lifecycle is explicit — `start` / `stop` / `restart` are first-class verbs, and members with `autostart` (the default) spawn when the service loads. Session operations on a stopped member fail loud instead of lazily spawning. The public status vocabulary is `idle` / `running` / `offline` / `failed` (`idle` means connected with no turn in flight, `running` means a prompt turn is in flight, `offline` means the process is not running, `failed` means start failed); `connecting` is internal-only, so a member reads as `offline` during startup. Every migration emits a `team/status` event — nothing polls.

Members are trusted peers: the spawned process inherits the **full parent environment** (credentials included) **minus the harness's own `DSH_*` namespace** — those keys configure this harness instance and never leak into a member — with `config.env` layered over it. The member's working directory is `config.cwd`, or the harness launch directory when omitted — no caller session workspace is ever bound to a member.

The service exposes:

- `list()` — every member with its status, capabilities, and last error.
- `start` / `stop` / `restart` — the explicit lifecycle.
- `listSessions()` / `loadSession()` / `readHistory()` / `newSession()` — the member's own topics (ACP `session/list`, `session/load`, `session/new`).
- `prompt()` — accepts one turn and returns immediately with a prompt id; the turn's chunks stream as `team/member-update` events and settlement arrives as a `team/turn-end` event.
- `cancel()` — cancels the in-flight turn of one session.
- `permission()` — answers one surfaced `session/request_permission` prompt.
- `chat()` — the blocking convenience for model tools: prompt plus the settled reply.
- `addMember()` / `removeMember()` — runtime roster mutation (see below).
- `onPermissionRequest()` — subscribes a permission handler; while at least one subscriber exists, permission prompts are surfaced (`team/permission-requested` event + `team.permission` answers), otherwise the member's `permission: allow | reject` policy auto-answers.
- `disposeAll()` — stops every member; a dispose-all effect runs on service unload.

The member's `session/update` stream is forwarded losslessly as `team/member-update` events: text and thought chunks, tool calls, plans, usage — the GUI is a projection of the protocol stream, not a hand-rolled summary. Replays collected by `readHistory` are consumed there and not re-forwarded.

### First-class `dsh` members

A member with `kind: 'dsh'` relaunches the current harness installation (`dsh --profile acp`) instead of running a custom command. The harness resolves the spawn spec to the current Node executable and script, strips Node debug/inspect flags so the member does not collide on the parent's debug port, and sets:

- `DSH_HOME` to a per-member directory under the main harness home (`<main-home>/members/<member-id>`), so the member's sessions and attachments are isolated.
- `DSH_MAIN_HOME` to the main harness home, so the member reads the coordinator's `settings.yaml`, `.credentials.yaml`, and any other home-local files.

`command` and `args` must be absent for `kind: 'dsh'`; omitting `kind` requires a custom `command`. This is implemented by `resolveMemberSpec()` in `@deepseek-ai/dsh-team` and consumed by `MemberConnection.spawnSpec()`. The profile template is `@deepseek-ai/dsh-acp-app` (see [`packages/bundle/acp-app`](../../packages/bundle/acp-app/README.md)).

### Durable roster

The roster (who is in the team and how to spawn them) is the only team state the harness persists. Runtime-added members land in the `team` storage domain (`member_add` writes immediately; `removeMember` attempts to delete and logs failures, so a failed delete can resurrect the member on restart). A restart merges the persisted roster with `Config.members` — config stays authoritative over a duplicate id — and re-raises every autostarting member. A deployment without the storage domain keeps a memory-only roster.

## Model tools (tool-team)

`member_sessions` lists members and their topics, `member_chat` chats on a chosen or new topic, `member_add` / `member_remove` mutate the roster (with `kind` / `command` / `args` / `cwd` / `env` / `permission` / `autostart` fields), and `member_start` / `member_stop` / `member_restart` drive the lifecycle — so the main agent can build and drive the team inside a conversation. The tools are a permanent team capability: the web-app bundle mounts the row in the host plane and every session sees it; no preset is involved.

## API domain (host API-proxy)

`team.list` / `team.start` / `team.stop` / `team.restart` / `team.sessions` / `team.history` / `team.newSession` / `team.prompt` / `team.cancel` / `team.permission` / `team.addMember` / `team.removeMember` serve the browser through the standard RPC carrier, delegating to `ctx.team`; absent the team service the domain reports unavailable. Live member output does not ride the RPC carrier: `team/status`, `team/member-update`, `team/permission-requested`, and `team/turn-end` are allowlisted host events forwarded verbatim over the `events.host` SSE stream (the allowlist lives in [`dsh-api-remotes`](../../packages/api/remotes/README.md)).

## GUI design

The Web GUI is a **multi-agent workbench**: one frame, a global visualization lane on top, and the selected agent's own interface below.

```
┌───────────────────────────────────────────────────────────┐
│ ●主实例 ──●成员A ● ──●成员B ⚠        全局可视化栏 (shell.topbar) │
├───────────┬───────────────────────────────────────────────┤
│ 会话列表    │  聊天窗（当前 agent 的会话）                    │
│ (当前      │  历史消息（该 agent 进程里真实持久化的）          │
│  agent     │  [给当前 agent 发消息………………]  [发送]          │
│  的会话)   │                                               │
└───────────┴───────────────────────────────────────────────┘
```

- **Global visualization lane** (`shell.topbar`, declared by ui-layout as a fixed top row above the three columns): one SVG node per agent — the main instance first, then every member — with links between them. Node color carries the live status pushed by the host (`team/status` events folded into the shared view store; nothing polls). Clicking a node switches the current agent; the lane also hosts the new-member form (full member config) and per-node removal.
- **Below the lane**: the current agent's own interface. The main instance shows the regular three columns (this conversation surface). A member shows `MemberView` (ui-team, registered into `shell.overlay`, covering the columns below the lane): the member's own topics (left, capability-gated on `sessionCapabilities.list`), the selected topic's conversation projected from the ACP stream (right) — streaming text, thoughts, tool-call cards, plans, images, usage notes — a composer that sends via `team.prompt` and cancels via `team.cancel`, a permission dialog for `session/request_permission` prompts (approve / reject per option), and a header with the member's live status, lifecycle controls (start / stop / restart), and a "back to main instance" control. A member without `loadSession` gets no history entry: its topics are browse-only.
- Selecting the main instance node hides `MemberView` and restores the columns. The frame becomes a topbar + main-row stack; drag handles and the overlay layer anchor to the main row.

## Data flow

The view reads and drives members through `api.team.*` → `ctx.team` → ACP → the member process, and receives live member output through the forwarded `team/*` remote events. Member sessions and their history are the single source of truth inside the member processes; the view keeps no durable copy. The main instance's own sessions stay local (the regular session stack).

## Configuration

The roster is deployment-configured in the profile's `cordis.patch.yml` (`team` row, `members: []`). An unconfigured deployment renders a lane with only the main instance node. Members can also be added at runtime from the lane's "new member" form or through `member_add`; those members land in the durable roster and are re-raised after a restart unless `autostart: false`.

## Known limitations and deferred work

- **Honest boundary**: under stdio ACP the client owns the pipes, so a member the harness spawned terminates with the harness; a member supporting `loadSession` restores its history after a restart because the sessions live in the member's own persistence, not here.
- Member↔member direct messaging is not exposed; the lane connects the main instance to members only.
- Remote tool calls are opaque to the harness: the member executes its own tools inside its process, and the protocol stream (tool calls, plans, output) is all the harness sees.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxteam--teamservice"></a>

### `ctx.team` — `TeamService`

The team service the plugin provides under `ctx.team`.

```ts cordis-catalog
/**
 * Every member with its live connection status, capabilities, and last error.
 * @returns the list of member snapshots.
 */
list(): MemberSnapshot[]

/**
 * Start one member's process and complete the ACP handshake.
 * @param memberId - the member to start.
 */
start(memberId: string): Promise<void>

/**
 * Stop one member's process and return it to `offline`.
 * @param memberId - the member to stop.
 */
stop(memberId: string): Promise<void>

/**
 * Stop then start one member.
 * @param memberId - the member to restart.
 */
restart(memberId: string): Promise<void>

/**
 * One member's own conversation topics (persisted in the member process).
 * @param memberId - the member whose topics are listed.
 * @param cwd - workspace filter passed to the member; defaults to the member's configured cwd.
 * @returns the member's topic list for that workspace.
 */
listSessions(memberId: string, cwd?: string): Promise<MemberSession[]>

/**
 * Resume one of the member's topics so chat continues its history.
 * @param memberId - the member that owns the topic.
 * @param sessionId - the topic to load.
 */
loadSession(memberId: string, sessionId: string): Promise<void>

/**
 * Load one topic and collect its replayed conversation history.
 * @param memberId - the member that owns the topic.
 * @param sessionId - the topic whose history is replayed.
 * @returns the replayed conversation entries.
 */
readHistory(memberId: string, sessionId: string): Promise<MemberHistoryEntry[]>

/**
 * Load one topic and collect its full-fidelity translated session events.
 * @param memberId - the member that owns the topic.
 * @param sessionId - the topic whose history is replayed.
 * @returns the translated harness event sequence.
 */
readHistoryEvents(memberId: string, sessionId: string): Promise<TranslatedSessionEvent[]>

/**
 * Whether a member currently has a prompt turn in flight for a topic.
 * @param memberId - the member to query.
 * @param sessionId - the member topic to query.
 * @returns true when a turn is in flight.
 */
isTurnInFlight(memberId: string, sessionId: string): boolean

/**
 * Open a new topic on the member and return its id.
 * @param memberId - the member to create a topic on.
 * @returns the new topic id.
 */
newSession(memberId: string): Promise<string>

/**
 * The member's resolved session configuration set plus the model shortcut.
 * The snapshot is derived from options cached when the topic was created,
 * loaded, or updated — create or load the topic first.
 * @param memberId - the member that owns the topic.
 * @param sessionId - the topic whose config is read.
 * @returns the resolved options and the current model, if any.
 * @throws when the member has no cached options for the topic.
 */
getConfig(memberId: string, sessionId: string): Promise<SessionConfigSnapshot>

/**
 * Set one session configuration option (e.g. `"model"`) and return the
 * updated snapshot. The value is validated by the agent.
 * @param memberId - the member that owns the topic.
 * @param sessionId - the topic whose option is set.
 * @param configId - the option id, e.g. `"model"`.
 * @param value - the new value id.
 * @returns the updated snapshot.
 */
setConfig(memberId: string, sessionId: string, configId: string, value: string): Promise<SessionConfigSnapshot>

/**
 * The providers the member advertises, gated on the `providers` capability.
 * @param memberId - the member whose providers are listed.
 * @returns the provider list.
 * @throws when the member did not advertise `providers` in `initialize`.
 */
listProviders(memberId: string): Promise<MemberProviderInfo[]>

/**
 * Configure one provider (member-scoped). The agent stores the routing
 * config on its own side; the harness never persists secrets.
 * @param memberId - the member whose provider is configured.
 * @param config - the provider id, protocol, base URL, and optional headers.
 * @throws when the member did not advertise `providers` in `initialize`.
 */
setProvider(memberId: string, config: MemberProviderConfigInput): Promise<void>

/**
 * Accept one prompt turn and return immediately; chunks stream as
 * `team/member-update` events and settlement as `team/turn-end`.
 * @param memberId - the member to prompt.
 * @param sessionId - the member topic to prompt in.
 * @param text - the user text for this turn.
 * @returns the prompt id assigned to this turn.
 */
prompt(memberId: string, sessionId: string, text: string): Promise<{ promptId: string }>

/**
 * Cancel the in-flight prompt turn of one session.
 * @param memberId - the member whose turn is in flight.
 * @param sessionId - the member topic whose turn is cancelled.
 */
cancel(memberId: string, sessionId: string): Promise<void>

/**
 * Answer one unanswered `session/request_permission` prompt.
 * @param memberId - the member that raised the request.
 * @param requestId - the locally minted request id.
 * @param outcome - the selected option or cancellation.
 */
permission(memberId: string, requestId: string, outcome: TeamPermissionOutcome): Promise<void>

/**
 * Drive one chat turn to completion (blocking convenience for model tools).
 * @param memberId - the member to chat with.
 * @param sessionId - the member topic to chat in.
 * @param text - the user text for this turn.
 * @param signal - optional cancellation signal.
 * @returns the member's committed reply and stop reason.
 */
chat(memberId: string, sessionId: string, text: string, signal?: AbortSignal): Promise<ChatResult>

/**
 * Spawn a new member process at runtime, persist it in the roster, and join it.
 * Omitted `args`/`env` default to empty at this funnel, so every caller —
 * host API, model tool, future seams — is safe.
 * @param config - the member configuration; collection fields optional.
 * @returns the snapshot of the newly added member.
 */
addMember(config: MemberConfigInput): Promise<MemberSnapshot>

/**
 * Stop one member, drop it from the roster, and attempt to delete it from
 * persistence. A failed delete is logged and the record may reappear on restart.
 * @param memberId - the member to remove.
 */
removeMember(memberId: string): Promise<void>

/**
 * Register a permission-request subscriber. While at least one subscriber
 * exists, `session/request_permission` prompts are surfaced (event +
 * `team.permission` answers); with none, the member's `permission` policy
 * auto-answers.
 * @param handler - the subscriber that receives each request.
 * @returns the disposer removing this handler.
 */
onPermissionRequest(handler: TeamPermissionHandler): () => void

/** Stop every member process. Idempotent. */
disposeAll(): Promise<void>
```

Source: [`packages/team/team/src/index.ts`](../../packages/team/team/src/index.ts)

<a id="team-events"></a>

### `team/*` events

<a id="teammember-update--emit"></a>

#### `team/member-update` — emit

One typed `session/update` notification from a member, forwarded losslessly: text/thought chunks, tool calls, plans, usage — the member interface is a projection of this stream. Replays collected by a `readHistory` call are consumed there and not re-forwarded.

```ts cordis-catalog
/**
 * One typed `session/update` notification from a member, forwarded
 * losslessly: text/thought chunks, tool calls, plans, usage — the member
 * interface is a projection of this stream. Replays collected by a
 * `readHistory` call are consumed there and not re-forwarded.
 * @mode emit
 * @param memberId - the member that sent the update.
 * @param sessionId - the member's session the update belongs to.
 * @param update - one lossless ACP session update.
 */
'team/member-update'(memberId: string, sessionId: string, update: SessionUpdate): void
```

Source: [`packages/team/team/src/types.ts`](../../packages/team/team/src/types.ts)

<a id="teampermission-requested--emit"></a>

#### `team/permission-requested` — emit

A member raised `session/request_permission`. The GUI answers through `team.permission`; with no subscriber the deployment policy answers.

```ts cordis-catalog
/**
 * A member raised `session/request_permission`. The GUI answers through
 * `team.permission`; with no subscriber the deployment policy answers.
 * @mode emit
 * @param request - the surfaced permission request.
 */
'team/permission-requested'(request: TeamPermissionRequest): void
```

Source: [`packages/team/team/src/types.ts`](../../packages/team/team/src/types.ts)

<a id="teamstatus--emit"></a>

#### `team/status` — emit

A member's status migrated. Every transition emits exactly one public event (`idle` / `running` / `offline` / `failed`). `connecting` is an internal transition: during startup a member reads as `offline` until the handshake completes. Consumers never poll. `error` carries the failure message on `failed`.

```ts cordis-catalog
/**
 * A member's status migrated. Every transition emits exactly one public
 * event (`idle` / `running` / `offline` / `failed`). `connecting` is an
 * internal transition: during startup a member reads as `offline` until the
 * handshake completes. Consumers never poll. `error` carries the failure
 * message on `failed`.
 * @mode emit
 * @param memberId - the member whose status moved.
 * @param status - the new public status.
 * @param error - the failure message, on `failed`.
 */
'team/status'(memberId: string, status: MemberStatus, error?: string): void
```

Source: [`packages/team/team/src/types.ts`](../../packages/team/team/src/types.ts)

<a id="teamturn-end--emit"></a>

#### `team/turn-end` — emit

A prompt turn settled: the member answered `session/prompt` (or the connection died and the turn was settled `cancelled` locally). A turn the member rejected with a protocol error carries `error`; consumers must branch on `error` first and treat `stopReason` as a placeholder.

```ts cordis-catalog
/**
 * A prompt turn settled: the member answered `session/prompt` (or the
 * connection died and the turn was settled `cancelled` locally). A turn
 * the member rejected with a protocol error carries `error`; consumers
 * must branch on `error` first and treat `stopReason` as a placeholder.
 * @mode emit
 * @param memberId - the member whose turn settled.
 * @param sessionId - the member's session the turn belonged to.
 * @param promptId - the prompt id minted when the turn was accepted.
 * @param stopReason - the ACP stop reason the member returned.
 * @param error - the failure message when the member rejected the prompt.
 */
'team/turn-end'(memberId: string, sessionId: string, promptId: string, stopReason: StopReason, error?: string): void
```

Source: [`packages/team/team/src/types.ts`](../../packages/team/team/src/types.ts)
<!-- END GENERATED cordis-surface -->
