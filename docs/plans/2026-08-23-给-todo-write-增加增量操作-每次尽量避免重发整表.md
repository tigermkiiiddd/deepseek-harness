# Adding delta actions to `todo_write` (avoid resending the whole list every call)

English | [中文](2026-08-23-给-todo-write-增加增量操作-每次尽量避免重发整表.zh.md)

## Goals and acceptance criteria

Let the agent **incrementally update / edit individual tasks**, instead of resending the entire task list every call (missing one task would then silently drop it — exactly the problem you and the agent described), and proactively avoid a full resend when there is **no major directional change**.

Acceptance criteria:

- `todo_write` gains an optional `action` discriminant. When omitted (or `action: "replace"`), behavior is **byte-identical to today's** (backward compatible): whole-list replace, same validation, same error text, same session event, same projection.
- The new actions let the agent send only an **increment**: `merge` (upsert by `content`: add tasks / update the `status` of existing tasks), `remove` (delete the listed tasks), `clear` (empty). Each increment merges onto the "current persisted list".
- The **tool description (model contract) actively encourages increments, discourages full resends, and reserves `replace` for major directional changes** (see "Description enhancement" below).
- Existing persistence, projection, UI, ACP, and session-query consumers **keep working untouched** — the `todo/write` `[{ content, status }]` shape is unchanged.
- `pnpm run test:coverage` (`packages/todo/tool-todo/src`, 100% per-file coverage) passes; `typecheck`, `lint`, `doc-sync`, `build`, `hygiene` pass.

## Root cause

`execute()` in `packages/todo/tool-todo/src/index.ts` unconditionally appends the model-supplied **whole list** as `todo/write`; `types.ts` states the "whole-value rule" (last write wins); there is no action entry point, and the description forbids "partial update". This方案 does **not** change the persisted snapshot shape; it only adds action entry points and turns the model guidance (the description) toward encouraging increments.

## Model-facing surface (verified, the only one)

I searched the whole `packages/` — the **only** model-facing surface that tells the agent "how to use the task list" is the tool's own `description` (assembled by `describe()`). There is no second independent todo guidance in the system prompt (`plan-mode.spec.ts` only registers it, `tool-order.spec.ts` only orders it, `locales.ts`'s `更新任务清单` is only an UI title). So "tool description" and "prompt description" are the same place; changing it suffices; `docs/tool-catalog.md` is generated from it, so regenerate it too.

## Change scope (except as noted, all under `packages/todo/tool-todo`)

- `packages/todo/tool-todo/src/index.ts` — schema (`action` + `todos` field descriptions), `describe()` description, `execute` dispatch and merge logic. **(the only functional change)**
- `packages/todo/tool-todo/tests/tool-todo.spec.ts` — add coverage; add a "description encourages increments" assertion; update the `presentCall` assertion.
- `packages/todo/tool-todo/tests/integration.spec.ts` — add one end-to-end `merge` full-flow case.
- `packages/todo/tool-todo/README.md` and `README.zh.md` — describe the actions + the "prefer increments, do not full-resend on non-major changes" guidance; update `Known Limitations`.
- `docs/tool-catalog.md` — regenerate; `docs/tool-catalog.zh.md` — sync the `deepseek-aidsh-tool-todo` fragment.
- Do not touch other packages (verified: `core/session`, `acp`, `session-query`, `team`, `client/connection`, `session-projection`, `client/runtime` only read the unchanged `TodoItem[]`).

## Design decisions (recommended — the only fork flagged)

**Use `content` as the locator key.** `content` is already normalized (trimmed, non-empty, unique within the list) and used as the dedup key, making it the natural, zero-new-field locator for delta operations. Renames are done with a `remove` (old content) + `merge` (new content) combo. A stable `id` is **deferred** (it would require changing the `TodoItem` shape, the `session` version number, ripple through ~9 packages) — listed as a defer.

Reading back the tool (`todo_read`) is also **not added yet**: every call already returns the full `{ todos, counts }`, so the model sees the current list every turn; the delta actions already solve the pain point.

## Detailed implementation

**1. schema** — add an optional `action`, make `todos` optional (but required at runtime for each action):

```
action: { type: 'string', enum: ['replace', 'clear', 'merge', 'remove'],
          description: 'replace(默认):整表,即现有行为。merge:按 content 向上插入
          (新增 / 更新已存在任务的 status)。remove:删除列出的 content。clear:清空。
          merge/remove/replace 都在"当前持久化清单"(最近一次 todo/write)上操作。' }
todos: { type: 'array', required: false,
         description: '要改的条目。replace(默认):替换上一次的完整清单。merge:要新增或更新
         status 的增量(按 content 匹配)。remove:要删除的 content(忽略 status)。clear 时不传。',
         items: { content: string, status: enum(pending/in_progress/completed) } }
```

When `action` is omitted the default is `replace`, so existing model calls and snapshot/integration inputs are unaffected.

**2. Description enhancement (this round's focus — in `describe()`'s `DESCRIPTION_HEAD`)**. Replace the current HEAD with wording that encourages increments and reserves the full list for major directional changes (note: do not include "several at once" or "AT MOST ONE", to avoid breaking existing anchor tests):

```
'HEAD = Record and update a structured task list for the current work. '
+ 'UPDATE specific tasks with a delta instead of resending the whole list: '
+ 'use `action` — `merge` upserts each entry by `content` (adds new tasks, updates the '
+ '`status` of tasks that already exist), `remove` deletes the listed tasks, and `clear` '
+ 'empties the list; each delta merges onto the current list. '
+ 'ONLY send the COMPLETE list with `action: replace` when the task direction changes '
+ 'significantly, for example when the plan is restructured. Keep the list current as '
+ 'work progresses. '
```

