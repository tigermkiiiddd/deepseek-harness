/**
 * Surface retention selection and the shared log-recorded compaction
 * transaction for automatic open-turn and manual idle-session compaction.
 *
 * @module @deepseek-ai/dsh-compaction-structured/region
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TextBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { frameSummary } from './summarizer.ts'
import type { SummarizationInput, SummaryResult, RegionFacts } from './summarizer.ts'

interface RegionDependencies {
  readonly meter: TokenMeter
  summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>
}

/** One validated inclusive span of current surface positions. */
interface SurfaceSelection {
  readonly start: number
  readonly end: number
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly number[]
}

/** A selection with its priced snapshot and the replay input built from it. */
interface PreparedCompaction extends SurfaceSelection {
  readonly measurement: TokenMeasurement
  readonly selectedNodes: TokenMeasurement['nodes']
  readonly shadowedTokenCount: number
  readonly input: SummarizationInput
}

type SummarizedCompaction = PreparedCompaction & SummaryResult & {
  readonly checkpointMessage: UserMessage
}

interface CompactionTransactionOptions {
  /** `current-turn` derives a numbered owner; `null` writes a standalone bracket. */
  readonly owner: 'current-turn' | null
  /** Surface relationship that must survive asynchronous summarization. */
  readonly stability: 'whole-surface' | 'selected-span'
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
  /** Manual command that initiated this transaction, when present. */
  readonly sourceCommandId?: CommandId
}

interface CompactionEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  readonly latestEndSeedSeq: number | undefined
}

/**
 * Rejects a summary whose replacement boundaries are no longer the ones it was
 * built from, distinguished from summarizer and shrink failures so a manual
 * caller can report the two causes differently.
 */
class SurfaceChangedError extends Error {}

/** Whether the summary may still replace the span it was built from. */
type StabilityCheck = (
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
) => void

/** Failure captured after `compaction/start` has committed. */
interface TransactionFailure {
  readonly error: unknown
  readonly stage: 'summary' | 'commit'
}

/**
 * Resolve the next head-anchored range while retaining a priced recent tail
 * and never splitting an assistant tool-call/result pair.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): { start: number; end: number } | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === 0) return null

  while (keepFromIdx > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null

  // oxlint-disable-next-line typescript/no-non-null-assertion
  const first = surfaceNodes[0]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const cutoff = surfaceNodes[keepFromIdx - 1]!
  return { start: first, end: cutoff }
}

/**
 * Run the single compaction transaction over one selected positional span.
 * Selection and validation are read-only. Idle/log validation and
 * `compaction/start` are synchronously adjacent, so the durable opening marker is
 * the compaction lock before summarization yields. Every later failure makes
 * exactly one `compaction/end` attempt; a failed close deliberately leaves the
 * unmatched start detectable.
 * @param dependencies - conversation meter and dynamically dispatched summarizer hook.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - agent used by the summarizer.
 * @param options - bracket owner, stability rule, and optional durability checkpoint.
 * @param signal - optional summarization cancellation signal.
 * @returns the successful durable compaction result.
 */
export async function compactSurfaceRegion(
  dependencies: RegionDependencies,
  session: Session,
  start: number,
  end: number,
  agent: Agent,
  options: CompactionTransactionOptions,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (options.owner === null) signal?.throwIfAborted()
  const selection = validateSurfaceRegion(session, start, end)
  const entryState = inspectCompactionEntryState(session.events)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    'compaction',
  )

  let owner: number | null
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
    }
    owner = null
  } else {
    if (entryState.openTurn === null) {
      throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
    }
    owner = entryState.openTurn
  }

  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  const assertStable: StabilityCheck = options.stability === 'whole-surface'
    ? assertWholeSurfaceUnchanged
    : assertSelectedSpanStable
  let failure: TransactionFailure | undefined
  let flushFailure: unknown
  let result: CompactionResult | undefined
  let closed = false
  let closing = false
  let stage: TransactionFailure['stage'] = 'summary'

  try {
    const prepared = prepareCompaction(dependencies, session, selection)
    const summarized = await summarizeCompaction(
      dependencies,
      prepared,
      agent,
      compactionId,
      options.sourceCommandId,
      signal,
    )
    if (options.owner === null) signal?.throwIfAborted()
    assertStable(dependencies, session, summarized)
    stage = 'commit'
    const pending = commitCompactionBody(session, startEvent, summarized)
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    result = completeCompaction(pending, endEvent)
  } catch (error: unknown) {
    failure = { error, stage: closing ? 'commit' : stage }
    if (!closing) {
      closing = true
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
        closed = true
      } catch (closeError: unknown) {
        failure = { error: closeError, stage: 'commit' }
      }
    }
  }

  if (closed && options.flush !== undefined) {
    try {
      await options.flush()
    } catch (error: unknown) {
      flushFailure = error
    }
  }

  if (options.owner === null) signal?.throwIfAborted()
  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure)
    throw failure.error
  }
  if (flushFailure !== undefined) {
    throw new ManualCompactionError(
      'persistence',
      'manual compaction durability checkpoint failed',
      { cause: flushFailure },
    )
  }
  /* v8 ignore next -- every path without a result records and throws a failure above. */
  if (result === undefined) throw new Error('compaction committed without a result')
  return result
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure: TransactionFailure): never {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError(
      'commit',
      'manual compaction did not commit cleanly',
      { cause: failure.error },
    )
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError(
      'changed',
      'the compacted history changed during manual compaction',
      { cause: failure.error },
    )
  }
  throw new ManualCompactionError(
    'summary',
    'manual compaction could not produce a smaller summary',
    { cause: failure.error },
  )
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed
 * boundary proves that its owner belongs to an earlier session lifecycle.
 * @param unmatchedCompactionStart - latest unmatched opening marker, if any.
 * @param latestEndSeedSeq - newest constructor-seed boundary, if any.
 * @param stage - operation label included in the busy diagnostic.
 */
