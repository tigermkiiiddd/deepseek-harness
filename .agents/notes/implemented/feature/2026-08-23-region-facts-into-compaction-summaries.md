# Agent Note: Region facts folded into compaction summaries

Status: implemented

English | [中文](2026-08-23-region-facts-into-compaction-summaries.zh.md)

## Problem

A compaction summary replaces a shadowed run of history and must let another model resume with no loss of essential context. The summary is produced by an auxiliary `ctx.llm.stream()` call over a replayed message prefix, so everything it can know comes from the replayed assistant, user, and tool messages. Anything the model did not narrate must be rediscovered by the model: which files the agent touched in the region, and why it touched each, was reconstructable from the log only by re-reading every `tool/call` in the range, and the model frequently restated or invented file context; the latest presented plan was only present if the model chose to carry the `exit_plan_mode` argument forward.

## Decision

`@deepseek-ai/dsh-compaction-structured` computes region facts from the logged surface and injects them as authoritative guidance ahead of the compaction instruction, so the model condenses only the surrounding narrative instead of restating or re-deriving them. The design builds on the compaction capability seam [`2026-06-18-compaction-capability-seam`](2026-06-18-compaction-capability-seam.md) without altering the `surface` or `compaction/*` event vocabulary.

### Region facts extraction

`region.ts` computes `RegionFacts` inside `buildSummarizationInput` over the shadowed surface-node seqs, then spreads them into `SummarizationInput.facts` only when present.

- **Files in first-seen order.** Scan `session.events` from the region's first to last shadowed seq (`extractRegionFacts`, first pass). Each `tool/call` whose `name` is a file-touching tool — `read`, `write`, `edit`, `write_file`, `append_file`, `open_file`, `create_file`, `append`, `view` — yields a file. The path comes from the parsed arguments' `file_path`, `filePath`, or `path`. A file repeated in the region is listed once; the `seen` set deduplicates by first occurrence.
- **Adjacent explanation.** Each file entry is `<path>: <explanation>`. The explanation is the assistant text of the nearest `assistant/message` at or before the tool call, truncated to 200 characters (`ADJACENT_EXPLANATION_LIMIT`) and marked with `…`. The first occurrence keeps its own explanation.
- **Plan, folded self-contained.** When plan mode was active at the end of the region, the region's latest non-empty `exit_plan_mode` `plan` argument is included as `RegionFacts.plan`. Plan-mode state is read structurally from the `plan/mode` log events, last wins — no `plan-mode` service is loaded.

`extractRegionFacts` returns `undefined` when the region touched no files and no plan was presented, so nothing is injected and the compaction instruction is byte-identical to the `compaction-basic` backend.

### Injected instruction

`summarizer.ts` appends, only when `input.facts` is present, `COMPACTION_FACTS_GUIDANCE` then `formatRegionFacts` after `COMPACTION_INSTRUCTION`:

> The following are harness-captured facts about the shadowed region. Treat them as authoritative:
> - Do not restate, verify, or re-derive them.
> - Do not request tools to confirm them.
>
> Condense only the surrounding conversation narrative.

The files section renders `## Files touched in the region (harness-guaranteed)` with one `- <path>: <explanation>` per file; the plan section renders `## Active plan (harness-guaranteed)` with the plan text. The sections are model-visible and pinned verbatim under Model Experience in the package README.

## Consequences

- **Model-visible behavior changes.** The compaction instruction gains a deterministic, harness-guaranteed block. The checkpoint's `## Files touched` and `## Active plan` sections are code-produced, not model-produced, so a consumer can tell which block came from the log versus the model.
- **No plan-mode coupling.** Region facts fold the log themselves, so the compaction backend depends on no plan-mode service; the feature works whether or not plan mode is mounted.
- **Boundary.** A file repeated in the region is deduplicated to its first touch; the plan is included only when plan mode was active at the region end. Malformed `exit_plan_mode` arguments are skipped by the existing argument-parser guard, which treats invalid JSON as absent.
- **Required verification.** Keyless unit tests pin first-seen order, dedup to first-seen explanation, the no-facts omission, the 200-character truncation, the active-plan inclusion, and the summarizer folding. `compaction-basic` is byte-unchanged and the new backend implements the same `@deepseek-ai/dsh-compaction` contract.

## Alternatives considered

- **Ask the model to list touched files and plans.** Rejected: the summary call carries no tool hook, so the model would invent file lists and defeat resume fidelity. The log is authoritative; the harness ships what it already knows.
- **Add region facts as a new session event.** Rejected: the region is computed over already-logged surface seqs, so folding from the log needs no new event and no `SESSION_FORMAT_VERSION` bump.
- **Recompute facts on the consumer side.** Rejected: the summarizer owns the instruction and must inject before the model call; the backend prepares the facts as part of `SummarizationInput`.
