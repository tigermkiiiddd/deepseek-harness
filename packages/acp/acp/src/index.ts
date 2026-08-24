/**
 * Automation-only Agent Client Protocol server over JSON-RPC stdio.
 *
 * The bridge exposes fresh harness sessions to trusted programmatic clients. It
 * carries prompt text/images, committed assistant text/images, cancellation,
 * and one-shot permission decisions; presentation and human-interaction
 * features stay with the harness's UI modules.
 *
 * @module @deepseek-ai/dsh-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionCapabilities,
  type SessionInfo,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import { installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import { AcpContentError, admitAcpPrompt, assistantBlockToAcp, supportsAcpImagePrompts } from './content.ts'
import { thoughtToChunk, toolCallToUpdate, toolResultToUpdate, todosToPlan, usageToUpdate } from './fidelity.ts'
import { turnEndToStopReason } from './codec.ts'

export const name = 'acp'
/** The bridge creates and owns agents; every other concern is carried by the agent composition. */
export const inject = ['agents']

/**
 * The single continuable-subagent teardown the bridge needs. Declared
 * structurally so this package does not depend on the subagent seam for one
 * shutdown hook; an absent service means nothing continuable was materialized.
 */
interface ContinuableDrain {
  /**
   * Close admission below exact host-owned parents, then dispose only their
   * continuable descendants child-first.
   */
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/**
 * The llm catalog seam the bridge reads to build the model selector. Declared
 * structurally so this package does not hard-depend on the llm Service.
 */
interface LlmCatalog {
  /** The provider routes with a registered adapter, in registration order. */
  listProviders(): readonly { id: string }[]
  /** The models registered on one provider route, in display order. */
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/** One selectable catalog entry: the route that serves it plus its model info. */
interface CatalogEntry {
  provider: string
  model: LlmModelInfo
}

/** The wire value for one catalog entry; unique because both parts are non-empty. */
function compositeModelValue(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

/**
 * The default-model seam the bridge reads for each agent's initial model.
 * Declared structurally so this package does not hard-depend on the Service.
 */
interface AgentDefaultModel {
  /** The default model selection for agents created without one. */
  currentSelection(): ModelSelection
}

/**
 * The preset roster seam the bridge reads to compose an agent's persona.
 * Declared structurally so this package does not hard-depend on the Service.
 */
interface PresetsRoster {
  /** Compose one agent from its preset (the default when `id` is omitted). */
  mount(agentCtx: Context, id?: string): Promise<{ readonly id: string }>
}

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
})

/** Per-session protocol state. */
interface SessionRecord {
  agent: Agent
  /** Exact owned-agent disposer; resolves after registry, loop, and session teardown. */
  dispose: () => Promise<void>
  /** Ordered assistant-output delivery; every task contains its own failure. */
  outputTail: Promise<void>
  /**
   * The mutable model selection installed on this agent's scope. A
   * `session/set_config_option` for `"model"` rewrites `current`, and the next
   * step's prompt assembly applies it. Always present: `buildModelState`
   * minted one at session creation.
   */
  modelRef: ModelSelectionRef
  /** The model selector options advertised to the client on session creation. */
  modelOptions: SessionConfigOption[]
  /** The full multi-route catalog the model selector validates a value against. */
  modelCatalog: readonly CatalogEntry[]
  /** In-flight admission/turn/output lifecycle for exact settlement. */
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    /** Set only after rich-content admission succeeds and the message is built. */
    messageId: string | undefined
    /** Whether this prompt has entered the Agent's durable inbox interval. */
    messageQueued: boolean
    turn: number | undefined
    /** The correlated turn's ending, set at turn/end and settled at whole-agent idle. */
    endReason: TurnEndReason | undefined
    /** Admission quiescence gate, including any attachment write already in progress. */
    admissionDone: Promise<void>
    finishAdmission: () => void
    admissionController: AbortController
    cancelRequested: boolean
    settlementStarted: boolean
    /** Conversion failure for committed output owned by this prompt's turn. */
    outputError: Error | undefined
    /** Interval-wide failure outside the correlated turn. */
    agentError: Error | undefined
  } | undefined
}