function assertCompactionInactive(
  unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined,
  latestEndSeedSeq: number | undefined,
  stage: string,
): void {
  if (unmatchedCompactionStart === undefined
    || (latestEndSeedSeq !== undefined
      && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError(
    'busy',
    `${stage}: compaction already in progress; the session compaction lock is already active`,
  )
}

/**
 * Recheck the durable compaction lock after an asynchronous policy decision.
 * @param session - session whose latest marker state is inspected.
 * @param stage - operation label included in the busy diagnostic.
 */
export function assertNoActiveCompaction(session: Session, stage: string): void {
  const entryState = inspectCompactionEntryState(session.events)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    stage,
  )
}

/** Validate one requested surface-position span before asynchronous work begins. */
function validateSurfaceRegion(session: Session, start: number, end: number): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!)) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!)) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }

  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/** Snapshot pricing and replay input for a validated surface range. */
function prepareCompaction(
  dependencies: RegionDependencies,
  session: Session,
  selection: SurfaceSelection,
): PreparedCompaction {
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError('compaction: selected surface changed before summarization began')
  }
  return {
    ...selection,
    measurement,
    selectedNodes,
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    input: buildSummarizationInput(session, selection.shadowedSeqs),
  }
}

/** Run the summarizer and frame its replacement checkpoint. */
async function summarizeCompaction(
  dependencies: RegionDependencies,
  prepared: PreparedCompaction,
  agent: Agent,
  compactionId: CompactionResult['compactionId'],
  sourceCommandId: CommandId | undefined,
  signal?: AbortSignal,
): Promise<SummarizedCompaction> {
  const summaryResult = await dependencies.summarize(prepared.input, agent, signal)
  const checkpointMessage = createUserMessage({
    content: frameSummary(summaryResult.summary),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  const framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage)
  if (framedSummaryTokenCount >= prepared.shadowedTokenCount) {
    throw new Error(
      `summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedTokenCount})`,
    )
  }
  return {
    ...prepared,
    ...summaryResult,
    checkpointMessage,
  }
}

/** Reject a summary prepared against any earlier surface generation. */
function assertWholeSurfaceUnchanged(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
): void {
  const current = dependencies.meter.measure(session)
  if (!isDeepStrictEqual(current.nodes, prepared.measurement.nodes)) {
    throw new SurfaceChangedError('compaction: session surface changed during summarization')
  }
}

/**
 * Require only that the selected span remain the same present, contiguous,
 * equally priced, balanced replacement target. Nodes added outside it remain
 * visible and do not invalidate the summary.
 */
function assertSelectedSpanStable(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
): void {
  let current: SurfaceSelection
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end)
  } catch (error: unknown) {
    throw new SurfaceChangedError(
      'compaction: the selected span is no longer a valid replacement target',
      { cause: error },
    )
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
    throw new SurfaceChangedError('compaction: the selected span changed during summarization')
  }
  const measured = dependencies.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1)
  if (!isDeepStrictEqual(measured, prepared.selectedNodes)) {
    throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization')
  }
}

/** Append one completed summary record and replacement body without yielding. */
function commitCompactionBody(
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  summarized: SummarizedCompaction,
): Omit<CompactionResult, 'endSeq'> {
  const {
    start,
    end,
    shadowedSeqs,
    shadowedTokenCount,
    summary,
    provider,
    model,
    maxTokens,
    usage,
    checkpointMessage,
  } = summarized
  const callProvenance = summarized.llmStreamCall === true
    ? { rawOutput: summarized.rawOutput, llmStreamCall: true as const }
    : summarized.rawOutput === undefined ? {} : { rawOutput: summarized.rawOutput }
  const summaryEvent = session.append('compaction/summary', {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    summary,
    ...callProvenance,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...usage === undefined ? {} : { usage },
  })
  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  }
}

