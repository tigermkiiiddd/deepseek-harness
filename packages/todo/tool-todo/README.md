# @deepseek-ai/dsh-tool-todo

English | [中文](README.zh.md)

The model-facing `todo_read` and `todo_write` tools for an agent's ordered task list.

## What it does

Registers `todo_read()` and `todo_write({ action, todos, updates, indices })` on `ctx.tools`. `todo_read` returns the complete current list with zero-based operation indices. The current list is the latest `todo/write` after the current `turn/start`; a new turn starts empty, matching the standing-plan projection. `todo_write` requires an action: `add` appends `todos`, `update` changes existing entries through `updates[].index`, `remove` deletes `indices`, and `clear` empties the list. Whole-list replacement is not supported. Every index addresses the current ordered list before that call; an invalid index fails instead of adding or guessing. Each successful write appends a `todo/write` event carrying the complete resulting list to the calling agent's session log; replay remains last-write-wins within that turn.

`status` is one of `pending`, `in_progress`, or `completed`.

## Single owner

The list belongs to the ONE agent session that called the tool. There is no subagent/shared/swarm scope: a non-agent caller (no `exec.agent`) has nowhere to write the list and is rejected. This is a deliberate scope limit — see the Agent Note.

## Configuration

`allowParallelInProgress` is required: every composition must choose whether several todos may be `in_progress` at once. It is a deployment choice, not a fixed rule: whether concurrent active tasks are legitimate depends on runtime concurrency the tool cannot observe. Use `true` for agents that may fan out work and `false` to enforce the single-active discipline.

The flag moves the model-facing instruction and the accepted input together — `true` asks the model to mark every actively worked task and accepts any number, `false` asks for exactly one and rejects a call marking more with `Error: invalid todos: at most one task may be in_progress (got <n>)`. The durable-log invariant does NOT follow it: a log written while parallel work was allowed must still replay after a deployment tightens the policy, so the invariant stays silent on the active count.

## Validation

Beyond the schema's type and enum checks, `execute` rejects empty or duplicate resulting `content`. `add` requires `todos`; `update` requires a non-empty `updates` array whose entries contain a unique in-range index and at least one of `content` or `status`; `remove` requires unique in-range `indices`; `clear` needs no collection. The active-count rule (§ Configuration) applies to the complete resulting list for every write, so a delta cannot bypass a single-active composition.

## Rendering

Both tools return `{ todos, counts: { pending, inProgress, completed } }`. The Native renderer exposes every entry with its zero-based index; a write prefixes the list with the status counts. `todo_write` also records the full `todo/write` session event. UIs subscribe to the event stream and render that durable list themselves: the [web client](../../client/ui-conversation) shows a plan strip plus a dedicated tool row off the standing plan — latest `todo/write` with no later `turn/start` ([display](../../../.agents/notes/implemented/feature/2026-07-23-web-todo-display.md), [lifetime](../../../.agents/notes/implemented/feature/2026-07-28-todo-plan-clears-on-next-turn.md)).

## Session projection

When the composition mounts `ctx.sessionProjections` ([`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)), this package registers the `todos` projection unit under an injected child: `init` = `null` (no write yet), `apply` = take the whole list from each `todo/write` and clear to `null` on each `turn/start` (standing plan; `turn/end` keeps the finished checklist; every other event returns the same state reference), `view` = identity, `stateVersion` = 2. The key merges into `SessionProjectionMap` here (via the Service Definition package's `/types` outlet); the framework drives the unit and carriers serve the value on the history tail page and the `session/projection` push frame. Compositions without the registry are unaffected. Lifetime rationale: [todo plan clears on next turn](../../../.agents/notes/implemented/feature/2026-07-28-todo-plan-clears-on-next-turn.md).

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`todo_read` and `todo_write` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo).

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each assistant write call retains only its action arguments: new entries for `add`, index-addressed changes for `update`, or indices for `remove`. Every successful read and write returns the complete current list as `<index> [<status>] <JSON content>` lines, so the next mutation can address a visible index. Stable failures identify a missing action collection, empty content, duplicate resulting content, duplicate or out-of-range indices, an update with neither `content` nor `status`, a missing owner, or a violation of the configured active-count rule. The full `todo/write` event remains UI and replay state rather than a second model message.

#### Token effect

Write-call token growth scales with the submitted delta. Results include the complete indexed list so correctness costs tokens proportional to the current task count; `todo_read` incurs that cost only when the model needs to resynchronize.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Single-owner scope only** — the list belongs to the one calling agent session; subagent/shared/swarm scopes are a deliberate cut (see § Single owner), and a non-agent caller is rejected.
- **Indices follow list order** — `add` and `remove` may change later indices. Each `update` and `remove` must address the latest ordered list; after compaction or whenever that list is not visible, the model must call `todo_read`. Out-of-range indices fail instead of mutating another position or appending.
