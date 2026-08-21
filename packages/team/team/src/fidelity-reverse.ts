/**
 * Reverse translation from the ACP `session/update` stream to harness session
 * events — the exact inverse of `@deepseek-ai/dsh-acp/fidelity`. One
 * translator instance owns one member topic's stream (live turn or
 * `loadSession` replay): it accumulates user chunks into a single
 * `user/message`, opens the step and content blocks on the first agent-side
 * update of a turn, pairs `tool_call` with its closing `tool_call_update` by
 * `toolCallId`, and folds a `plan` into a `todo/write` snapshot. Updates with
 * no clean inverse (`usage_update`, command/mode/session-info announcements,
 * progress-only tool updates, non-text chunks) are dropped. Turn boundaries
 * are not ACP updates: the live path closes a turn through {@link endTurn}
 * (fed by the member's `session/prompt` settlement), and a replay closes it
 * implicitly when the next `user_message_chunk` arrives or through
 * {@link finish} at the end of the stream.
 *
 * The translated events carry no envelope: `seq`/`time` stamping and the
 * session they belong to stay with the caller (the host bridge appends each
 * event through `Session.append`, which owns both).
 *
 * @module @deepseek-ai/dsh-team/fidelity-reverse
 */

import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEventMap, SurfaceEventType, SurfaceIntent, TurnEndReason } from '@deepseek-ai/dsh-session/types'

/** The session event types the reverse translation can produce. */
export type TranslatedEventType =
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'step/end'
  | 'user/message'
  | 'assistant/message'
  | 'assistant/chunk'
  | 'tool/call'
  | 'tool/result'
  | 'todo/write'

/**
 * One translated event in the shape `Session.append` accepts: the type and
 * payload, plus the mandatory surface intent on surface events. The envelope
 * (`seq`, `time`) is deliberately absent — the appending session owns it.
 */
export type TranslatedSessionEvent = {
  [K in TranslatedEventType]: {
    type: K
    data: SessionEventMap[K]
  } & (K extends SurfaceEventType ? SurfaceIntent : object)
}[TranslatedEventType]

/**
 * Map an ACP stop reason to the harness turn-end reason. ACP carries no
 * failure detail, so `refusal` and `max_turn_requests` become generic
 * structured errors rather than a falsified `completed`.
 * @param reason - the stop reason the member returned from `session/prompt`.
 * @returns the harness turn-end reason.
 */
export function stopReasonToTurnEnd(reason: StopReason): TurnEndReason {
  switch (reason) {
    case 'end_turn':
      return { kind: 'completed' }
    case 'cancelled':
      return { kind: 'aborted', reason: { kind: 'user' } }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'refusal':
      return { kind: 'error', error: { message: 'the member refused the prompt', code: 'REFUSAL' } }
    case 'max_turn_requests':
      return { kind: 'error', error: { message: 'the member exceeded its turn request limit', code: 'MAX_TURN_REQUESTS' } }
    default:
      // StopReason is a closed wire union; a newer peer can still send an
      // unknown value, and that must not record a success.
      return { kind: 'error', error: { message: `the member stopped for an unrecognized reason: ${reason as string}`, code: 'UNKNOWN_STOP_REASON' } }
  }
}

/**
 * Stateful ACP→SessionEvent translator for one member topic. Turn and step
 * numbers are translator-local (1-based; steps reset per turn, matching the
 * agent loop's numbering) and consistent only within one instance's stream. The
 * live bridge mints `user/message` through {@link startTurn}; an agent echo of
 * the same user text is suppressed so the same turn does not show two user
 * bubbles. Each closing step emits a committed `assistant/message` assembled
 * from the step's streamed text/reasoning blocks, so the client marks the step
 * settled rather than interrupted.
 */
export class AcpUpdateTranslator {
  /** The current turn number; 0 while no turn has opened. */
  private turn = 0
  /** The current step number within the open turn; 0 while no step has opened. */
  private step = 0
  private turnOpen = false
  private stepOpen = false
  /** Accumulated user-chunk text awaiting the turn's `user/message`. */
  private userParts: string[] = []
  /** Next content-block index within the open step. */
  private nextBlock = 0
  /** The open step's text block index, once its first chunk arrived. */
  private textBlock: number | undefined
  /** The open step's reasoning block index, once its first chunk arrived. */
  private reasoningBlock: number | undefined
  /** Tool-call ids seen in the open step but not yet closed by a completed/failed update. */
  private readonly openCalls = new Set<string>()
  /**
   * Text of the turn most recently minted by {@link startTurn}. When the agent
   * echoes the same text as `user_message_chunk` updates, the duplicate is
   * suppressed when it would next flush.
   */
  private lastMintedTurnText: string | undefined
  /** Accumulated text for the open step's text block, used to mint `assistant/message`. */
  private textBlockText = ''
  /** Accumulated text for the open step's reasoning block, used to mint `assistant/message`. */
  private reasoningBlockText = ''

