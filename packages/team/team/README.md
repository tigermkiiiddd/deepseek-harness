# @deepseek-ai/dsh-team

English | [中文](README.zh.md)

Team-member connections for the DSH ACP virtual team. A **member** is a persistent ACP agent process that **owns its own sessions (topics)** — its conversation history lives in the member's process and persistence, never in this harness. Members are either a first-class `dsh` peer (the harness relaunches the current installation as an ACP server) or any custom ACP server (`dsh-acp-demo`, etc.). The `team` service is the ACP client seam: it spawns the member process, completes the `initialize` handshake, keeps the member's capabilities, and drives turns through the Agent Client Protocol.

## Service

`ctx.team` (plugin `@deepseek-ai/dsh-team`, config `members`):

| Member | Meaning |
|---|---|
| `list()` | Every member with its public status, capabilities, and last error. `idle` = process up, no prompt turn in flight; `running` = a prompt turn in flight; `offline` = process not running; `failed` = the last start failed. Connecting is internal-only; during startup a member keeps its previous public status (initially `offline`). |
| `start(id)` / `stop(id)` / `restart(id)` | The explicit lifecycle; `autostart` (default) spawns members at load. Operations on a stopped member fail loud. |
| `listSessions(id, cwd?)` | The member's own conversation topics (via ACP `session/list`). When the member is running the list is refreshed live; when it is offline the last cached list is returned, or it fails loud if never cached. |
| `loadSession(id, sessionId)` | Resume one topic on the member (via ACP `session/load`). |
| `readHistory(id, sessionId)` | Load a topic and collect its replayed conversation history (the member's own record). Works offline from the durable cache when the member is not running. |
| `readHistoryEvents(id, sessionId)` | Load a topic and return the full-fidelity translated harness event sequence (`turn/start`, `user/message`, `assistant/message`, `assistant/chunk`, `tool/call`, `tool/result`, …) for rendering in the main conversation UI. Works offline from the durable cache when the member is not running. |
| `isTurnInFlight(id, sessionId)` | Whether the member currently has a prompt turn in flight for the topic. |
| `newSession(id)` | Open a new topic on the member (via ACP `session/new`). When the member advertises session config options, the returned topic's config is cached. |
| `getConfig(id, sessionId)` | The resolved session configuration set plus the model shortcut, derived from the options cached when the topic was created, loaded, or updated. Throws when the member has no cached options for the topic. |
| `setConfig(id, sessionId, configId, value)` | Set one session configuration option (e.g. `"model"`) and return the updated snapshot. The value is validated by the agent. |
| `listProviders(id)` | The providers the member advertises, gated on the `providers` capability. Throws when the member did not advertise `providers` in `initialize`. |
| `setProvider(id, config)` | Configure one provider (member-scoped). The agent stores the routing config on its own side; the harness never persists secrets. Throws when the member did not advertise `providers`. |
| `prompt(id, sessionId, text)` | Accept one turn and return immediately with a prompt id; chunks stream as `team/member-update` events, settlement as `team/turn-end`. |
| `cancel(id, sessionId)` | Cancel the in-flight turn of one session. |
| `permission(id, requestId, outcome)` | Answer one surfaced `session/request_permission` prompt. |
| `chat(id, sessionId, text, signal?)` | Blocking convenience for model tools: prompt plus the settled reply (text + stop reason). |
| `addMember(config)` / `removeMember(id)` | Runtime roster mutation. `addMember` writes to the durable roster immediately; `removeMember` attempts to delete it and logs failures, so a failed delete can resurrect the member on restart. |
| `onPermissionRequest(handler)` | Subscribe a permission handler; with a subscriber, prompts are surfaced (event + `team.permission`), otherwise `permission: allow | reject` auto-answers. |
| `disposeAll()` | Stop every member process; a dispose-all effect runs on service unload. |

Status events (`team/status`) fire on every migration; member output arrives as lossless `team/member-update` events. Nothing polls.

The plugin also mounts a generated browser-safe `team` Remote namespace. Its methods expose roster rows without ACP capability objects and provide lifecycle, topic-list, topic-create, add, and remove operations to Web clients.

## Member configuration

```yaml
- id: team
  name: '@deepseek-ai/dsh-team'
  config:
    members:
      - id: architect
        title: 架构师
        description: system design
        command: node
        args: ['--import', 'tsx', './packages/examples/acp-demo/src/bin.ts', '--config', './members/architect/cordis.yml']
        cwd: /path/to/workspace
        env:
          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
        autostart: true
```

Each member is one process. Members are trusted peers: the child inherits the **full parent environment** (credentials included) **minus the harness's own `DSH_*` namespace** — those keys configure this harness instance and never leak into a member — with `env` layered over it. `cwd` is the member's working directory and session workspace — the harness launch directory when omitted; no caller session workspace is ever bound to a member. `permission: allow | reject` is the fallback policy for `session/request_permission` when no GUI subscriber answers.

### First-class `dsh` members

Set `kind: 'dsh'` to make the harness relaunch the current installation as the member process. In this mode `command` and `args` are omitted: the member runs `dsh --profile acp` with a per-member harness home under the main instance's home (`members/<id>`). Before its first spawn the main instance seeds that home once — copying the user's settings and credentials documents — and after that the member is fully self-contained: it reads only its own home at runtime, so the member's own writes (e.g. a model switch through `member_model`) survive restarts and are never clobbered by a re-seed.

```yaml
- id: team
  name: '@deepseek-ai/dsh-team'
  config:
    members:
      - id: helper
        title: Helper
        description: a first-class dsh peer
        kind: dsh
        preset: |
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              text: You are a terse architecture reviewer.
        autostart: true
```

`preset` gives the member its own unique persona: a composition — a YAML top-level list of plugin rows (persona, tools, prompt sections) — written into the member home's preset root and made the member's default preset, so every session the member creates composes from it instead of the deployment default. The persona text is the member's system prompt: write it completely (role, responsibilities, working style, limits) — a placeholder label defeats the point of a unique member. The preset id is derived from the member id; a broken composition fails `addMember` loud; and once seeded it is fixed for that home's lifetime — a restart never re-seeds over the member's own edits. Only `dsh` members carry a preset: they are the members with a harness home to hold it.

`kind` is optional; when omitted `command` is required and the member runs any ACP server you specify.

### Durable roster and offline cache

The roster (who is in the team and how to spawn them) is the only team state the harness persists. `addMember` writes to the `team` storage domain immediately; `removeMember` attempts to delete it and logs failures, so a failed delete can resurrect the member on restart. A restart merges the persisted roster with `Config.members` (config stays authoritative over a duplicate id) and re-raises autostarting members. A deployment without the storage domain keeps a memory-only roster.

The same `team` storage domain also holds a per-member offline cache (`cache` table):

- **`listSessions` success** refreshes the cached session list. Each cached session keeps `sessionId`, `cwd`, and optional wire passthroughs `title` and `updatedAt`.
- **Live `session/update` notifications** are appended to that topic's cached update stream.
- **`readHistoryEvents`/`readHistory` success** replaces the topic's cached updates with the full `loadSession` replay (authoritative), then keeps appending live updates afterward.
- **Offline reads** serve the cache: `listSessions` returns the cached list and `readHistoryEvents` folds the cached updates through the translator. An unknown topic fails loud instead of returning empty.

No secrets are cached: updates are conversation content the member already showed the harness.

### Session config options

When the member advertises session configuration options, the harness caches the options it receives from `session/new` and `session/load`, plus any `session/config_option_update` notifications, keyed by session id. `getConfig` derives the resolved snapshot (options plus the model shortcut) from this cache on demand; `setConfig` writes through `session/set_config_option` and refreshes the cache. The model shortcut picks the option whose UX category or id is `"model"`. There is no ACP capability flag for config options — the only signal is the options returned with the session, so a member that advertises none yields no cache and `getConfig` throws.

Provider configuration (`providers/list`, `providers/set`) is gated on the `providers` capability advertised in `initialize`; the harness reports "not supported" when it is absent.

## Events

| Event | Payload |
|---|---|
| `team/status` | `(memberId, status, error?)` — every status migration. |
| `team/member-update` | `(memberId, sessionId, update)` — one lossless ACP `session/update` (text/thought chunks, tool calls, plans, usage). |
| `team/permission-requested` | `(request)` — one surfaced `session/request_permission` prompt, answerable via `team.permission`. |
| `team/turn-end` | `(memberId, sessionId, promptId, stopReason)` — one settled prompt turn. |

All four are allowlisted for verbatim forwarding over the host SSE stream (`@deepseek-ai/dsh-api-remotes`).

## Full-fidelity history rendering

`readHistoryEvents` folds the member's replayed ACP `session/update` stream through `@deepseek-ai/dsh-team/fidelity-reverse` (`AcpUpdateTranslator`), producing harness `SessionEvent` payloads the host bridge can append to a local session for rendering. The translator is stateful per (member, session): it accumulates user chunks into one `user/message`, opens `step/start` and content blocks on the first agent output, pairs `tool_call` / `tool_call_update` into `tool/call` + `tool/result`, emits a committed `assistant/message` at step close so the client marks the step settled, and drops updates with no clean inverse (`usage_update`, mode/command/session-info announcements). Turn boundaries are closed by the live `session/prompt` settlement (for streaming turns) or by the translator's tail flush at the end of a replay.

On the live path the host bridge mints `user/message` via `startTurn(text)`; if the agent echoes the same user text as `user_message_chunk` updates, the translator suppresses the duplicate so the turn shows a single user bubble.

## Process boundary

Members spawn through the [`dsh-subprocess`](../../subprocess/subprocess/README.md) seam. The ACP wire is the serialization boundary. Cooperative teardown closes the process; an unexpected process death moves the member to `offline`.

## Model Experience

### Member request

#### What the model sees

Through `dsh-tool-team` (`member_sessions` / `member_chat` / `member_*`), the calling agent sees the member roster, each member's topic ids, the member's committed replies, and — when the member advertises them — the session model config and advertised providers. The member's own system prompt, tools, and history stay in the member process; user text and admitted images cross, and only committed assistant text returns.

#### Token effect

Each chat turn sends one user message and returns one reply. History reads (`readHistory`) are UI-side and cost no model tokens in the caller.

#### KV Cache effect

The caller's request prefix is untouched; member turns are independent requests.

## Known Limitations and Deferred Work

- **One process per member** — no pooling or hot standby; restart is explicit.
- **Honest boundary** — the harness holds the stdio pipes, so a member the harness spawned terminates with the harness; member sessions live in the member's own persistence and restore via `loadSession`.
- **Local workspaces only** — the member process runs on the same machine; remote ACP agents would need their own workspace mapping.
- **Remote tool calls are opaque** — the member executes its own tools inside its process; the harness sees the protocol stream only.
- **No member-to-member direct messaging yet** — communication goes through the coordinating agent (or the user via the team view).
- **Members cannot ask the user free-form questions** — ACP has no question primitive and the dsh bridge implements none, so the only interactive channel a member can open is `session/requestPermission`, which the Web client serves as an approval. An `ask_user`-style exchange needs either an ACP extension or a bridge-mapped question seam; deferred.
- **Preset fixed at creation** — a `dsh` member's own preset is seeded into its home once and never re-seeded over the member's edits; changing it means editing the member home's preset file, or removing and re-adding the member.
