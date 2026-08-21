# Agent Note: Approved plans are recorded to the workspace

Status: implemented

English | [中文](2026-08-16-approved-plans-recorded-to-workspace.zh.md)

## Problem

`exit_plan_mode` kept the plan only as its logged tool argument: reviewable at approval time and recoverable from the session log, but invisible in the project itself. A user who wants to re-read what was approved — or trace why the codebase changed — has to find and replay the session log. Work left no trace in the workspace.

The obvious alternatives each broke a contract. Writing the plan file through the model (a `write` call before exit) leaves rejected drafts on disk. Passing a `path` instead of the plan text would empty the transcript card, because `presentCall` is a pure function of `args` and may not read the filesystem (adding-a-tool cookbook).

## Decision

The exit tool keeps its `plan` argument unchanged — the logged argument remains the canonical, replayable record per [plan-specific collaboration state](../simplification/2026-07-22-plan-specific-collaboration-state.md). On approval, `exit_plan_mode` itself records the plan markdown to `<plansDir>/yyyy-mm-dd-<slug>.md` resolved against the session's working directory (`currentSessionCwd`), where:

- `plansDir` is a validated config field defaulting to `docs/plans`;
- the slug derives from the plan's first heading (lowercased, non-letter/digit runs collapsed, Unicode letters preserved); a punctuation-only heading falls back to `plan`;
- the write goes through `ctx.fs` with the session's resolved sandbox policy, so a confining backend fences it exactly like a model-initiated write; a composition without a filesystem capability skips recording and the result simply omits `path`;
- only approved plans leave files — rejection keeps drafts in the session log alone;
- a session without a working directory, or a failed write, fails the call and keeps plan mode active so the approval can be retried.

The output schema gains `path?: string` and the confirmation text names it. Same-day same-slug recordings overwrite; draft iteration lives in the session log, not in versioned files.

## Alternatives considered

**The model writes the file and passes a path.** Rejected: drafts must exist on disk before review, so rejected work litters the workspace; and the transcript card loses the plan text (presenter purity forbids reading the file in `presentCall`).

**Record every submission, including rejected ones.** Rejected: the durable home for drafts is the session log; multiplying files per draft turns `docs/plans` into an append-only dump the user never asked for.

**Record into the harness session-state directory instead of the workspace.** Rejected for this feature: the point is work traceability where the user works — the repository — matching how Agent Notes are committed process records. Session-state storage would hide the trace next to internal bookkeeping.

## Consequences

Approved plans appear in the project's `docs/plans/` (committed or not, as the user chooses); the exit result and confirmation name the path. Costs: one config field, an optional `fs`/`sandboxPolicy` consumption, and a write that can fail the exit call under a read-only sandbox. The KV-cache and tool-catalog stability properties are untouched — the schema change is one additive optional field, and no prompt text changes.
