# Agent Note: Index-addressed todo deltas

Status: implemented

English | [中文](2026-08-23-todo-index-addressed-deltas.zh.md)

## Problem

Todo delta updates used the human-readable `content` field as an upsert key. Models routinely refine wording while reporting progress, so a renamed task failed to match its prior entry and was appended as a second task. The resulting duplication was durable in `todo/write`; UI clients correctly displayed the corrupted list.

## Decision

`todo_write` keeps complete `TodoItem[]` snapshots in `todo/write`, but accepts only index-addressed mutations: required action `add` appends `todos`, `update` applies `updates: [{ index, content?, status? }]`, `remove` deletes `indices`, and `clear` empties the list. Neither `merge` nor whole-list `replace` is available: an upsert cannot distinguish an intended addition from a renamed task, while an available replacement path lets a model bypass deltas and repeatedly transmit the entire list.

An `update` never appends. Every update and removal index refers to the list before that call; duplicate, negative, and out-of-range indices fail without writing an event. An update must change `content`, `status`, or both. The complete result must retain unique non-empty content and satisfy the configured active-task count before it is appended.

The durable `TodoItem` remains `{ content, status }`. Indices are operation addresses rather than persisted identity, so the event format, projections, ACP mapping, and UI representation remain unchanged.

`todo_read` returns the current ordered list with zero-based indices without writing an event. The tool fold stops at the latest `turn/start`, so a new turn begins with the same empty standing-plan state the UI projects instead of reviving the prior turn's list. Every successful `todo_write` result also renders the complete indexed result after its status counts. The model can therefore resynchronize after compaction and always receives the index map produced by its latest mutation; `todo/write` itself remains log-only UI state.

## Verification

Package tests cover renaming through `update` without increasing list length, partial field updates, additions, removals against pre-action indices, invalid and duplicate indices, duplicate resulting content, active-count validation, required actions, rejection of `replace`, indexed rendering, and reset at the next `turn/start`. Full agent-loop tests send an index update through the real tool registry and verify that `todo_read` returns the current index map without appending another `todo/write`.

## Alternatives considered

**Continue matching by `content`.** Stronger instructions cannot make editable display text a stable key. Exact matching recreates the defect when punctuation or wording changes; fuzzy matching can merge distinct tasks unpredictably.

**Persist a stable task id.** This gives identity independent of order and is preferable for concurrent multi-owner lists, but it changes `TodoItem`, every durable event, and all consumers. The current list is session-owned and ordered, so positional mutation solves the observed defect without widening the persisted format.

**Return to replacement-only writes.** Whole-list replacement avoids identity but restores the token cost and omission risk that motivated delta actions.

**Keep `replace` as an exceptional escape hatch.** Tool descriptions did not contain its use: a model repeatedly chose the first, default action for ordinary status and text edits. Removing the action makes incremental transmission enforceable; a complete replan uses explicit `clear` followed by `add`.

## Consequences

Task text can change in place without creating a second entry, and an invalid target fails instead of becoming an implicit addition. `add` and `update` express distinct intent, while the protocol cannot silently fall back to a full-list write. Indexed results cost tokens proportional to the current task count, and a complete replan takes two calls (`clear`, then `add`). Because indices follow order, the model uses the latest rendered list after `add` or `remove` and calls `todo_read` when compaction has hidden it; stable ids remain the escalation path if the list gains concurrent writers.