  /**
   * Translate one ACP session update to zero or more session events.
   * @param update - one lossless `session/update` payload.
   * @returns the events the update produced, in append order (empty when the
   * update has no harness inverse).
   */
  update(update: SessionUpdate): TranslatedSessionEvent[] {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        return this.userChunk(update)
      case 'agent_message_chunk':
        return this.agentChunk(update, 'text')
      case 'agent_thought_chunk':
        return this.agentChunk(update, 'reasoning')
      case 'tool_call':
        return this.toolCall(update)
      case 'tool_call_update':
        return this.toolCallUpdate(update)
      case 'plan':
        return [{
          type: 'todo/write',
          data: { todos: update.entries.map(entry => ({ content: entry.content, status: entry.status })) },
        }]
      default:
        // usage_update has no inverse (token accounting is not reconstructable
        // from context-window occupancy); command/mode/session-info/config
        // announcements and plan deltas are UI state with no session event.
        return []
    }
  }

  /**
   * Open a new turn with a user message (the live bridge path: ACP servers may
   * not emit a `user_message_chunk` before agent output). Closes any previous
   * open turn as completed, then emits `turn/start` and `user/message`.
   * @param text - the user text that opens the turn.
   * @returns the opening events in append order.
   */
  startTurn(text: string): TranslatedSessionEvent[] {
    const events = this.turnOpen ? this.closeTurn({ kind: 'completed' }) : []
    this.userParts.push(text)
    events.push(...this.openTurn())
    // Record after openTurn flushes, so an agent echo of this exact text can
    // be deduplicated against it while the minted user/message is kept.
    this.lastMintedTurnText = text
    return events
  }

  /**
   * Close the open turn (the live path: the member's `session/prompt`
   * settled). A pending user message is flushed first, so a turn that ended
   * before any agent output still records its input.
   * @param reason - the stop reason the member returned.
   * @returns the closing `step/end` (when a step is open) and `turn/end`.
   */
  endTurn(reason: StopReason): TranslatedSessionEvent[] {
    return this.closeTurn(stopReasonToTurnEnd(reason))
  }

  /**
   * Close the open turn as failed (the live path: the member answered
   * `session/prompt` with a protocol error, so no stop reason exists).
   * @param message - the member's error message, carried into the turn/end.
   * @returns the closing `step/end` (when a step is open) and error `turn/end`.
   */
  failTurn(message: string): TranslatedSessionEvent[] {
    return this.closeTurn({ kind: 'error', error: { message, code: 'UNKNOWN' } })
  }

  /**
   * Close whatever the stream left open at its end (the replay path: a
   * `loadSession` history is committed work, so the tail turn ends
   * `completed`).
   * @returns the tail events, including a flushed trailing user message.
   */
  finish(): TranslatedSessionEvent[] {
    return this.closeTurn({ kind: 'completed' })
  }

  /** Accumulate one user chunk; a chunk arriving mid-turn closes that turn as completed (replay boundary). */
  private userChunk(update: SessionUpdate & { sessionUpdate: 'user_message_chunk' }): TranslatedSessionEvent[] {
    if (update.content.type !== 'text') return []
    const events = this.turnOpen ? this.closeTurn({ kind: 'completed' }) : []
    this.userParts.push(update.content.text)
    return events
  }

  /** Emit one agent text/reasoning chunk, opening the turn, step, and block on first use. */
  private agentChunk(
    update: SessionUpdate & { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' },
    kind: 'text' | 'reasoning',
  ): TranslatedSessionEvent[] {
    if (update.content.type !== 'text') return []
    const events = this.openAgentStep()
    let index = kind === 'text' ? this.textBlock : this.reasoningBlock
    if (index === undefined) {
      index = this.nextBlock++
      if (kind === 'text') this.textBlock = index
      else this.reasoningBlock = index
      events.push(this.chunk({ type: 'block-start', index, blockType: kind }))
    }
    if (kind === 'text') {
      this.textBlockText += update.content.text
      events.push(this.chunk({ type: 'text-delta', index, text: update.content.text }))
    } else {
      this.reasoningBlockText += update.content.text
      events.push(this.chunk({ type: 'reasoning-delta', index, text: update.content.text }))
    }
    return events
  }

  /** Emit the opening `tool/call` for one member tool invocation. */
  private toolCall(update: SessionUpdate & { sessionUpdate: 'tool_call' }): TranslatedSessionEvent[] {
    const events = this.openAgentStep()
    this.openCalls.add(update.toolCallId)
    events.push({
      type: 'tool/call',
      data: {
        turn: this.turn,
        step: this.step,
        callId: CallId(update.toolCallId),
        name: update.title,
        // The forward direction parses the raw arguments JSON when valid and
        // keeps the raw string otherwise. Reproduce the original model output:
        // a string is emitted verbatim, an object is re-encoded, and absent
        // input defaults to an empty object record.
        arguments: this.encodeToolArguments(update.rawInput),
      },
    })
    return events
  }

  /** Emit the closing `tool/result` for a completed/failed tool update; progress updates produce nothing. */
  private toolCallUpdate(update: SessionUpdate & { sessionUpdate: 'tool_call_update' }): TranslatedSessionEvent[] {
    if (update.status !== 'completed' && update.status !== 'failed') return []
    // An unmatched update still translates: the result carries every fact the
    // pairing needs, and dropping it would gut the replayed history.
    this.openCalls.delete(update.toolCallId)
    const events = this.openAgentStep()
    const content: ContentBlock[] = []
    for (const item of update.content ?? []) {
      // Non-text tool content (diffs, terminals, resources) has no harness
      // block inverse in v1; the forward direction keeps it in rawOutput only.
      if (item.type === 'content' && item.content.type === 'text') {
        content.push({ type: 'text', text: item.content.text })
      }
    }
    events.push({
      type: 'tool/result',
      data: {
        turn: this.turn,
        step: this.step,
        message: createToolResultMessage({
          callId: CallId(update.toolCallId),
          content,
          isError: update.status === 'failed',
        }),
      },
      surfaceOp: 'append',
    })
    return events
  }

  /** Open the turn if none is open, flushing the pending user message into it. */
  private openTurn(): TranslatedSessionEvent[] {
    if (this.turnOpen) return []
    this.turn += 1
    this.step = 0
    this.turnOpen = true
    const events: TranslatedSessionEvent[] = [{ type: 'turn/start', data: { turn: this.turn } }]
    if (this.userParts.length > 0) {
      const text = this.userParts.join('')
      if (text === this.lastMintedTurnText) {
        // The agent echoed the user message already minted by the live bridge
        // for this turn; drop the duplicate rather than emit a second user/message.
        this.userParts = []
        this.lastMintedTurnText = undefined
      } else {
        events.push({
          type: 'user/message',
          data: createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }),
          surfaceOp: 'append',
        })
        this.userParts = []
        this.lastMintedTurnText = undefined
      }
    }
    return events
  }

  /** Open the turn (flushing the pending user message) and step as agent output demands. */
  private openAgentStep(): TranslatedSessionEvent[] {
    const events = this.openTurn()
    if (!this.stepOpen) {
      this.step += 1
      this.stepOpen = true
      this.nextBlock = 0
      this.textBlock = undefined
      this.reasoningBlock = undefined
      this.textBlockText = ''
      this.reasoningBlockText = ''
      events.push({ type: 'step/start', data: { turn: this.turn, step: this.step } })
    }
    return events
  }

  /** Flush any pending user message, then close the open step and turn. */
  private closeTurn(reason: TurnEndReason): TranslatedSessionEvent[] {
    if (!this.turnOpen && this.userParts.length === 0) return []
    // A stream tail of user input the member never answered still records its
    // lone-input turn (turn/start + user/message + turn/end, no step bracket:
    // a turn with no entered step has no step events).
    const events = this.openTurn()
    if (!this.turnOpen) return events
    if (this.stepOpen) {
      events.push({
        type: 'assistant/message',
        data: {
          turn: this.turn,
          step: this.step,
          message: createAssistantMessage({
            content: this.assembleAssistantBlocks(),
            source: { provider: 'member', model: 'member' },
          }),
        },
        surfaceOp: 'append',
      })
      events.push({ type: 'step/end', data: { turn: this.turn, step: this.step } })
      this.stepOpen = false
    }
    events.push({ type: 'turn/end', data: { turn: this.turn, reason } })
    this.turnOpen = false
    return events
  }

  /** Assemble the open step's accumulated text/reasoning blocks in block order. */
  private assembleAssistantBlocks(): ContentBlock[] {
    const blocks: ContentBlock[] = []
    const maxIndex = Math.max(this.textBlock ?? -1, this.reasoningBlock ?? -1)
    for (let index = 0; index <= maxIndex; index++) {
      if (index === this.textBlock && this.textBlockText.length > 0) {
        blocks.push({ type: 'text', text: this.textBlockText })
      }
      if (index === this.reasoningBlock && this.reasoningBlockText.length > 0) {
        blocks.push({ type: 'reasoning', text: this.reasoningBlockText })
      }
    }
    return blocks
  }

  /** One raw stream chunk event for the open step. */
  private chunk(chunk: SessionEventMap['assistant/chunk']['chunk']): TranslatedSessionEvent {
    return { type: 'assistant/chunk', data: { turn: this.turn, step: this.step, chunk } }
  }

  /** Reproduce the raw arguments JSON string the model produced. */
  private encodeToolArguments(rawInput: unknown): string {
    if (rawInput === undefined) return '{}'
    if (typeof rawInput === 'string') return rawInput
    return JSON.stringify(rawInput)
  }
}
