/**
 * One team-member connection: the member's own process speaking ACP on the
 * client side, under an explicit lifecycle. A member is `offline` until
 * `start()` spawns its process and completes the `initialize` handshake
 * (then `idle`); a prompt turn in flight makes it `running`, and the last
 * turn's settlement returns it to `idle`; `stop()` tears the process down
 * (`offline`); an unexpected process death or transport loss is `offline`;
 * a failed spawn or handshake is `failed`. Connecting is an internal-only
 * phase: while a start is in flight the member keeps reporting its previous
 * public status. Every migration emits a status event — nothing polls. The
 * member owns its sessions and their history; this connection only spawns the
 * process, lists/loads/creates sessions through the protocol, drives prompt
 * turns, forwards every `session/update` losslessly, and routes
 * `session/request_permission` to subscribers or the deployment policy.
 *
 * @module @deepseek-ai/dsh-team/member
 */

import { randomUUID } from 'node:crypto'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentCapabilities,
  type ProviderInfo,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { DSH_ENV_PREFIX, type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpUpdateTranslator, type TranslatedSessionEvent } from './fidelity-reverse.ts'
import type { MemberCache } from './cache.ts'
import { resolveMemberSpec } from './resolve.ts'
import type {
  ChatResult,
  MemberConfig,
  MemberProviderConfigInput,
  MemberProviderInfo,
  MemberHistoryEntry,
  MemberPromptBlock,
  MemberSession,
  MemberSnapshot,
  MemberStatus,
  SessionConfigOptionInfo,
  SessionConfigSnapshot,
  SessionConfigValueInfo,
  TeamPermissionOutcome,
  TeamPermissionRequest,
  TeamUserQuestionAnswer,
  TeamUserQuestionRequest,
} from './types.ts'

/** Event hooks the owning service wires to the Cordis context. */
export interface MemberHooks {
  /** One status migration (deduplicated per transition). */
  onStatus: (status: MemberStatus, error?: string) => void
  /** One lossless `session/update` notification. */
  onUpdate: (sessionId: string, update: SessionUpdate) => void
  /** Route one permission request; the returned promise is answered externally or by policy. */
  onPermission: (request: TeamPermissionRequest) => Promise<TeamPermissionOutcome>
  /**
   * Route one member question batch; the returned promise is answered
   * externally (through `answerUserQuestion`) or inline by a subscriber.
   */
  onUserQuestion: (request: TeamUserQuestionRequest) => Promise<TeamUserQuestionAnswer>
  /**
   * One settled prompt turn. A failed turn (the member answered the prompt
   * with a protocol error) carries `error`; in that case `stopReason` is a
   * meaningless placeholder and consumers must branch on `error` first.
   */
  onTurnEnd: (sessionId: string, promptId: string, stopReason: StopReason, error?: string) => void
}

/** One in-flight prompt turn, keyed by session id (one turn per session). */
interface InflightTurn {
  readonly promptId: string
  /** Resolves with the member's stop reason when the turn settles. */
  readonly settled: Promise<StopReason>
  readonly settle: (reason: StopReason) => void
  readonly fail: (error: Error) => void
}

/** One unanswered permission request awaiting an external answer. */
interface PendingPermission {
  readonly sessionId: string
  readonly resolve: (outcome: TeamPermissionOutcome) => void
}

/** One unanswered member question batch awaiting an external answer. */
interface PendingUserQuestion {
  readonly resolve: (answer: TeamUserQuestionAnswer) => void
}

/**
 * The member process's environment: the full parent environment minus the
 * harness-managed `DSH_*` namespace (keyed case-insensitively, matching the
 * subprocess seam's scrub), with `config.env` layered over it, then any
 * explicit per-member entries such as the `DSH_HOME` entry
 * for `kind: 'dsh'` members. The DSH_* strip applies only to blind inheritance;
 * explicit entries are added last so they always win.
 * @param overlay - the member's configured `env` increments.
 * @param explicit - additional env entries merged after `overlay`.
 * @returns the complete child environment.
 */
function inheritedMemberEnv(
  overlay: Record<string, string> | undefined,
  explicit: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) env[key] = value
  }
  return { ...env, ...overlay, ...explicit }
}

/** Derive the legacy text-only history entries from translated session events. */
function textEntriesFromEvents(events: readonly TranslatedSessionEvent[]): MemberHistoryEntry[] {
  const entries: MemberHistoryEntry[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = event.data.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text.length > 0) entries.push({ role: 'user', text })
    } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      const last = entries[entries.length - 1]
      if (last?.role === 'assistant') {
        entries[entries.length - 1] = { role: 'assistant', text: last.text + event.data.chunk.text }
      } else {
        entries.push({ role: 'assistant', text: event.data.chunk.text })
      }
    }
  }
  return entries
}