`DESCRIPTION_PARALLEL` / `DESCRIPTION_SINGLE` / `DESCRIPTION_TAIL` are **not changed** (the `Keep AT MOST ONE ...` / `several at once ...` paragraphs are kept), so the anchor assertions in `tool-todo.spec.ts` and `loader-composition.spec.ts` still hold.

**3. `execute`** — reorganize around dispatch. **Keep the top** `exec.agent` ownership guard (`clear` too — all non-agent calls rejected).

- Split `toTodoList(raw, allowParallel)` into:
  - `normalize(raw)`: trim + reject empty + reject duplicate content + validate the `status` enum → cleaned entries. **Does not do the active-count check** (it is legitimate for an increment to add one `in_progress` even when another already exists).
  - Shared `assertSingleActive(list, allowParallel)`: throws `Error: invalid todos: at most one task may be in_progress (got <n>)` when `!allowParallel` and the count is > 1, run against **each action's resulting list**, keeping the exact text.
- Read the current persisted list once:
  ```js
  const last = exec.agent.session.events.findLast(e => e.type === 'todo/write')
  const current = last ? last.data.todos.map(t => ({ content: t.content, status: t.status })) : []
  ```
- Dispatch:
  - `replace` → `final = normalize(args.todos)` (requires `todos`; on absence throws `Error: todo_write requires a `todos` array for action "replace"`).
  - `merge` → `final = current.map(t => deltaMap.get(t.content) ?? t)`, then append the cleaned increments whose content is not in `current` to the end (order-preserving, deduped). Requires `todos`.
  - `remove` → `final = current.filter(t => !removeSet.has(t.content))` (clean the to-remove content first); requires `todos`. Deleting a non-existent content is a safe no-op (idempotent, content may already have been renamed).
  - `clear` → `final = []`.
- After dispatch, run `assertSingleActive(final, allowParallel)`.
- Append **one** `todo/write` carrying `final` (shape unchanged), return `{ todos: final, counts }` (same as today).

**4. `presentCall`** — return `rawInput: args` (including `action`), not just `args.todos`; update the existing `presentCall` test.

## Boundaries and failure cases (all covered with tests)

- No prior `todo/write` → `merge` treats `current` as `[]` (append all increments); `remove`/`clear` are no-op → empty.
- `merge` updating an existing task preserves order, keeps the other tasks' status and order; new tasks are appended in the given order.
- `merge`/`remove` producing `>1 in_progress` under `allowParallelInProgress=false` → rejected on the resulting list.
- Any increment with duplicate/empty content → rejected (same text as today).
- Unknown `action` value or unknown item key → rejected at the JSON-schema boundary (registry argument validation), consistent with the existing `doing`/`children` cases.
- `merge`/`remove`/`replace` missing `todos` → the new "requires a `todos` array" error.
- Non-agent call → all actions rejected.

## Tests

- `tool-todo.spec.ts`: `clear` (with/without prior), `merge` adding tasks without a full resend, `merge` updating existing tasks while preserving order and the rest, `merge` with no prior list, `remove` keeping the rest / deleting unknown content as a no-op, `merge` result still bound by "at most one in_progress" under `allowParallelInProgress:false`, the new "requires a `todos` array" error.
- **New description-pinning assertions** (model-facing contract, must be locked with a test):
  ```
  const desc = (await setup(true)).tools.schemas().find(s => s.name === 'todo_write')!.description
  expect(desc).toContain('delta')
  expect(desc).toContain('task direction changes')
  expect(desc).toContain('ONLY')
  ```
  And keep the existing `Keep AT MOST ONE` / `several at once` anchor assertions (unaffected by the HEAD).
- Update the `presentCall` test for the new `rawInput`.
- `integration.spec.ts`: add one `merge` case under a full agent loop (model mocked, tools and session log real).
- `invariant.ts` / `invariant.spec.ts` need **no changes** — a `merge` still writes a valid `todo/write` snapshot (shape unchanged).

## Docs

- `tool-todo/README.md`: rewrite `## What it does` and `## Validation`, stating "prefer `merge`/`remove`/`clear` increments, only use the `replace` full list when the task direction changes majorly"; update `## Known Limitations` (remove the "only operation" item, move the stable id to a "Deferred" row with a reasonable explanation, and add an allowlist per `packages/AGENTS.md`).
- `tool-todo/README.zh.md`: mirror the README change (bilingual pair).
- `docs/tool-catalog.md`: regenerate; `docs/tool-catalog.zh.md`: sync the `deepseek-aidsh-tool-todo` fragment.
- Update the "Model Experience" error lists of both READMEs with the new "requires a `todos` array" text.

## Verification (run coverage against the minimal set of changes)

1. `pnpm test -- packages/todo/tool-todo` (focus vitest, incl. coverage — must stay 100%).
2. `pnpm run gen-tool-catalog` + confirm `pnpm run verify-tool-catalog` passes; refresh the Chinese fragment; run `pnpm run doc-sync` (covers catalog + translation pairing + README model-experience).
3. `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, `pnpm run hygiene`.
4. Smoke from source with `pnpm dsh --profile <profile> "task"` (needs `DEEPSEEK_API_KEY`).

## What is not changed (and why)

- Do not change the `TodoItem` shape, the `todo/write` event, or `session-projection` folding — the persisted snapshot stays "whole-list last write wins"; `merge`/`remove` only **compute** a new whole list and append it. Isolating the change inside the tool avoids the ~9-package ripple of changing data structures.
- Do not add a new session event type — `action` lives in the tool-call arguments (already logged via `tool/call`); the result is still the existing `todo/write` + `{ todos, counts }`. No model-visible input gap.

## Release note

The source change to the checkout takes effect on the next process start (it does not hot-reload in this session); a restart / new session is required to pick up the new tool behavior.