/** Attach the successfully appended close event to a pending result. */
function completeCompaction(
  pending: Omit<CompactionResult, 'endSeq'>,
  endEvent: SessionEvent<'compaction/end'>,
): CompactionResult {
  return { ...pending, endSeq: endEvent.seq }
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: its system prompt and tool schemas, the harness-captured region
 * facts, then the region's own derived messages in surface order. The
 * summarizer appends only the compaction instruction after this, so the call
 * is a genuine prefix of the conversation and reuses the provider's KV cache.
 * @param session - session supplying the request header, per-node projection,
 *   and the log the region facts are folded from.
 * @param shadowedSeqs - the surface-node seqs, in order, being compacted.
 * @returns the replayed conversation prefix to condense.
 */
function buildSummarizationInput(
  session: Session,
  shadowedSeqs: readonly number[],
): SummarizationInput {
  const header = session.requestHeader()
  const events = session.events
  const regionMessages = shadowedSeqs
    // shadowedSeqs are current surface seqs, so each is a valid log index.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    .map(seq => session.deriveEventMessage(events[seq]!))
    .filter((message): message is Message => message !== null)
  const facts = extractRegionFacts(session, shadowedSeqs)
  const userInput = collectUserInput(regionMessages)
  const baseFiles = facts?.files ?? []
  const hasRegionFacts = baseFiles.length > 0 || facts?.plan !== undefined || userInput.length > 0
  const mergedFacts = hasRegionFacts
    ? { files: baseFiles, ...(facts?.plan === undefined ? {} : { plan: facts.plan }), ...(userInput.length === 0 ? {} : { userInput }) }
    : undefined
  return {
    ...header?.system === undefined ? {} : { system: header.system },
    ...header?.tools === undefined ? {} : { tools: header.tools },
    ...(mergedFacts === undefined ? {} : { facts: mergedFacts }),
    messages: regionMessages,
  }
}

/** File-touching tool names whose arguments carry a path, in the broad set the harness composes. */
const FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read', 'write', 'edit', 'write_file', 'append_file', 'open_file', 'create_file', 'append', 'view',
])

/** Maximum length of a harness-captured file's adjacent explanation before truncation. */
const ADJACENT_EXPLANATION_LIMIT = 200

/**
 * Convert one user-role message to the faithful text the summarizer injects:
 * every text block verbatim, plus a short note when the message carried any
 * non-text block, so nothing the user sent is paraphrased away.
 * @param message - a user-role message authored by the real user, whose content is preserved verbatim.
 * @returns the message text, or a note when it carried only non-text blocks.
 */
function serializeUserInput(message: Message): string {
  const textBlocks = message.content.filter((block): block is TextBlock => block.type === 'text')
  const text = textBlocks.map(block => block.text).join('\n')
  const nonText = message.content.length - textBlocks.length
  const note = nonText > 0 ? `\n\n[user content: ${nonText} non-text block(s) omitted]` : ''
  return `${text}${note}`
}

/**
 * Collect the user's own input from a region, deterministically, in surface
 * order: messages authored by the real user (not by the model, a plugin, or a
 * tool result), so the summarizer preserves the exact wording the user typed
 * instead of letting a later summary paraphrase it away. A `tool`-sourced
 * message carries the model's result rather than the user's input, so it is
 * excluded even though its role is `user`.
 * @param regionMessages - the region's derived messages, in surface order.
 * @returns the user messages' faithful text, in first-seen order.
 */
function collectUserInput(regionMessages: readonly Message[]): readonly string[] {
  const collected: string[] = []
  for (const message of regionMessages) {
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    const text = serializeUserInput(message)
    if (text.length > 0) collected.push(text)
  }
  return collected
}

/**
 * Compute the harness facts the summarizer injects verbatim for a shadowed
 * region: the files its tool calls touched, in first-seen order, each with the
 * assistant text nearest before the call, plus the active plan when plan mode
 * is in force. This folds the log itself and depends on no plan-mode service.
 * @param session - session whose log is scanned.
 * @param shadowedSeqs - the surface-node seqs, in order, being compacted.
 * @returns the region facts, or `undefined` when the region touched no files and no plan was presented.
 */