/** Cooperative process teardown: EOF window, then termination escalation. */
async function disposeMemberProcess(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  child.stdin?.end()
  const deadline = Date.now() + eofGraceMs
  const exitPromise = child.waitForExit()
  const withinGrace = await Promise.race([
    exitPromise.then(() => true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => { resolve(false) }, Math.max(0, deadline - Date.now()))),
  ])
  if (!withinGrace) {
    child.terminate()
    await exitPromise
  }
}

/**
 * Group discriminant: a grouped session-config option entry carries `options`;
 * a flat one carries `value`/`name` directly.
 */
function isSelectGroup(
  entry: SessionConfigSelectOption | SessionConfigSelectGroup,
): entry is SessionConfigSelectGroup {
  return 'options' in entry
}

/**
 * Flatten an agent-provided option list — flat (`SessionConfigSelectOption[]`)
 * or grouped (`SessionConfigSelectGroup[]`) — into selectable values.
 */
function flattenSelectOptions(raw: SessionConfigSelectOptions): SessionConfigValueInfo[] {
  const values: SessionConfigValueInfo[] = []
  for (const entry of raw) {
    if (isSelectGroup(entry)) {
      for (const option of entry.options) {
        values.push({ value: option.value, name: option.name, description: option.description ?? undefined })
      }
    } else {
      values.push({ value: entry.value, name: entry.name, description: entry.description ?? undefined })
    }
  }
  return values
}

/**
 * Project one ACP `SessionConfigOption` to the harness-facing shape. The
 * harness never exposes the raw wire object — callers read `options`,
 * `currentValue`, and `category` only.
 */
function optionToInfo(option: SessionConfigOption): SessionConfigOptionInfo {
  return {
    id: option.id,
    name: option.name,
    category: option.category ?? undefined,
    type: option.type,
    currentValue: option.currentValue,
    options: option.type === 'select' ? flattenSelectOptions(option.options) : [],
  }
}

/**
 * The current model selection: the option whose UX hint is `"model"` (or whose
 * id is `"model"`), when it is a select. Returns `undefined` when the member
 * advertises no model option, so callers treat absence as "not supported".
 */
function currentModel(
  options: readonly SessionConfigOptionInfo[],
): { currentValue: string; options: readonly SessionConfigValueInfo[] } | undefined {
  const option = options.find(candidate => candidate.category === 'model' || candidate.id === 'model')
  if (option === undefined || option.type !== 'select') return undefined
  // A select option's current value is a value id (string); the union carries
  // `boolean` only for non-select options, already excluded above.
  return { currentValue: option.currentValue as string, options: option.options }
}

/**
 * Resolve the full session configuration set to a snapshot.
 * @param options - the session configuration option set.
 * @returns the resolved option infos plus the model selector, whose `model` is
 *   `undefined` when the option set carries no model choice.
 */
export function sessionConfigToSnapshot(options: readonly SessionConfigOption[]): SessionConfigSnapshot {
  const resolved = options.map(optionToInfo)
  return { options: resolved, model: currentModel(resolved) }
}

/**
 * Project one ACP `ProviderInfo` to the harness-facing shape. `current` is
 * dropped when the provider is disabled (null/omitted), so callers see only
 * enabled routing.
 */
function providerToInfo(provider: ProviderInfo): MemberProviderInfo {
  return {
    id: provider.id,
    required: provider.required,
    supported: provider.supported,
    current: provider.current === null || provider.current === undefined
      ? undefined
      : { apiType: provider.current.apiType, baseUrl: provider.current.baseUrl },
  }
}

/**
 * One member process plus its live ACP connection, keyed by member id. The
 * lifecycle is explicit: `start` / `stop` / `restart` are the only ways the
 * process comes and goes; session operations on a non-running member fail
 * loud instead of lazily spawning.
 */
export class MemberConnection {
  /** The current public status of this member (`idle` / `running` / `offline` / `failed`). */
  status: MemberStatus = 'offline'
  /** The capabilities the member advertised in `initialize`, when connected. */
  capabilities: AgentCapabilities | undefined
  /** The last connection failure's message, for views. */
  lastError: string | undefined

  /** The member's working directory: config value, or the harness launch directory. */
  readonly cwd: string