/** The optional session-persistence seam the bridge reads for list/load. */
interface SessionPersistenceReader {
  list(): Promise<SessionHeader[]>
  load(sessionId: SessionId): Promise<{ events: SessionEvent[] }>
}

/**
 * Mount the automation-only ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Initial provider/model selection and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const agents = ctx.agents
  const logger = ctx.logger
  const sessions = new Map<SessionId, SessionRecord>()
  let closed = false
  /**
   * Per-connection negotiation: a client that sent
   * `InitializeRequest._meta.fullFidelity === true` additionally receives
   * thought, tool-call, plan, and usage updates; every other client gets the
   * unchanged committed-text automation stream.
   */
  const fullFidelity = false
  let conn: AgentSideConnection
  let imagePromptEnabled = false

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send one ordered protocol update while containing transport-only failure. */
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      await conn.sessionUpdate(notification)
    /* v8 ignore start -- the ACP SDK contains notification-handler failures; only a transport write failure reaches this guard. */
    } catch (error: unknown) {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    }
    /* v8 ignore stop */
  }

  /**
   * Route one harness event to the full-fidelity wire for a connection that
   * negotiated rich updates. Emits per-event thought, usage, tool, and plan
   * chunks; the committed assistant stream still flows through the automation
   * path so wire order matches log order. Reasoning precedes usage so the
   * client sees a step's thought before its token accounting.
   * @param record - the session whose wire the updates target.
   * @param event - the harness session event to project.
   */
  const emitFullFidelity = (record: SessionRecord, event: SessionEvent): void => {
    const sessionId = record.agent.session.id
    switch (event.type) {
      case 'assistant/message': {
        for (const block of event.data.message.content) {
          if (block.type === 'reasoning') notify({ sessionId, update: thoughtToChunk(block.text) })
        }
        const contextWindow = record.agent.session.requestContext()?.contextWindow
        if (event.data.usage !== undefined && contextWindow !== undefined) {
          notify({ sessionId, update: usageToUpdate(event.data.usage, contextWindow) })
        }
        break
      }
      case 'tool/call':
        notify({ sessionId, update: toolCallToUpdate(event.data) })
        break
      case 'tool/result':
        notify({ sessionId, update: toolResultToUpdate(event.data) })
        break
      case 'todo/write':
        notify({ sessionId, update: todosToPlan(event.data.todos) })
        break
      default:
        break
    }
  }

  const rejectFromError = (
    inflight: NonNullable<SessionRecord['inflight']>,
    reason: Extract<TurnEndReason, { kind: 'error' }>,
  ): void => {
    inflight.reject(internalError(`turn failed: ${reason.error.message}`))
  }

  /**
   * Settle one exact prompt only after admission, agent activity, and ordered
   * assistant delivery have all reached quiescence.
   */
  const settleAfterQuiescence = (
    record: SessionRecord,
    inflight: NonNullable<SessionRecord['inflight']>,
  ): void => {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        await record.agent.whenIdle()
        // session/event enqueues synchronously before the agent becomes idle;
        // reading the live tail here includes every committed output task.
        await record.outputTail
      }
      /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
      if (record.inflight !== inflight) return
      record.inflight = undefined
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        rejectFromError(inflight, end)
      } else {
        // Token-limit and other non-terminal endings are not prompt-level stop
        // reasons; ordinary quiescence reports end_turn.
        inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end))
      }
    })()
    /* v8 ignore start -- admissionDone only resolves, and the queued path's idle/output gates contain their own failures. */
      .catch((error: unknown) => {
        if (record.inflight !== inflight) return
        record.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }

  // Emit only committed assistant text/images. Raw chunks, reasoning, tools,
  // plans, titles, and retry markers are presentation or trace data and stay
  // off the automation wire. One per-session chain preserves block/message
  // order across asynchronous attachment reads.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      if (event.type === 'assistant/message') {
        const inflight = record.inflight?.turn === event.data.turn ? record.inflight : undefined
        const previous = record.outputTail
        const delivery = previous.then(async () => {
          for (const block of event.data.message.content) {
            const content = await assistantBlockToAcp(ctx, block)
            if (content === undefined) continue
            await notify({
              sessionId: record.agent.session.id,
              update: { sessionUpdate: 'agent_message_chunk', content },
            })
          }
        })
        record.outputTail = delivery.catch((error: unknown) => {
          // assistantBlockToAcp owns conversion failures and always throws Error.
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`)
        })
      }
      if (fullFidelity) emitFullFidelity(record, event)
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || !inflight.messageQueued || inflight.turn === turn) return
    inflight.agentError = new Error(errorChain(error))
    settleAfterQuiescence(record, inflight)
  })

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return conn.requestPermission({
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    /**
     * Compose one created agent's scoped world: the mutable model selection,
     * and the standing preset it runs on (its persona and tools). Called
     * during `agents.create` so the agent's own context owns them and unwinds
     * with it. The roster is optional: a tree without it still composes the
     * agent, just without a preset persona. A member that carries its own
     * preset resolves it through the roster's default — its seeded settings
     * point there — so the same mount gives every agent its own composition.
     * @param agentCtx - the created agent's scoped context.
     * @param model - the agent's model selection state.
     */
    const composeAgent = async (agentCtx: Context, model: ModelState): Promise<void> => {
      installModelSelection(agentCtx, model.ref)
      const presets = ctx.get('agentPresets') as PresetsRoster | undefined
      if (presets !== undefined) await presets.mount(agentCtx)
    }
    return {
      async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        // Single-version agent: the spec's "same version if supported, else
        // the latest supported" both resolve to this server's one version.
        imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
          agentCapabilities: {
            promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
            // The bridge implements session/load, so it advertises loadSession and
            // the model selector the client gates setSessionConfigOption on.
            loadSession: true,
            // The pinned SDK's SessionListCapabilities predates this
            // experimental flag, so the object is cast to the capability shape.
            sessionCapabilities: { list: { setSessionConfigOption: {} } } as SessionCapabilities,
          },
          authMethods: [],
        }
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve()
      },

      /**
       * Change one session config option. The bridge supports the `"model"`
       * selector (rewriting the agent's mutable selection) and returns the
       * updated selector; every other option id is refused.
       * @param params - the session and option to change.
       * @returns the updated config options.
       */
      // oxlint-disable-next-line typescript/require-await -- async keeps the guard rejections a rejection, not a synchronous throw
      async setSessionConfigOption(
        params: SetSessionConfigOptionRequest,
      ): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (params.configId === 'model') {
          return changeModel(record, params)
        }
        throw invalidParams(`unsupported config option: ${params.configId}`)
      },

      async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
        assertOpen()
        const persistence = ctx.get('sessionPersistence') as SessionPersistenceReader | undefined
        if (persistence === undefined) {
          throw internalError('session listing requires session persistence')
        }
        const headers = await persistence.list()
        // A session without a workspace cannot be resumed through this bridge
        // (session/new and loadSession both require an absolute cwd), so it is
        // omitted from the topic list rather than reported with a fake one.
        const sessions: SessionInfo[] = []
        for (const header of headers) {
          if (header.cwd === undefined) continue
          if (params.cwd !== undefined && header.cwd !== params.cwd) continue
          sessions.push({ sessionId: header.id, cwd: header.cwd })
        }
        return { sessions }
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const sessionId = SessionId(params.sessionId)
        // Idempotent for an already-live session: the client may re-load the
        // topic it is already talking to.
        if (sessions.has(sessionId)) return {}
        const persistence = ctx.get('sessionPersistence') as SessionPersistenceReader | undefined
        if (persistence === undefined) {
          throw internalError('loading a session requires session persistence')
        }
        let events: SessionEvent[]
        try {
          const inspection = await persistence.load(sessionId)
          events = inspection.events
        } catch {
          throw invalidParams(`unknown session: ${sessionId}`)
        }
        const model = await buildModelState(ctx, config)
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
          seed: events,
          setup: agentCtx => composeAgent(agentCtx, model),
        })
        /* v8 ignore next 4 -- a real stdio close can race an in-flight load. */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/load')
        }
        const record: SessionRecord = {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          outputTail: Promise.resolve(),
          inflight: undefined,
          modelRef: model.ref,
          modelOptions: model.options,
          modelCatalog: model.catalog,
        }
        sessions.set(sessionId, record)
        // The loadSession contract streams the session's history back to the
        // client so a GUI can render the topic without a second read path.
        // Automation clients receive the same text-only chunks as before;
        // full-fidelity clients also receive the per-event updates mapped live
        // by `emitFullFidelity`, preserving log order and the context-window
        // gating that suppresses `usage_update` until a `request/context` event
        // advertises the route's capacity.
        for (const event of events) {
          if (fullFidelity) {
            const base = historyChunk(event)
            if (base !== undefined) notify({ sessionId, update: base })
            emitFullFidelity(record, event)
          } else {
            const update = historyChunk(event)
            if (update !== undefined) {
              /* v8 ignore next 3 -- a disconnected client must not fail the load. */
              void conn.sessionUpdate({ sessionId, update }).catch(() => { /* client gone */ })
            }
          }
        }
        return { configOptions: [...model.options] }
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const sessionId = SessionId(randomUUID())
        // The agent composes its persona from its standing preset (its own when
        // the member carries one, through the roster's seeded default) and reads
        // its model from the shared agent-default-model service; the model is
        // exposed as a session config option so the member tool can query and
        // change it. `composeAgent` installs both (model here, persona in the
        // preset composition).
        const model = await buildModelState(ctx, config)
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
          setup: agentCtx => composeAgent(agentCtx, model),
        })
        /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        sessions.set(sessionId, {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          outputTail: Promise.resolve(),
          inflight: undefined,
          modelRef: model.ref,
          modelOptions: model.options,
          modelCatalog: model.catalog,
        })
        return { sessionId, configOptions: [...model.options] }
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        const completion = Promise.withResolvers<StopReason>()
        const admission = Promise.withResolvers<void>()
        const admissionController = new AbortController()
        const inflight: NonNullable<SessionRecord['inflight']> = {
          resolve: completion.resolve,
          reject: completion.reject,
          messageId: undefined,
          messageQueued: false,
          turn: undefined,
          endReason: undefined,
          admissionDone: admission.promise,
          finishAdmission: admission.resolve,
          admissionController,
          cancelRequested: false,
          settlementStarted: false,
          outputError: undefined,
          agentError: undefined,
        }
        // Reserve the one-prompt slot before the first asynchronous route or
        // attachment operation so concurrent prompts and cancellation observe
        // admission as genuinely in flight.
        record.inflight = inflight

        let admissionFailed = false
        let admissionFailure: unknown
        try {
          // Do not persist rich content for a retired destination. Re-check
          // after admission too because an agent-loop reload may race storage.
          if (ctx.agents.get(record.agent.id) !== record.agent) {
            throw internalError('prompt was not queued: the agent was disposed outside the bridge')
          }
          const content = await admitAcpPrompt(
            ctx,
            record.agent,
            params.prompt,
            imagePromptEnabled,
            admissionController.signal,
          )
          // No await may separate this final abort check from followup: a
          // cancellation that wins admission must never enqueue a late turn.
          admissionController.signal.throwIfAborted()
          if (ctx.agents.get(record.agent.id) !== record.agent) {
            throw internalError('prompt was not queued: the agent was disposed outside the bridge')
          }
          const message = createUserMessage({ content, source: { kind: 'user' } })
          inflight.messageId = message.id
          inflight.messageQueued = true
          try {
            record.agent.followup(message)
          } catch (error: unknown) {
            // The typed same-process seam may fail synchronously before durable
            // inbox receipt; restore the pre-operation boundary for mapping.
            inflight.messageQueued = false
            throw error
          }
        } catch (error: unknown) {
          admissionFailed = true
          admissionFailure = error
        } finally {
          inflight.finishAdmission()
        }

        if (inflight.cancelRequested) {
          settleAfterQuiescence(record, inflight)
          return { stopReason: await completion.promise }
        }
        if (admissionFailed) {
          record.inflight = undefined
          if (admissionFailure instanceof AcpContentError) {
            throw admissionFailure.kind === 'invalid'
              ? invalidParams(admissionFailure.message)
              : internalError(admissionFailure.message)
          }
          if (admissionFailure instanceof RequestError) throw admissionFailure
          // The admission codec and same-process agent seam throw Error values.
          const detail = (admissionFailure as Error).message
          throw internalError(`prompt was not queued: ${detail}`)
        }

        settleAfterQuiescence(record, inflight)
        const stopReason = await completion.promise
        return { stopReason }
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        const inflight = record.inflight
        if (inflight !== undefined) {
          inflight.cancelRequested = true
          inflight.admissionController.abort(new Error('ACP prompt cancelled'))
          settleAfterQuiescence(record, inflight)
        }
        // Admission is not Agent work. Preserve unrelated producers until this
        // prompt has entered the durable inbox; without a prompt, cancellation
        // continues to target autonomous work on the addressed Agent.
        if (inflight === undefined || inflight.messageQueued) record.agent.cancel({ kind: 'user' })
        return Promise.resolve()
      },
    }
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    // Stop the bridge's own work before any await: a descendant drain can block
    // on persistence or scoped cleanup, and the top-level agents must not keep
    // running model and tool calls for its whole duration.
    for (const record of records) {
      const inflight = record.inflight
      if (inflight !== undefined) {
        inflight.cancelRequested = true
        inflight.admissionController.abort(new Error('ACP bridge disposed'))
        settleAfterQuiescence(record, inflight)
      }
      record.agent.cancel({ kind: 'user' })
    }
    quiescing = (async () => {
      // Preserve the same prompt boundary during connection teardown: a rich
      // admission already writing must stop before its slot settles, and every
      // committed output conversion must drain while attachment services remain
      // available. session/event enqueues output synchronously before idle.
      await Promise.all(records.map(async (record) => {
        await record.inflight?.admissionDone
        await record.agent.whenIdle()
        await record.outputTail
      }))
      // Continuable subagents outlive the turn that started them, and their
      // Activations own descendant teardown. Drain only these sessions' forests
      // child-first BEFORE disposing the top-level agents, so no descendant is
      // left holding a runtime its owner already released and another frontend
      // sharing this Context remains live.
      // Read the one teardown method structurally: the bridge needs no other
      // part of the subagent seam, so it does not depend on that package.
      const subagents = ctx.get('subagents') as ContinuableDrain | undefined
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map(record => record.agent))
        } catch (error: unknown) {
          logger.warn(`acp: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const disposals = await Promise.allSettled(records.map(record => record.dispose()))
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- production transport rejection and teardown failure. */
  void conn.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * @param config - ACP provider/model configuration.
 * @returns the configured fields only.
 */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

/**
 * Resolve the initial model selection for one agent: the default-model
 * selection when the seam is present, otherwise the plugin-config selection,
 * otherwise none (the agent keeps its own default).
 * @param ctx - the bridge context.
 * @param config - ACP provider/model configuration.
 * @returns the initial selection, or `undefined` when neither seam provides one.
 */
function initialSelection(ctx: Context, config: AcpConfig): ModelSelection | undefined {
  const defaultModel = ctx.get('agentDefaultModel') as AgentDefaultModel | undefined
  if (defaultModel !== undefined) return defaultModel.currentSelection()
  if (config.provider === undefined || config.model === undefined) return undefined
  return { provider: config.provider, model: config.model }
}

/**
 * Read the full multi-route llm catalog, best-effort per route.
 * @param ctx - the bridge context.
 * @returns every entry across all registered routes, in registration order;
 *   a route whose listing fails is skipped, and a missing seam yields none.
 */
async function readCatalog(ctx: Context): Promise<readonly CatalogEntry[]> {
  const catalog = ctx.get('llm') as LlmCatalog | undefined
  if (catalog === undefined) return []
  const entries: CatalogEntry[] = []
  for (const { id: provider } of catalog.listProviders()) {
    try {
      for (const model of await catalog.listModels(provider)) {
        entries.push({ provider, model })
      }
    } catch {
      // One unreadable route must not blank the selector for the others.
    }
  }
  return entries
}

/**
 * Build the model selection state for one agent: the mutable selection
 * installed on the agent scope, plus the `"model"` selector built from the
 * full multi-route catalog. The initial selection only pins the advertised
 * current value — it is not a condition for advertising. Any non-empty
 * catalog offers the whole directory (the main instance's picker breadth),
 * falling back to the first entry when no initial selection exists.
 * @param ctx - the bridge context.
 * @param config - ACP provider/model configuration.
 * @returns the resolved model state.
 */
async function buildModelState(ctx: Context, config: AcpConfig): Promise<ModelState> {
  const selection = initialSelection(ctx, config)
  const ref: ModelSelectionRef = { current: selection, assembled: undefined }
  const catalog = await readCatalog(ctx)
  const first = catalog[0]
  const currentValue = selection !== undefined
    ? compositeModelValue(selection.provider, selection.model)
    : first !== undefined
      ? compositeModelValue(first.provider, first.model.id)
      : undefined
  const options = catalog.length === 0 || currentValue === undefined
    ? []
    : [modelSelector(catalog, currentValue)]
  return { ref, options, catalog }
}

/**
 * Build the `"model"` select option from the full catalog, pinning the current
 * composite value.
 * @param models - every route's entries, in registration order; non-empty when this builds.
 * @param current - the current entry's composite value, always defined by the caller.
 * @returns the model selector option.
 */
function modelSelector(
  models: readonly CatalogEntry[],
  current: string,
): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: models.map(({ provider, model }) => ({
      value: compositeModelValue(provider, model.id),
      name: model.name,
      ...(model.description !== undefined ? { description: model.description } : {}),
    })),
  }
}

/**
 * Apply a `"model"` selector change: match the composite value against the
 * full catalog, rewrite the agent's mutable selection so the next step applies
 * it (including a cross-provider switch), and rebuild the selector options.
 * @param record - the session whose agent selection to rewrite.
 * @param params - the session and option value.
 * @returns the updated model selector options.
 */
function changeModel(
  record: SessionRecord,
  params: SetSessionConfigOptionRequest,
): SetSessionConfigOptionResponse {
  if (typeof params.value !== 'string' || params.value.length === 0) {
    throw invalidParams('config option "model" must be a non-empty string')
  }
  const value = params.value
  // Decode by whole-string match against enumerated entries, never by
  // splitting: a model id containing "/" stays unambiguous because both the
  // advertisement and this lookup derive values from the same entries.
  const matched = record.modelCatalog.find(entry => compositeModelValue(entry.provider, entry.model.id) === value)
  if (matched === undefined) {
    throw invalidParams(`unknown model: ${value}`)
  }
  const previous = record.modelRef.current
  const sameRoute = previous?.provider === matched.provider && previous?.model === matched.model.id
  record.modelRef.current = {
    provider: matched.provider,
    model: matched.model.id,
    ...(sameRoute && previous?.reasoningEffort !== undefined
      ? { reasoningEffort: previous.reasoningEffort }
      : {}),
  }
  record.modelOptions = [modelSelector(record.modelCatalog, value)]
  return { configOptions: record.modelOptions }
}

/**
 * One agent's model selection plus the model selector options built for it.
 */
interface ModelState {
  /** Mutable selection installed on the agent scope. */
  readonly ref: ModelSelectionRef
  /** The model selector options advertised to the client. */
  readonly options: SessionConfigOption[]
  /** The full multi-route catalog the selector validates values against. */
  readonly catalog: readonly CatalogEntry[]
}

/** Workspace fields shared by session creation and loading. */
interface SessionWorkspaceParams {
  readonly cwd: string
  readonly mcpServers: readonly unknown[]
  readonly additionalDirectories?: readonly string[]
}

/** A message event's committed text joined, or undefined when it has none. */
function messageText(message: { content: readonly { type: string; text?: string }[] }): string | undefined {
  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  return text.length > 0 ? text : undefined
}

/** Map one persisted message event to its history-chunk notification. */
function historyChunk(
  event: SessionEvent,
): { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk'; content: { type: 'text'; text: string } } | undefined {
  if (event.type === 'user/message') {
    const text = messageText(event.data)
    return text === undefined ? undefined : { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }
  }
  if (event.type === 'assistant/message') {
    const text = messageText(event.data.message)
    return text === undefined ? undefined : { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
  }
  return undefined
}

/** Reject session features outside the automation contract. */
function validateSessionParams(params: SessionWorkspaceParams): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
}
