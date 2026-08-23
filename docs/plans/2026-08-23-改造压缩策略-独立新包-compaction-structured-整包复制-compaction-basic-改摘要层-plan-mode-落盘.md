# Retransforming the compaction strategy: a new standalone package `compaction-structured` (whole-package copy of compaction-basic, change only the summarizer layer) + plan-mode persistence

English | [中文](2026-08-23-改造压缩策略-独立新包-compaction-structured-整包复制-compaction-basic-改摘要层-plan-mode-落盘.zh.md)

## Key corrections (adopting your two points)

- **Leave `compaction-basic` untouched** (the original compaction mechanism is not changed by a single character).
- Create a **new standalone package** `@deepseek-ai/dsh-compaction-structured`, make a **whole-package copy** of `compaction-basic`, and change only the summarizer layer.
- One-line profile swap: `compaction-basic` → `compaction-structured`; stop the old one, select the new one; rollback cuts that line back, and the original is always there.
- plan-mode persistence is a separate small change; it does not belong to the new compaction package.

## Goals and acceptance criteria

The compaction output is assembled from three blocks into one checkpoint, each block labeled by its source:

1. **Code block ① File list**: every file that was `read`, `write`, or `edit`-touched inside the shadowed region, each with an adjacent explanation.
2. **Code block ② Current plan**: as long as plan mode is active, the checkpoint must contain the full current plan content (not dependent on the model volunteering it).
3. **LLM block**: the compressed narration of the conversation body / reasoning / detail.

Acceptance (all keyless-assertable, except the "LLM call" itself):

- The file list covers read/write/edit, with adjacent text, de-duplicated, stable order, skips invalid JSON.
- When plan is active the checkpoint must contain a `<plan>` block holding the full content.
- The output is a single `user/message` with fixed internal labels per block, distinguishable as "from code" vs "from the LLM".
- `compaction-basic` source diff is empty.
- plan-mode persists on every present/revise, not only on approval.

## Change 1: new standalone package `compaction-structured` (copy + change the summarizer)

Create under `packages/compaction/compaction-structured/`, **copy** all of `compaction-basic`'s sources:

- `index.ts`: the engine (`static inject=['llm','tokenMeter','sessions']`), `compactIfNeeded`/`compactRegion`/`compactNow`, `_registerAutomaticCompaction` pressure listener, overflow recovery, `regionDependencies` — copied as-is, behavior unchanged from now.
- `region.ts`: `selectCompactableRange`, `compactSurfaceRegion` transaction/lock/stability check, `commitCompactionBody`, `frameSummary` outer layer — copied as-is; **only `buildSummarizationInput` attaches `facts`**.
- `summarizer.ts`: original `summarizeWithLlm`, `COMPACTION_INSTRUCTION`, `frameSummary` copied whole; **only rewrite the summary assembly** into "code block + LLM body + plan injection".
- `config.ts` / `types.ts` / `invariant.ts`: copied whole.

The new package implements the `CompactionEngine` abstraction of `@deepseek-ai/dsh-compaction`, exposes `ctx.compaction`, and the wiring with `command-compact` and the optional `toolResultPruner` is identical to the original package.

### 1.1 File list extraction (new package region.ts)

`buildSummarizationInput(session, shadowedSeqs)` adds computing `facts`:

- **Range**: locate the log indices of `shadowedSeqs[0]` and `shadowedSeqs[last]` in `session.events`, scan between them.
- **Files**: hit `tool/call` with `name ∈ {read, write, edit, append_file, open_file}`; take `path` from `JSON.parse(arguments).path` (fallback `.filePath`/`.filename`); de-duplicate by first appearance.
- **Adjacent explanation**: for each file take the text of the most recent `assistant/message` before that `tool/call`, truncated to about 2 sentences / 240 characters.
- Product `RegionFacts = { files:{path,explanation}[]; plan?:string }` (add `SummarizationInput.facts` to `types.ts`).

