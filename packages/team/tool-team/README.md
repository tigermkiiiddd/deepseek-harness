# @deepseek-ai/dsh-tool-team

English | [中文](README.zh.md)

Model-facing team tools over the [`team` service](../team/README.md): enumerate the team members and each member's own conversation topics, chat with a member on a chosen topic or a new one, mutate the roster, and drive the member lifecycle. The tools are a permanent team capability: the web-app bundle mounts the row in the host plane, so every session sees them without any preset.

## Tools

- `member_sessions` — list every member (or one `member_id`) with status and capabilities, plus each member's own topic ids (from ACP `session/list`). A member that is not running reports how to start it. Start here to pick the topic to continue.
- `member_chat` — send `text` to a member. Pass an existing `topic` id to continue that conversation, or `new_topic: true` to open a fresh topic on the member. Returns the member's committed reply (and its stop reason when not `end_turn`/`max_tokens`). The tool's cancellation signal cancels the member's turn through ACP.
- `member_add` — spawn a member process at runtime, persist it in the durable roster, and join it. Accepts the full member config: `command`, `args`, `cwd`, `env` (layered over the full parent environment), `permission` (`allow` / `reject` fallback policy), and `autostart`.
- `member_remove` — stop the member, drop it from the roster, and attempt to delete it from persistence. A failed delete is logged and the record may reappear on restart; a member also declared in the deployment config reappears at the next restart.
- `member_start` — start a stopped or failed member (spawn + handshake). Idempotent.
- `member_stop` — stop a member and return it to `idle`; its own sessions stay with the member.
- `member_restart` — stop then start a member, e.g. after it went `offline`.
- `member_model` — query or set a member's session **model** configuration. `action: "get"` returns the current model and its selectable value ids; `action: "set"` switches the model to one of those value ids. Requires a `session_id` from `member_sessions` (create one with `member_chat` `new_topic` first). The member must advertise session config options, otherwise the call reports it.
- `member_provider` — list or set a member's ACP **provider** configuration. `action: "list"` returns the advertised providers; `action: "set"` configures one (`id`, `api_type`, `base_url`, optional `headers`). Requires the member to advertise the `providers` capability, otherwise the call reports it.

## Model Experience

### Member chat

#### What the model sees

The member roster, topic ids, and committed replies from `member_chat`. The member's own persona, tools, and history stay in the member process; only user text crosses, only committed assistant text returns.

#### Token effect

Each call adds the sent message and the returned reply. Listing adds zero tokens.

#### KV Cache effect

Append-only after the reusable request prefix; member turns are independent requests.

### Model and provider configuration

#### What the model sees

The current model, its selectable value ids, and the advertised providers. `member_model get` returns the live config; `member_model set` and `member_provider set` are writes that the agent validates on its own side.

#### Token effect

`get` and `list` return the full config set each call; `set` returns a one-line confirmation.

#### KV Cache effect

Append-only; each call is an independent request.

## Known Limitations and Deferred Work

- No streaming intermediate text: the tool returns the full reply when the turn settles.
- Topic ids are opaque member-side identifiers; titles for topics are a future ACP/session-info enhancement.
