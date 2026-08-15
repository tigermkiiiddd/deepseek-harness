# @deepseek-ai/dsh-tool-team

English | [中文](README.zh.md)

Model-facing team tools over the [`team` service](../team/README.md): enumerate the team members and each member's own conversation topics, and chat with a member on a chosen topic or a new one.

## Tools

- `member_sessions` — list every member (or one `member_id`) with status, plus each member's own topic ids (from ACP `session/list`). Start here to pick the topic to continue.
- `member_chat` — send `text` to a member. Pass an existing `topic` id to continue that conversation, or `new_topic: true` to open a fresh topic on the member. Returns the member's committed reply (and its stop reason when not `end_turn`/`max_tokens`).

## Model Experience

### Member chat

#### What the model sees

The member roster, topic ids, and committed replies. The member's own persona, tools, and history stay in the member process; only user text crosses, only committed assistant text returns.

#### Token effect

Each call adds the sent message and the returned reply. Listing adds zero tokens.

#### KV Cache effect

Append-only after the reusable request prefix; member turns are independent requests.

## Known Limitations and Deferred Work

- No streaming intermediate text: the tool returns the full reply when the turn settles.
- Topic ids are opaque member-side identifiers; titles for topics are a future ACP/session-info enhancement.