### 1.2 Current plan injection (new package, self-contained)

- Scan the whole `session.events` for the **latest** `tool/call` (`name==='exit_plan_mode'`), `plan = JSON.parse(arguments).plan`.
- Active check is self-contained: read the latest `plan/mode` event (`foldPlanMode` equivalent logic, not depending on the `plan-mode` service).
- Produce the `<plan>` block only when `active && plan`.

### 1.3 Summary rewrite (new package summarizer.ts)

Rewrite `summarizeWithLlm` into three parts:

1. Input: if `facts` has `files`/`plan`, place them at the front of `messages` as "harness captured them, treat them as source of truth, do not paraphrase"; the compaction instruction becomes "only compress the conversation narration; the file list and plan are harness-guaranteed".
2. `ctx.llm.stream(messages)` produces the body `prose`.
3. Assemble `summary = [ <plan>…</plan> | <files>\n- {path}: {desc}\n…\n</files> | {prose} ]`.

`commitCompactionBody`, `region.ts:374` shrink check unchanged (they act on the whole assembly after it is built).

## Change 2: plan-mode persistence (separate small change, `plan-mode/src/index.ts`)

- `EXIT_PLAN_MODE`'s `execute`: change "write the file" from "only on approval" to "write on every call" (decoupled from whether it is approved), keeping the file name `docs/plans/<date>-<slug>.md`; the latest writer is the current plan.
- Keep the approval branch's `path` return (the render needs to display it).
- Still skip when there is no fs capability (same as now).

## Assembly / switch

- profile (e.g. `packages/bundle/base/cordis.patch.yml`, each agent preset's `agent.cordis.yml`): replace the `compaction-basic` line with `compaction-structured`.
- The `command-compact`, `tool-result-pruner` lines are unchanged (backend-agnostic, follow `ctx.compaction`).
- Keep `compaction-basic` for rollback: cut the profile back to that line.

## Boundaries and edge cases

- No `<plan>` (plan not presented) / no `<files>` (no file operations) → the corresponding block is not emitted.
- Invalid `JSON.parse` → skip that call, do not block compaction.
- If an injected plan/code block makes the summary no smaller than the shadowed content → caught by the shrink check, fall back to the no-injection behavior, do not lose compaction.

## Tests

- `compaction-structured` (keyless): `extractRegionFacts` (read/write/edit hits + adjacent text + dedup + invalid skip); assemble the four combinations; active gating.
- `plan-mode` (keyless): persist on every present; latest persistence wins over multiple revises.
- snapshot (needs key): the summary structure in `examples/headless-agent/compaction.cordis.snapshot.yml` has changed, re-record it; add one plan-injection end-to-end reproduction.

## Blast radius and cost

- `compaction-basic`, `surface.ts`, token-meter, the SDK event face, and `SESSION_FORMAT_VERSION` are all unchanged.
- Cost: the whole-package copy introduces about 1200 lines of duplication; the new package must stay behaviorally in sync with the original (pin it with independent tests to avoid drift).
- The new package has **no service coupling** with plan-mode (the plan is read self-contained from the log).

## Alternatives (one line, no further questions raised)

If the whole-package duplication is unacceptable, let the new package only inherit `BasicCompactionEngine` and override `summarize()` (sharing the original region/transaction logic, much smaller change face, the original still unchanged by a character); the cost is coupling to the original's evolution. Right now we follow your literal "copy it out" requirement with the whole-package copy; go lighter if you want.

## Recommended execution order

1. New package whole-package copy skeleton (index/region/summarizer/config/types/invariant) + minimal tests proving the original behavior still runs.
2. plan-mode persistence + its keyless tests.
3. New package region attaching facts (file list + plan injection).
4. New package summarizer changing the code/LLM assembly.
5. compaction keyless units (the four combinations) + snapshot re-record + plan-injection end-to-end.
6. Sync the new package README; profile switch and regression.