  private child: SubprocessHandle | undefined
  private conn: ClientSideConnection | undefined
  private startPromise: Promise<void> | undefined
  /**
   * The generation owning the in-flight spawn/handshake, or 0 when no start
   * is in flight. Internal-only: connecting never surfaces as a status. A
   * stale connect clears the flag only when it still owns it, so a newer
   * start's flag survives an older connect's exit.
   */
  private connectInFlight = 0
  /** Bumped by every stop; async connect steps bail when their generation is stale. */
  private generation = 0
  private turnCounter = 0
  private readonly inflight = new Map<string, InflightTurn>()
  /** Text collectors for blocking `chat` turns, keyed by session id. */
  private readonly chatSinks = new Map<string, (text: string) => void>()
  /** Per-session translators folding replayed ACP updates into harness events. */
  private readonly historyTranslators = new Map<string, AcpUpdateTranslator>()
  /** Accumulated translated events for an active `readHistory`/`readHistoryEvents` replay. */
  private readonly historyEvents = new Map<string, TranslatedSessionEvent[]>()
  /** Permission requests awaiting an external answer, keyed by request id. */
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly pendingUserQuestions = new Map<string, PendingUserQuestion>()
  /**
   * Cached raw session configuration per session, captured from
   * `config_option_update` notifications and the `newSession`/`loadSession`
   * responses. The snapshot is derived on read, not stored.
   */
  private readonly configBySession = new Map<string, readonly SessionConfigOption[]>()
  /** The last model id seen, for the member snapshot convenience. */
  private model: string | undefined
  private teardownPromise: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: MemberConfig,
    private readonly hooks: MemberHooks,
    private readonly cache: MemberCache,
  ) {
    // cwd is resolved once, when the member enters the roster: config value
    // or the harness launch directory. No caller session workspace is bound.
    this.cwd = config.cwd ?? process.cwd()
  }

  /**
   * The member's configured identity and live facts.
   * @returns a read-only snapshot of the member's current state.
   */
  snapshot(): MemberSnapshot {
    return {
      id: this.config.id,
      title: this.config.title ?? this.config.id,
      description: this.config.description,
      kind: this.config.kind,
      status: this.status,
      capabilities: this.capabilities,
      autostart: this.config.autostart ?? true,
      lastError: this.lastError,
      model: this.model,
    }
  }

  /**
   * Start the member process and complete the ACP handshake. Idempotent:
   * an already-connected member or an in-flight start settles with the
   * in-flight start.
   */
  start(): Promise<void> {
    if (this.conn !== undefined || this.connectInFlight !== 0) return this.startPromise ?? Promise.resolve()
    // A new lifecycle gets a fresh teardown; the previous one already settled.
    this.teardownPromise = undefined
    this.startPromise = this.connect()
    return this.startPromise
  }

  /**
   * Tear the member process down and return to `offline`. Idempotent;
   * cancels an in-flight start.
   */
  async stop(): Promise<void> {
    if (this.status === 'offline' && this.connectInFlight === 0) return
    this.generation += 1
    this.lastError = undefined
    await this.teardown()
    this.setStatus('offline')
  }

  /** Stop, then start again. */
  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /**
   * List the member's own conversation topics for its workspace. Members keep
   * topics from every workspace they ever served (Grok CLI returns its whole
   * global store), and a topic only loads under the workspace it belongs to,
   * so the listing defaults to the member's configured cwd.
   * @param cwd - workspace filter passed to the member; defaults to the member's configured cwd.
   * @returns the member's topic list for that workspace.
   */
  async listSessions(cwd?: string): Promise<MemberSession[]> {
    if (!this.isRunning()) {
      const cached = this.cache.getSessions()
      if (cached === undefined) {
        throw new Error(
          `team: member "${this.config.id}" is not running and has no cached sessions`,
        )
      }
      return cached
    }
    const conn = this.requireRunning()
    const response = await conn.listSessions({ cwd: cwd ?? this.cwd })
    const sessions: MemberSession[] = response.sessions.map(session => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...session.title === undefined || session.title === null ? {} : { title: session.title },
      ...session.updatedAt === undefined || session.updatedAt === null ? {} : { updatedAt: session.updatedAt },
    }))
    await this.cache.setSessions(sessions)
    return sessions
  }

  /**
   * Resume one of the member's topics so chat continues its history.
   * @param sessionId - the topic to load.
   */
  async loadSession(sessionId: string): Promise<void> {
    const conn = this.requireRunning()
    const session = await conn.loadSession({ sessionId, cwd: this.cwd, mcpServers: [] })
    this.storeConfig(sessionId, session.configOptions)
  }

  /**
   * Load one of the member's topics and collect its replayed conversation
   * history (the member's own record of the topic). The replayed chunks are
   * consumed here and not re-forwarded as member-update events.
   * @param sessionId - the member's session (topic) id.
   * @returns the topic's messages in replay order.
   */
  async readHistory(sessionId: string): Promise<MemberHistoryEntry[]> {
    const events = await this.collectHistoryEvents(sessionId)
    return textEntriesFromEvents(events)
  }

  /**
   * Load one of the member's topics and return the full-fidelity translated
   * harness event sequence. This is the foundation for rendering a member
   * session in the main conversation UI: every replayed ACP update is folded
   * through the same translator used for live turns.
   * @param sessionId - the member's session (topic) id.
   * @returns the translated session events in replay order.
   */
  async readHistoryEvents(sessionId: string): Promise<TranslatedSessionEvent[]> {
    if (!this.isRunning()) return this.translateCachedTopic(sessionId)
    return this.collectHistoryEvents(sessionId)
  }

  /**
   * Fold a cached topic's updates through {@link AcpUpdateTranslator}.
   * @param sessionId - the member's session (topic) id.
   * @returns the translated session events from the durable cache.
   */
  private translateCachedTopic(sessionId: string): TranslatedSessionEvent[] {
    const cached = this.cache.getTopic(sessionId)
    if (cached === undefined || cached.updates.length === 0) {
      throw new Error(
        `team: member "${this.config.id}" is offline and topic "${sessionId}" has no cached history`,
      )
    }
    const translator = new AcpUpdateTranslator()
    const events: TranslatedSessionEvent[] = []
    for (const update of cached.updates) {
      events.push(...translator.update(update as SessionUpdate))
    }
    events.push(...translator.finish())
    return events
  }

  /**
   * Whether this member currently has a prompt turn in flight for the topic.
   * The host bridge uses this for session-summary `running` flags.
   * @param sessionId - the member's session (topic) id.
   * @returns true when a turn is in flight.
   */
  isTurnInFlight(sessionId: string): boolean {
    return this.inflight.has(sessionId)
  }

  /**
   * Fold one topic's replayed ACP stream through {@link AcpUpdateTranslator}
   * and return the translated events.
   * @param sessionId - the member's session (topic) id.
   * @returns the translated session events, with the translator's tail flush.
   */
  private async collectHistoryEvents(sessionId: string): Promise<TranslatedSessionEvent[]> {
    const conn = this.requireRunning()
    const events: TranslatedSessionEvent[] = []
    const translator = new AcpUpdateTranslator()
    this.historyEvents.set(sessionId, events)
    this.historyTranslators.set(sessionId, translator)
    this.cache.startReplay(sessionId)
    try {
      await conn.loadSession({ sessionId, cwd: this.cwd, mcpServers: [] })
      events.push(...translator.finish())
      return events
    } finally {
      this.historyEvents.delete(sessionId)
      this.historyTranslators.delete(sessionId)
      await this.cache.finishReplay(sessionId)
    }
  }

  /**
   * Open a new topic on the member.
   * @returns the new topic id.
   */
  async newSession(): Promise<string> {
    const conn = this.requireRunning()
    const session = await conn.newSession({ cwd: this.cwd, mcpServers: [] })
    this.storeConfig(session.sessionId, session.configOptions)
    return session.sessionId
  }

  /**
   * Cache one session's raw configuration options. Empty or absent sets are a
   * no-op: the member simply has not advertised config options yet.
   * @param sessionId - the member's session (topic) id.
   * @param configOptions - the raw ACP options, or `null`/`undefined`.
   */
  private storeConfig(
    sessionId: string,
    configOptions: readonly SessionConfigOption[] | null | undefined,
  ): void {
    if (configOptions === null || configOptions === undefined || configOptions.length === 0) return
    this.configBySession.set(sessionId, configOptions)
    const model = currentModel(configOptions.map(optionToInfo))
    if (model !== undefined) this.model = model.currentValue
  }

  /**
   * The resolved session configuration set plus the model shortcut, derived
   * from the cached options. Throws when the member has no cached options —
   * create or load the session first.
   * @param sessionId - the member's session (topic) id.
   * @returns the snapshot of options and the current model, if any.
   */
  getConfig(sessionId: string): SessionConfigSnapshot {
    const options = this.configBySession.get(sessionId)
    if (options === undefined) {
      throw new Error(
        `team: member "${this.config.id}" has no session config for session "${sessionId}" — create or load it first`,
      )
    }
    return sessionConfigToSnapshot(options)
  }

  /**
   * Set one session configuration option and return the updated snapshot.
   * The value is validated by the agent; a rejected value throws.
   * @param sessionId - the member's session (topic) id.
   * @param configId - the option id, e.g. `"model"`.
   * @param value - the new value id.
   * @returns the updated snapshot.
   */
  async setSessionConfig(sessionId: string, configId: string, value: string): Promise<SessionConfigSnapshot> {
    const conn = this.requireRunning()
    const response = await conn.setSessionConfigOption({ configId, sessionId, value })
    this.storeConfig(sessionId, response.configOptions)
    return sessionConfigToSnapshot(response.configOptions)
  }

  /**
   * The providers the member advertises, gated on the `providers` capability.
   * @returns the provider list.
   * @throws when the member did not advertise `providers` in `initialize`.
   */
  async listProviders(): Promise<MemberProviderInfo[]> {
    const conn = this.requireRunning()
    if (this.capabilities?.providers === undefined || this.capabilities.providers === null) {
      throw new Error(`team: member "${this.config.id}" does not support provider configuration`)
    }
    const response = await conn.unstable_listProviders({})
    return response.providers.map(providerToInfo)
  }

  /**
   * Configure one provider (member-scoped). The agent stores the routing
   * config on its own side; the harness never persists secrets.
   * @param config - the provider id, protocol, base URL, and optional headers.
   * @throws when the member did not advertise `providers` in `initialize`.
   */
  async setProvider(config: MemberProviderConfigInput): Promise<void> {
    const conn = this.requireRunning()
    if (this.capabilities?.providers === undefined || this.capabilities.providers === null) {
      throw new Error(`team: member "${this.config.id}" does not support provider configuration`)
    }
    // `exactOptionalPropertyTypes` forbids passing `undefined` for an optional
    // field, so only attach `headers` when the caller supplied them.
    const request: { id: string; apiType: string; baseUrl: string; headers?: Record<string, string> } = {
      id: config.id,
      apiType: config.apiType,
      baseUrl: config.baseUrl,
    }
    if (config.headers !== undefined) request.headers = config.headers
    await conn.unstable_setProvider(request)
  }

  /**
   * Accept one text prompt turn and return immediately; chunks stream as
   * `team/member-update` events and settlement as `team/turn-end`. One turn per session at a time.
   * @param sessionId - the member topic to prompt in.
   * @param text - the user-role message.
   * @returns the locally minted prompt id, for turn-end correlation.
   */
  prompt(sessionId: string, text: string): Promise<{ promptId: string }> {
    return this.promptContent(sessionId, [{ type: 'text', text }])
  }

  /**
   * Accept one prompt turn carrying text and image blocks (ACP wire form) and
   * return immediately; chunks stream as `team/member-update` events and
   * settlement as `team/turn-end`. One turn per session at a time. The agent
   * validates the blocks on its own side — an unsupported image is a protocol
   * error that fails the turn, not a silent drop.
   * @param sessionId - the member topic to prompt in.
   * @param content - the user-role blocks in order; at least one non-blank text or one image.
   * @returns the prompt id assigned to this turn.
   */
  promptContent(sessionId: string, content: readonly MemberPromptBlock[]): Promise<{ promptId: string }> {
    const conn = this.requireRunning()
    if (this.inflight.has(sessionId)) {
      return Promise.reject(new Error(`team: a prompt is already in flight for session "${sessionId}"`))
    }
    const hasText = content.some(block => block.type === 'text' && block.text.trim().length > 0)
    if (!hasText && !content.some(block => block.type === 'image')) {
      return Promise.reject(new Error('team: empty prompt'))
    }
    const promptId = `team-${this.config.id}-${++this.turnCounter}`
    let settle!: (reason: StopReason) => void
    let fail!: (error: Error) => void
    const settled = new Promise<StopReason>((resolve, reject) => { settle = resolve; fail = reject })
    // Settlement has two consumers on independent branches: `chat()` awaits
    // this promise, while streaming consumers learn the outcome through
    // `team/turn-end`. A failed turn with no chat() waiter must not float an
    // unhandled rejection (the host process fail-louds on those).
    void settled.catch(() => undefined)
    this.inflight.set(sessionId, { promptId, settled, settle, fail })
    // A turn in flight is the public `running` status (chat turns included —
    // chat drives its turn through this method).
    this.setStatus('running')
    void conn.prompt({ sessionId, prompt: [...content] })
      .then((response) => { this.settleTurn(sessionId, response.stopReason) })
      .catch((error: unknown) => {
        if (error instanceof RequestError) {
          // The member answered with a protocol error (the prompt was never
          // accepted): the turn failed, not ended.
          this.failTurn(sessionId, error)
        } else {
          // Transport loss mid-turn (the member died): the turn is over.
          this.settleTurn(sessionId, 'cancelled')
        }
      })
    return Promise.resolve({ promptId })
  }

  /**
   * Drive one chat turn to completion, collecting the committed assistant
   * text. Cancellation sends a remote cancel and settles early with the
   * partial text; the underlying turn keeps settling in the background (the
   * slot is not released until the member answers or the connection dies).
   * @param sessionId - the member's session (topic) id.
   * @param text - the user-role message.
   * @param signal - cancellation: sends a remote cancel and settles early.
   * @returns the committed text and the ACP stop reason.
   */
  async chat(sessionId: string, text: string, signal?: AbortSignal): Promise<ChatResult> {
    const chunks: string[] = []
    this.chatSinks.set(sessionId, chunk => chunks.push(chunk))
    try {
      const { promptId } = await this.prompt(sessionId, text)
      const turn = this.inflight.get(sessionId)
      if (turn === undefined || turn.promptId !== promptId) {
        throw new Error('team: prompt settled before it was awaited')
      }
      const onAbort = (): void => {
        void this.conn?.cancel({ sessionId }).catch(() => { /* member gone */ })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const stopReason = await Promise.race([
          turn.settled,
          new Promise<StopReason>((resolve) => {
            if (signal?.aborted) { resolve('cancelled'); return }
            signal?.addEventListener('abort', () => { resolve('cancelled') }, { once: true })
          }),
        ])
        return { text: chunks.join(''), stopReason }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    } finally {
      this.chatSinks.delete(sessionId)
    }
  }

  /**
   * Send `session/cancel` for one session. Also resolves that session's
   * unanswered permission requests as cancelled (the ACP-mandated behavior
   * when a client cancels a prompt turn). No-op when the member is not
   * running (its loss handler already settled everything).
   * @param sessionId - the member topic whose turn is cancelled.
   */
  async cancel(sessionId: string): Promise<void> {
    const conn = this.conn
    if (conn === undefined) return
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (pending.sessionId !== sessionId) continue
      this.pendingPermissions.delete(requestId)
      pending.resolve({ outcome: 'cancelled' })
    }
    await conn.cancel({ sessionId })
  }

  /**
   * Answer one unanswered permission request of this member.
   * @param requestId - the locally minted request id from the request event.
   * @param outcome - the chosen option, or cancelled.
   * @returns `false` when no request with that id is pending (already answered).
   */
  answerPermission(requestId: string, outcome: TeamPermissionOutcome): boolean {
    const pending = this.pendingPermissions.get(requestId)
    if (pending === undefined) return false
    this.pendingPermissions.delete(requestId)
    pending.resolve(outcome)
    return true
  }

  /**
   * Answer one unanswered question batch of this member.
   * @param requestId - the locally minted request id from the request event.
   * @param answers - the structured answers keyed by question id.
   * @returns `false` when no batch with that id is pending (already answered).
   */
  answerUserQuestion(requestId: string, answers: TeamUserQuestionAnswer): boolean {
    const pending = this.pendingUserQuestions.get(requestId)
    if (pending === undefined) return false
    this.pendingUserQuestions.delete(requestId)
    pending.resolve(answers)
    return true
  }

  /**
   * Establish the member process and connection. Any failure tears the
   * process down and leaves the member `failed`; a stop racing the connect
   * wins (its teardown owns the process).
   */
  private async connect(): Promise<void> {
    const generation = ++this.generation
    this.lastError = undefined
    // Connecting is internal-only: the snapshot keeps reporting the previous
    // public status until the handshake completes.
    this.connectInFlight = generation
    try {
      const child = this.ctx.subprocess.spawn(this.spawnSpec())
      if (child.stdin === undefined || child.stdout === undefined) {
        throw new Error('team: subprocess implementation dropped a piped protocol stream')
      }
      const spawnFailed: Promise<never> = child.done.then(
        () => new Promise<never>(() => {}),
        (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
      )
      spawnFailed.catch(() => { /* raced below; never unhandled */ })

      const conn = new ClientSideConnection(
        () => this.makeClient(),
        ndJsonStream(
          NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      )
      await Promise.race([
        (async (): Promise<void> => {
          const response = await conn.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            // Ask peers that understand it (dsh-acp) for the full-fidelity
            // session/update stream; agents that ignore `_meta` are unaffected.
            _meta: { fullFidelity: true },
          })
          this.capabilities = response.agentCapabilities
        })(),
        spawnFailed,
      ])
      if (generation !== this.generation) {
        // A stop raced the connect; its teardown owns this process.
        void conn.closed.catch(() => {})
        await disposeMemberProcess(child, 2_000)
        return
      }
      this.child = child
      this.conn = conn
      // A transport death (process exit or protocol failure) marks the member
      // offline and settles everything in flight.
      const onLoss = (): void => { void this.handleConnectionLoss() }
      void conn.closed.catch(() => {}).then(onLoss)
      void child.done.then(onLoss, onLoss)
      // Connected with no turn in flight: the public `idle` status.
      this.setStatus('idle')
    } catch (error: unknown) {
      if (generation !== this.generation) return
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus('failed', message)
      await this.teardown()
      throw error
    } finally {
      if (this.connectInFlight === generation) this.connectInFlight = 0
    }
  }

  /** The client handler: lossless update forwarding, permission routing, question routing. */
  private makeClient() {
    return {
      sessionUpdate: (notification: SessionNotification): Promise<void> => {
        this.receiveUpdate(notification)
        return Promise.resolve()
      },
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> =>
        this.receivePermission(params),
      extMethod: (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        if (method !== 'dsh/user/question') {
          return Promise.reject(new Error(`unsupported client extension: ${method}`))
        }
        return this.receiveUserQuestion(params)
      },
    }
  }

  private receiveUpdate(notification: SessionNotification): void {
    const { sessionId, update } = notification
    // Session config options arrive both as a `config_option_update`
    // notification and in the `newSession`/`loadSession` responses. Cache the
    // raw set so `getConfig` can derive a snapshot on demand.
    if (update.sessionUpdate === 'config_option_update') {
      this.storeConfig(sessionId, update.configOptions)
    }
    const translator = this.historyTranslators.get(sessionId)
    if (translator !== undefined) {
      // Replay collection: fold every update through the full-fidelity
      // translator; the collected events are the result of readHistory/
      // readHistoryEvents, so nothing is re-forwarded as a member-update event.
      this.historyEvents.get(sessionId)?.push(...translator.update(update))
      // The replay is authoritative: it already replaced the topic's cache
      // in startReplay, so append each replay update to the clean slate.
      void this.cache.appendUpdate(sessionId, update)
      return
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.chatSinks.get(sessionId)?.(update.content.text)
    }
    // Cache live updates for offline history and list rendering.
    void this.cache.appendUpdate(sessionId, update)
    this.hooks.onUpdate(sessionId, update)
  }

  private receivePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const request: TeamPermissionRequest = {
      requestId: randomUUID(),
      memberId: this.config.id,
      sessionId: params.sessionId,
      toolCall: params.toolCall,
      options: params.options,
    }
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(request.requestId, {
        sessionId: params.sessionId,
        resolve: (outcome) => { resolve({ outcome }) },
      })
      void this.hooks.onPermission(request)
        .then((outcome) => { this.answerPermission(request.requestId, outcome) })
        .catch((error: unknown) => {
          // A throwing subscriber must not wedge the member's turn: fall back
          // to the safest outcome.
          this.ctx.logger.warn(`team: permission subscriber failed for member "${this.config.id}": ${String(error)}`)
          this.answerPermission(request.requestId, { outcome: 'cancelled' })
        })
    })
  }

  /**
   * Receive one `dsh/user/question` batch from the member process and surface
   * it to the host plane. The wire response resolves with the structured
   * answers; a subscriber failure declines with an empty answer set so the
   * member's ask fails soft instead of wedging its turn.
   */
  private receiveUserQuestion(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const questions = params['questions']
    if (!Array.isArray(questions)) {
      return Promise.reject(new Error('dsh/user/question requires a questions array'))
    }
    const request: TeamUserQuestionRequest = {
      requestId: randomUUID(),
      memberId: this.config.id,
      questions: questions as TeamUserQuestionRequest['questions'],
    }
    return new Promise<Record<string, unknown>>((resolve) => {
      this.pendingUserQuestions.set(request.requestId, {
        resolve: (answer) => { resolve({ answers: answer.answers }) },
      })
      void this.hooks.onUserQuestion(request)
        .then((answer) => { this.answerUserQuestion(request.requestId, answer) })
        .catch((error: unknown) => {
          this.ctx.logger.warn(`team: question subscriber failed for member "${this.config.id}": ${String(error)}`)
          this.answerUserQuestion(request.requestId, { answers: [] })
        })
    })
  }

  private settleTurn(sessionId: string, reason: StopReason): void {
    const turn = this.inflight.get(sessionId)
    if (turn === undefined) return
    this.inflight.delete(sessionId)
    this.settleTurnStatus()
    turn.settle(reason)
    this.hooks.onTurnEnd(sessionId, turn.promptId, reason)
  }

  private failTurn(sessionId: string, error: Error): void {
    const turn = this.inflight.get(sessionId)
    if (turn === undefined) return
    this.inflight.delete(sessionId)
    this.settleTurnStatus()
    turn.fail(error)
    // A failed turn still ends: streaming consumers close the turn chrome and
    // surface the failure. The stopReason placeholder is meaningless here.
    this.hooks.onTurnEnd(sessionId, turn.promptId, 'cancelled', error.message)
  }

  /** The last in-flight turn settled: back to `idle` while the process stays connected. */
  private settleTurnStatus(): void {
    if (this.inflight.size === 0 && this.conn !== undefined) this.setStatus('idle')
  }

  /** An unexpected process death or transport loss: settle everything, mark offline. */
  private async handleConnectionLoss(): Promise<void> {
    if (this.conn === undefined && this.child === undefined) return
    const child = this.child
    this.child = undefined
    this.conn = undefined
    this.capabilities = undefined
    for (const [sessionId, turn] of [...this.inflight]) {
      this.inflight.delete(sessionId)
      turn.settle('cancelled')
      this.hooks.onTurnEnd(sessionId, turn.promptId, 'cancelled')
    }
    for (const [, pending] of [...this.pendingPermissions]) {
      pending.resolve({ outcome: 'cancelled' })
    }
    this.pendingPermissions.clear()
    this.chatSinks.clear()
    this.historyTranslators.clear()
    this.historyEvents.clear()
    // The child usually already exited; the disposal ladder still reaps it
    // (bounded EOF window, then termination) so no orphan survives.
    if (child !== undefined) await disposeMemberProcess(child, 2_000)
    this.setStatus('offline')
  }

  private spawnSpec(): SubprocessSpawnSpec {
    const spec = resolveMemberSpec(this.config)
    return {
      argv: [spec.command, ...spec.args],
      cwd: this.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      // Members are trusted peers: the child inherits the FULL parent
      // environment (credentials included) with config.env layered over it —
      // the subprocess seam's scrub applies to every other spawner, and this
      // explicit opt-in is the documented way to forward a credential. The
      // one exclusion is the harness's own DSH_* namespace: those keys
      // configure THIS harness instance and must never leak into a member.
      // For `kind: 'dsh'` members, DSH_HOME is an explicit per-member entry
      // merged after config.env, so the member gets its own self-contained
      // home; it reads only that home (seeded once at creation by
      // `member-home.ts`), never the main instance's settings/credentials.
      env: inheritedMemberEnv(this.config.env, spec.env),
      graceMs: 3_000,
    }
  }

  private isRunning(): boolean {
    return this.conn !== undefined
  }

  private requireRunning(): ClientSideConnection {
    if (this.conn === undefined) {
      throw new Error(
        `team: member "${this.config.id}" is not running (status: ${this.status}) — start it first`,
      )
    }
    return this.conn
  }

  private setStatus(status: MemberStatus, error?: string): void {
    if (this.status === status && this.lastError === error) return
    this.status = status
    this.lastError = error
    this.hooks.onStatus(status, error)
  }

  /** Tear down the process and connection, settling everything in flight. Idempotent. */
  private async teardown(): Promise<void> {
    this.teardownPromise ??= (async () => {
      const child = this.child
      this.child = undefined
      this.conn = undefined
      this.capabilities = undefined
      for (const [sessionId, turn] of [...this.inflight]) {
        this.inflight.delete(sessionId)
        turn.settle('cancelled')
        this.hooks.onTurnEnd(sessionId, turn.promptId, 'cancelled')
      }
      for (const [, pending] of [...this.pendingPermissions]) {
        pending.resolve({ outcome: 'cancelled' })
      }
      this.pendingPermissions.clear()
      this.chatSinks.clear()
      this.historyTranslators.clear()
      this.historyEvents.clear()
      if (child !== undefined) {
        await disposeMemberProcess(child, 2_000)
      }
    })()
    return this.teardownPromise
  }
}