function extractRegionFacts(
  session: Session,
  shadowedSeqs: readonly number[],
): RegionFacts | undefined {
  if (shadowedSeqs.length === 0) return undefined
  const events = session.events
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const startSeq = shadowedSeqs[0]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const endSeq = shadowedSeqs[shadowedSeqs.length - 1]!
  const files: { readonly path: string; readonly explanation: string }[] = []
  const seen = new Set<string>()
  for (let index = startSeq; index <= endSeq; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type === 'tool/call') {
      const file = fileToolPath(event.data.name, event.data.arguments)
      if (file === undefined) continue
      if (seen.has(file.path)) continue
      seen.add(file.path)
      files.push({ path: file.path, explanation: adjacentText(events, index, startSeq) })
    }
  }
  const plan = foldPlanModeActive(events)
    ? presentPlanWithinRegion(events, startSeq, endSeq)
    : undefined
  if (files.length === 0 && plan === undefined) return undefined
  return {
    files,
    ...(plan === undefined ? {} : { plan }),
  }
}

/**
 * Parse a tool call's raw JSON arguments into a plain object, or `undefined`
 * when the arguments are not valid JSON or are not a JSON object.
 * @param raw - the raw `arguments` string exactly as the model produced it.
 * @returns the parsed record, or `undefined` when it cannot carry a path.
 */
function parseArgumentsJson(raw: string): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // Malformed JSON carries no parseable structure, so treat it as absent.
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Resolve the file path a file-touching tool call targeted, or `undefined`
 * when the tool name is unrecognized or its arguments carry no usable path.
 * @param name - the tool invocation name.
 * @param argumentsJson - the tool invocation's raw JSON arguments.
 * @returns the resolved path, or `undefined` when it is not reported.
 */
function fileToolPath(name: string, argumentsJson: string): { readonly path: string } | undefined {
  if (!FILE_TOOL_NAMES.has(name)) return undefined
  const parsed = parseArgumentsJson(argumentsJson)
  if (parsed === undefined) return undefined
  const path = parsed.file_path ?? parsed.filePath ?? parsed.path
  if (typeof path !== 'string' || path.length === 0) return undefined
  return { path }
}

/**
 * The assistant text nearest before a region tool call, taken from the first
 * non-empty `assistant/message` at or before the call and bounded to the
 * region, truncated for the harness-captured file explanation.
 * @param events - the full session log.
 * @param fromIndex - log index of the tool call to read backward from.
 * @param startSeq - first log index of the shadowed region, the backward search boundary.
 * @returns the truncated adjacent assistant text, or an empty string when none.
 */
function adjacentText(events: readonly SessionEvent[], fromIndex: number, startSeq: number): string {
  for (let index = fromIndex - 1; index >= startSeq; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type === 'assistant/message') {
      return truncateText(assistantMessageText(event.data.message))
    }
  }
  return ''
}

/** Concatenate one assistant message's text blocks, in order. */
function assistantMessageText(message: { readonly content: ContentBlock[] }): string {
  const text: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') text.push(block.text)
  }
  return text.join('\n')
}

/** Truncate one excerpt to the adjacent-explanation limit, marking a cut. */
function truncateText(text: string): string {
  if (text.length <= ADJACENT_EXPLANATION_LIMIT) return text
  return `${text.slice(0, ADJACENT_EXPLANATION_LIMIT)}…`
}

/**
 * Fold plan-mode state from the log: the last `plan/mode` wins, and a log with
 * none folds to inactive. Read structurally so this depends on no plan-mode
 * type augmentation.
 * @param events - the full session log, or any prefix of it.
 * @returns whether plan mode is in force.
 */
function foldPlanModeActive(events: readonly SessionEvent[]): boolean {
  let active = false
  for (const event of events) {
    if ((event.type as string) === 'plan/mode') {
      active = (event.data as { active?: unknown }).active === true
    }
  }
  return active
}

/**
 * The most recently presented plan within the shadowed region, folded from the
 * region's own `exit_plan_mode` calls, or `undefined` when none is recorded.
 * @param events - the full session log.
 * @param startSeq - first log index of the shadowed region.
 * @param endSeq - last log index of the shadowed region.
 * @returns the latest non-empty plan argument, or `undefined` when absent.
 */
function presentPlanWithinRegion(
  events: readonly SessionEvent[],
  startSeq: number,
  endSeq: number,
): string | undefined {
  let plan: string | undefined
  for (let index = startSeq; index <= endSeq; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type === 'tool/call' && event.data.name === 'exit_plan_mode') {
      const parsed = parseArgumentsJson(event.data.arguments)
      const candidate = parsed?.plan
      if (typeof candidate === 'string' && candidate.length > 0) plan = candidate
    }
  }
  return plan
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
function inspectCompactionEntryState(events: readonly SessionEvent[]): CompactionEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown
      && compactionEntryStateKnown
      && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}
