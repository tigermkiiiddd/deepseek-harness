# @deepseek-ai/dsh-tool-todo

English | [中文](README.zh.md)

The model-facing `todo_write` tool: the agent's task list — replaced wholesale by default, but updatable in place via delta actions.

## What it does

Registers one tool, `todo_write({ action, todos })`, on `ctx.tools`. By default the sent list REPLACES the previous one — but to update specific tasks without resending everything, send a delta with `action`: `merge` upserts each entry by `content` (add new tasks, update the `status` of existing ones), `remove` deletes listed contents, and `clear` empties the list; each delta merges onto the current list. Reserve the COMPLETE list with `action: replace` when the task direction changes significantly. Each call appends a `todo/write` event (the full resulting list snapshot) to the calling agent's session log via `agent.session.append('todo/write', { todos })`; the current list is the most recent such event (last-write-wins on replay).

`status` is one of `pending`, `in_progress`, or `completed`.

## Single owner

The list belongs to the ONE agent session that called the tool. There is no subagent/shared/swarm scope: a non-agent caller (no `exec.agent`) has nowhere to write the list and is rejected. This is a deliberate scope limit — see the Agent Note.

## Configuration

`allowParallelInProgress` is required: every composition must choose whether several todos may be `in_progress` at once. It is a deployment choice, not a fixed rule: whether concurrent active tasks are legitimate depends on runtime concurrency the tool cannot observe. Use `true` for agents that may fan out work and `false` to enforce the single-active discipline.

The flag moves the model-facing instruction and the accepted input together — `true` asks the model to mark every actively worked task and accepts any number, `false` asks for exactly one and rejects a call marking more with `Error: invalid todos: at most one task may be in_progress (got <n>)`. The durable-log invariant does NOT follow it: a log written while parallel work was allowed must still replay after a deployment tightens the policy, so the invariant stays silent on the active count.

## Validation

Beyond the schema's type/required/enum checks, `execute` rejects an empty or duplicate `content`, and any item key beyond `content`/`status` — an extended item shape (ids, nesting) fails loud instead of silently flattening, keeping the logged snapshot equal to what the model believes it wrote. For `replace`, `merge`, and `remove` the `todos` array is required; `clear` ignores it. The active-count rule (§ Configuration) applies to the RESULTING list for every action: a `merge`/`remove` that would leave more than one `in_progress` under a single-active composition is rejected, so a delta cannot widen a single-active plan into parallel work. Ordering and the discipline of keeping the list current are left to the model via the tool description.

## Rendering

The canonical result is `{ todos, counts: { pending, inProgress, completed } }`; its Native renderer returns the compact update acknowledgement. The tool also writes the full `todo/write` session event. UIs subscribe to the event stream and render that durable list themselves: the [web client](../../client/ui-conversation) shows a plan strip plus a dedicated tool row off the standing plan — latest `todo/write` with no later `turn/start` ([display](../../../.agents/notes/implemented/feature/2026-07-23-web-todo-display.md), [lifetime](../../../.agents/notes/implemented/feature/2026-07-28-todo-plan-clears-on-next-turn.md)).

## Session projection

When the composition mounts `ctx.sessionProjections` ([`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)), this package registers the `todos` projection unit under an injected child: `init` = `null` (no write yet), `apply` = take the whole list from each `todo/write` and clear to `null` on each `turn/start` (standing plan; `turn/end` keeps the finished checklist; every other event returns the same state reference), `view` = identity, `stateVersion` = 2. The key merges into `SessionProjectionMap` here (via the Service Definition package's `/types` outlet); the framework drives the unit and carriers serve the value on the history tail page and the `session/projection` push frame. Compositions without the registry are unaffected. Lifetime rationale: [todo plan clears on next turn](../../../.agents/notes/implemented/feature/2026-07-28-todo-plan-clears-on-next-turn.md).

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`todo_write` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo).

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each assistant tool call retains the entire list in its arguments (the full list for `replace`/`clear`, the delta for `merge`/`remove`). Success returns exactly `Updated todo list: <pending> pending, <inProgress> in progress, <completed> completed.` Stable failures are ``Error: invalid todo: `content` must be a non-empty string``, `Error: invalid todos: duplicate content "<content>"`, `Error: todo_write requires an owning agent session`, `Error: todo_write requires a \`todos\` array for action "<action>"` — only for `replace`/`merge`/`remove` when `todos` is omitted — and — only where the deployment set `allowParallelInProgress: false` — `Error: invalid todos: at most one task may be in_progress (got <n>)`. The full `todo/write` session event is UI and replay state, not a second model message.

#### Token effect

Token growth scales with every full list the model submits, and those call arguments remain until compaction. The result itself is small and fixed-shape.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Single-owner scope only** — the list belongs to the one calling agent session; subagent/shared/swarm scopes are a deliberate cut (see § Single owner), and a non-agent caller is rejected.
- **Delta actions key off `content`** — `remove`/`merge` cannot rename a task in place; rename is a `remove` (old `content`) followed by a `merge` (new `content`). A stable per-task `id` that would let `merge` rename directly and let the model address items by identifier is deferred, because it needs a `TodoItem` shape change, a `session` format version bump, and touch across ~9 consumers (`acp`, `session-query`, `team`, `client/connection`, `session-projection`, and more).
- **No read-back tool** — the tool result already echoes the complete `{ todos, counts }` and every delta is merged and logged, so the model sees the current list after each call; a dedicated read-back tool is deferred as low-value surface.
