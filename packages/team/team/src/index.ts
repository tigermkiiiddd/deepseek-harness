/**
 * Team-member connections: the `team` service is the ACP client seam that
 * connects the harness to independent agent processes. Each member is one
 * persistent ACP process the harness spawns, handshakes, and drives under an
 * explicit lifecycle (start / stop / restart / autostart); the member owns
 * its sessions and their history. The harness never mirrors member sessions —
 * listing, loading, and creating topics all go through the Agent Client
 * Protocol. The roster (who is in the team and how to spawn them) is the only
 * team state the harness persists: runtime-added members land in a durable
 * roster and are re-spawned after a restart; config members stay
 * deployment-authoritative.
 *
 * @module @deepseek-ai/dsh-team
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { MemberConnection, type MemberHooks } from './member.ts'
import { teamRosterDomainSpec, type TeamRosterRecord } from './spec.ts'
import { MemberCache, type MemberCacheRecord } from './cache.ts'
import { seedMemberHome } from './member-home.ts'
import { resolveMemberSpec } from './resolve.ts'
export { AcpUpdateTranslator, stopReasonToTurnEnd, type TranslatedEventType, type TranslatedSessionEvent } from './fidelity-reverse.ts'
export { resolveMemberSpec } from './resolve.ts'
export type { ResolvedMemberSpawnSpec } from './types.ts'
import { type TranslatedSessionEvent } from './fidelity-reverse.ts'
import type {
  ChatResult,
  MemberConfig,
  MemberConfigInput,
  MemberHistoryEntry,
  MemberPromptBlock,
  MemberProviderConfigInput,
  MemberProviderInfo,
  MemberSession,
  MemberSnapshot,
  SessionConfigSnapshot,
  TeamPermissionHandler,
  TeamPermissionOutcome,
} from './types.ts'

export const name = 'team'
export const inject = ['subprocess']

/** Plugin config: the deployment's team roster. */
export interface Config {
  /** The team members, one persistent process each. */
  readonly members: MemberConfig[]
}

export const Config: z<Config> = z.object({
  members: z.array(z.object({
    id: z.string().required(),
    title: z.string(),
    description: z.string(),
    kind: z.union(['dsh'] as const),
    command: z.string(),
    args: z.array(z.string()).default([]),
    cwd: z.string(),
    env: z.dict(z.string()).default({}),
    permission: z.union(['allow', 'reject'] as const),
    autostart: z.boolean().default(true),
    preset: z.string(),
  })).required(),
})

/** The team service the plugin provides under `ctx.team`. */
export interface TeamService {
  /**
   * Every member with its live connection status, capabilities, and last error.
   * @returns the list of member snapshots.
   */
  list(): MemberSnapshot[]
  /**
   * Start one member's process and complete the ACP handshake.
   * @param memberId - the member to start.
   */
  start(memberId: string): Promise<void>
  /**
   * Stop one member's process and return it to `offline`.
   * @param memberId - the member to stop.
   */
  stop(memberId: string): Promise<void>
  /**
   * Stop then start one member.
   * @param memberId - the member to restart.
   */
  restart(memberId: string): Promise<void>
  /**
   * One member's own conversation topics (persisted in the member process).
   * @param memberId - the member whose topics are listed.
   * @param cwd - workspace filter passed to the member; defaults to the member's configured cwd.
   * @returns the member's topic list for that workspace.
   */
  listSessions(memberId: string, cwd?: string): Promise<MemberSession[]>
  /**
   * Resume one of the member's topics so chat continues its history.
   * @param memberId - the member that owns the topic.
   * @param sessionId - the topic to load.
   */
  loadSession(memberId: string, sessionId: string): Promise<void>
  /**
   * Load one topic and collect its replayed conversation history.
   * @param memberId - the member that owns the topic.
   * @param sessionId - the topic whose history is replayed.
   * @returns the replayed conversation entries.
   */
  readHistory(memberId: string, sessionId: string): Promise<MemberHistoryEntry[]>
  /**
   * Load one topic and collect its full-fidelity translated session events.
   * @param memberId - the member that owns the topic.
   * @param sessionId - the topic whose history is replayed.
   * @returns the translated harness event sequence.
   */
  readHistoryEvents(memberId: string, sessionId: string): Promise<TranslatedSessionEvent[]>
  /**
   * Whether a member currently has a prompt turn in flight for a topic.
   * @param memberId - the member to query.
   * @param sessionId - the member topic to query.
   * @returns true when a turn is in flight.
   */
  isTurnInFlight(memberId: string, sessionId: string): boolean
  /**
   * Open a new topic on the member and return its id.
   * @param memberId - the member to create a topic on.
   * @returns the new topic id.
   */
  newSession(memberId: string): Promise<string>
  /**
   * The member's resolved session configuration set plus the model shortcut.
   * The snapshot is derived from options cached when the topic was created,
   * loaded, or updated — create or load the topic first.
   * @param memberId - the member that owns the topic.
   * @param sessionId - the topic whose config is read.
   * @returns the resolved options and the current model, if any.
   * @throws when the member has no cached options for the topic.
   */
  getConfig(memberId: string, sessionId: string): Promise<SessionConfigSnapshot>
  /**
   * Set one session configuration option (e.g. `"model"`) and return the
   * updated snapshot. The value is validated by the agent.
   * @param memberId - the member that owns the topic.
   * @param sessionId - the topic whose option is set.
   * @param configId - the option id, e.g. `"model"`.
   * @param value - the new value id.
   * @returns the updated snapshot.
   */
  setConfig(memberId: string, sessionId: string, configId: string, value: string): Promise<SessionConfigSnapshot>
  /**
   * The providers the member advertises, gated on the `providers` capability.
   * @param memberId - the member whose providers are listed.
   * @returns the provider list.
   * @throws when the member did not advertise `providers` in `initialize`.
   */
  listProviders(memberId: string): Promise<MemberProviderInfo[]>
  /**
   * Configure one provider (member-scoped). The agent stores the routing
   * config on its own side; the harness never persists secrets.
   * @param memberId - the member whose provider is configured.
   * @param config - the provider id, protocol, base URL, and optional headers.
   * @throws when the member did not advertise `providers` in `initialize`.
   */
  setProvider(memberId: string, config: MemberProviderConfigInput): Promise<void>
  /**
   * Accept one prompt turn and return immediately; chunks stream as
   * `team/member-update` events and settlement as `team/turn-end`.
   * @param memberId - the member to prompt.
   * @param sessionId - the member topic to prompt in.
   * @param text - the user text for this turn.
   * @returns the prompt id assigned to this turn.
   */
  prompt(memberId: string, sessionId: string, text: string): Promise<{ promptId: string }>
  /**
   * Accept one prompt turn carrying text and image blocks (ACP wire form).
   * The agent validates the blocks on its own side; an unsupported image is a
   * protocol error that fails the turn.
   * @param memberId - the member to prompt.
   * @param sessionId - the member topic to prompt in.
   * @param content - the user-role blocks in order; at least one non-blank text or one image.
   * @returns the prompt id assigned to this turn.
   */
  promptContent(memberId: string, sessionId: string, content: readonly MemberPromptBlock[]): Promise<{ promptId: string }>
  /**
   * Cancel the in-flight prompt turn of one session.
   * @param memberId - the member whose turn is in flight.
   * @param sessionId - the member topic whose turn is cancelled.
   */
  cancel(memberId: string, sessionId: string): Promise<void>
  /**
   * Answer one unanswered `session/request_permission` prompt.
   * @param memberId - the member that raised the request.
   * @param requestId - the locally minted request id.
   * @param outcome - the selected option or cancellation.
   */
  permission(memberId: string, requestId: string, outcome: TeamPermissionOutcome): Promise<void>
  /**
   * Drive one chat turn to completion (blocking convenience for model tools).
   * @param memberId - the member to chat with.
   * @param sessionId - the member topic to chat in.
   * @param text - the user text for this turn.
   * @param signal - optional cancellation signal.
   * @returns the member's committed reply and stop reason.
   */
  chat(memberId: string, sessionId: string, text: string, signal?: AbortSignal): Promise<ChatResult>
  /**
   * Spawn a new member process at runtime, persist it in the roster, and join it.
   * Omitted `args`/`env` default to empty at this funnel, so every caller —
   * host API, model tool, future seams — is safe.
   * @param config - the member configuration; collection fields optional.
   * @returns the snapshot of the newly added member.
   */
  addMember(config: MemberConfigInput): Promise<MemberSnapshot>
  /**
   * Stop one member, drop it from the roster, and attempt to delete it from
   * persistence. A failed delete is logged and the record may reappear on restart.
   * @param memberId - the member to remove.
   */
  removeMember(memberId: string): Promise<void>
  /**
   * Register a permission-request subscriber. While at least one subscriber
   * exists, `session/request_permission` prompts are surfaced (event +
   * `team.permission` answers); with none, the member's `permission` policy
   * auto-answers.
   * @param handler - the subscriber that receives each request.
   * @returns the disposer removing this handler.
   */
  onPermissionRequest(handler: TeamPermissionHandler): () => void
  /** Stop every member process. Idempotent. */
  disposeAll(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Team-member ACP client seam: spawn, drive, and persist member roster. */
    team: TeamService
  }
}

/** The optional storage-domain seam the roster persists through. */
interface StorageDomainFacility {
  open(spec: typeof teamRosterDomainSpec): Promise<Domain<typeof teamRosterDomainSpec>>
}

/**
 * Mount the team service.
 * @param ctx - Cordis context with the subprocess seam.
 * @param config - the member roster.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Validate the roster at load: duplicate ids and missing commands are
  // misconfigurations, not per-call surprises.
  const seen = new Set<string>()
  for (const member of config.members) {
    if (seen.has(member.id)) throw new Error(`team: duplicate member id "${member.id}"`)
    seen.add(member.id)
    assertMemberConfig(member)
  }

  const connections = new Map<string, MemberConnection>()
  /** Every joined member's full config; the load-time home seed needs fields the snapshot does not carry. */
  const memberConfigs = new Map<string, MemberConfig>()
  const policies = new Map<string, 'allow' | 'reject'>()
  const permissionHandlers = new Set<TeamPermissionHandler>()
  /** Externally answered permission requests, keyed by request id. */
  const pendingAnswers = new Map<string, { memberId: string; resolve: (outcome: TeamPermissionOutcome) => void }>()
  let rosterDomain: Domain<typeof teamRosterDomainSpec> | undefined
  let rosterTable: KvTable<string, TeamRosterRecord> | undefined
  let cacheTable: KvTable<string, MemberCacheRecord> | undefined
  /** Per-member in-memory cache; storage backing arrives once the domain opens. */
  const caches = new Map<string, MemberCache>()
  /** A roster fault (storage open failure) that makes roster writes fail loud. */
  let rosterFault: Error | undefined

  const routePermission: MemberHooks['onPermission'] = (request) => {
    if (permissionHandlers.size === 0) {
      // No subscriber: fall back to the deployment policy. `allow` selects
      // the first allow option; anything else cancels.
      const policy = policies.get(request.memberId) ?? 'reject'
      if (policy === 'allow') {
        const allow = request.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
        if (allow !== undefined) return Promise.resolve({ outcome: 'selected', optionId: allow.optionId })
      }
      return Promise.resolve({ outcome: 'cancelled' })
    }
    // Surface to subscribers: the request is emitted, an external answer may
    // arrive through team.permission, and a handler may answer inline (the
    // first settlement wins).
    ctx.emit('team/permission-requested', request)
    let resolveExternal!: (outcome: TeamPermissionOutcome) => void
    const external = new Promise<TeamPermissionOutcome>((resolve) => { resolveExternal = resolve })
    pendingAnswers.set(request.requestId, { memberId: request.memberId, resolve: resolveExternal })
    const never = (): Promise<TeamPermissionOutcome> => new Promise<TeamPermissionOutcome>(() => {})
    const inline = [...permissionHandlers].map(handler =>
      // Each handler's failure (sync throw or rejection) is contained to that
      // handler: it becomes "no answer" so one bad subscriber can neither
      // cancel the request nor preempt the external answer.
      Promise.resolve().then(() => handler(request))
        .then(outcome => outcome === undefined ? never() : outcome)
        .catch((error: unknown) => {
          ctx.logger.warn(`team: permission subscriber failed for member "${request.memberId}": ${String(error)}`)
          return never()
        }))
    return Promise.race([external, ...inline]).finally(() => { pendingAnswers.delete(request.requestId) })
  }

  const addConnection = (member: MemberConfig): MemberConnection => {
    const cache = caches.get(member.id) ?? new MemberCache()
    caches.set(member.id, cache)
    const table = cacheTable
    if (table !== undefined) {
      cache.setStorage({
        get: () => table.get(member.id),
        put: record => table.put(member.id, record),
      })
    }
    const connection = new MemberConnection(ctx, member, {
      // The host stream forwards allowlisted events as lossless JSON; a
      // trailing explicit `undefined` error argument is not JSON data, so the
      // no-error migration emits two arguments, not three.
      onStatus: (status, error) => {
        if (error === undefined) ctx.emit('team/status', member.id, status)
        else ctx.emit('team/status', member.id, status, error)
      },
      onUpdate: (sessionId, update) => { ctx.emit('team/member-update', member.id, sessionId, update) },
      onPermission: routePermission,
      onTurnEnd: (sessionId, promptId, stopReason, error) => {
        // No trailing undefined: the remote-event forwarder rejects non-JSON args.
        if (error === undefined) ctx.emit('team/turn-end', member.id, sessionId, promptId, stopReason)
        else ctx.emit('team/turn-end', member.id, sessionId, promptId, stopReason, error)
      },
    }, cache)
    connections.set(member.id, connection)
    policies.set(member.id, member.permission ?? 'reject')
    memberConfigs.set(member.id, member)
    return connection
  }
  for (const member of config.members) addConnection(member)

  // Roster persistence: runtime-added members are written durably so a
  // restart re-spawns them (C6). Config members are authoritative — a
  // persisted record whose id also appears in config is ignored at load.
  const storageDomain = ctx.get('storageDomain') as StorageDomainFacility | undefined
  let rosterReady: Promise<void> | undefined
  const ensureRoster = (): Promise<void> => {
    rosterReady ??= (async () => {
      if (storageDomain === undefined) return
      try {
        rosterDomain = await storageDomain.open(teamRosterDomainSpec)
        rosterTable = rosterDomain.table('roster')
        const table = rosterDomain.table('cache')
        cacheTable = table
        for (const [id, cache] of caches) {
          cache.setStorage({
            get: () => table.get(id),
            put: record => table.put(id, record),
          })
        }
        for (const [id, record] of rosterTable.entries()) {
          if (connections.has(id)) continue
          const member: MemberConfig = {
            id,
            ...record.title === undefined ? {} : { title: record.title },
            ...record.description === undefined ? {} : { description: record.description },
            ...record.kind === undefined ? {} : { kind: record.kind },
            ...record.command === undefined ? {} : { command: record.command },
            args: record.args,
            ...record.cwd === undefined ? {} : { cwd: record.cwd },
            env: record.env,
            ...record.permission === undefined ? {} : { permission: record.permission },
            ...record.autostart === undefined ? {} : { autostart: record.autostart },
            ...record.preset === undefined ? {} : { preset: record.preset },
          }
          assertMemberConfig(member)
          addConnection(member)
        }
      } catch (error: unknown) {
        // The roster is a hard contract for runtime membership: a broken
        // medium must fail addMember/removeMember loud, not silently lose
        // members. Config members still start; only roster writes reject.
        rosterFault = error instanceof Error ? error : new Error(String(error))
        ctx.logger.error(`team: roster persistence unavailable: ${rosterFault.message}`)
      }
    })()
    return rosterReady
  }

  const service: TeamService = {
    list: () => [...connections.values()].map(connection => connection.snapshot()),
    // Every method is async so member lookup failures surface as rejections,
    // not synchronous throws inside a caller's expression.
    start: async (memberId) => { await requireMember(connections, memberId).start() },
    stop: async (memberId) => { await requireMember(connections, memberId).stop() },
    restart: async (memberId) => { await requireMember(connections, memberId).restart() },
    listSessions: async (memberId, cwd) => {
      await ensureRoster()
      return requireMember(connections, memberId).listSessions(cwd)
    },
    loadSession: async (memberId, sessionId) => requireMember(connections, memberId).loadSession(sessionId),
    readHistory: async (memberId, sessionId) => {
      await ensureRoster()
      return requireMember(connections, memberId).readHistory(sessionId)
    },
    readHistoryEvents: async (memberId, sessionId) => {
      await ensureRoster()
      return requireMember(connections, memberId).readHistoryEvents(sessionId)
    },
    isTurnInFlight: (memberId, sessionId) => requireMember(connections, memberId).isTurnInFlight(sessionId),
    newSession: async memberId => requireMember(connections, memberId).newSession(),
    getConfig: async (memberId, sessionId) => {
      await ensureRoster()
      return requireMember(connections, memberId).getConfig(sessionId)
    },
    setConfig: async (memberId, sessionId, configId, value) =>
      requireMember(connections, memberId).setSessionConfig(sessionId, configId, value),
    listProviders: async memberId => requireMember(connections, memberId).listProviders(),
    setProvider: async (memberId, config) => requireMember(connections, memberId).setProvider(config),
    prompt: async (memberId, sessionId, text) => requireMember(connections, memberId).prompt(sessionId, text),
    promptContent: async (memberId, sessionId, content) => requireMember(connections, memberId).promptContent(sessionId, content),
    cancel: async (memberId, sessionId) => { await requireMember(connections, memberId).cancel(sessionId) },
    permission: (memberId, requestId, outcome): Promise<void> => {
      const pending = pendingAnswers.get(requestId)
      if (pending === undefined || pending.memberId !== memberId) return Promise.resolve()
      pendingAnswers.delete(requestId)
      pending.resolve(outcome)
      return Promise.resolve()
    },
    chat: async (memberId, sessionId, text, signal) => requireMember(connections, memberId).chat(sessionId, text, signal),
    // Runtime roster mutation: persist first, then join and start, so a
    // failed write never leaves a half-joined member.
    addMember: async (input) => {
      await ensureRoster()
      assertRosterWritable(rosterFault)
      // The single funnel: every caller (host API, model tool, future seams)
      // may omit the collection fields; the connection and the durable record
      // always see a complete MemberConfig.
      const member: MemberConfig = { ...input, args: input.args ?? [], env: input.env ?? {} }
      if (connections.has(member.id)) throw new Error(`team: duplicate member id "${member.id}"`)
      assertMemberConfig(member)
      // Seed the member's home from the main instance before it spawns, so the
      // member is self-contained (reads only its own DSH_HOME, no DSH_MAIN_HOME).
      // A seed failure throws before the roster record is written, so no
      // half-joined member is left behind.
      await seedMemberHome(member)
      if (rosterTable !== undefined) {
        await rosterTable.put(member.id, { ...member, args: member.args ?? [], env: member.env ?? {} })
      }
      const connection = addConnection(member)
      if (member.autostart !== false) {
        void connection.start().catch((error: unknown) => {
          ctx.logger.warn(`team: member "${member.id}" failed to start: ${String(error)}`)
        })
      }
      return connection.snapshot()
    },
    removeMember: async (memberId) => {
      await ensureRoster()
      assertRosterWritable(rosterFault)
      const connection = requireMember(connections, memberId)
      await connection.stop()
      connections.delete(memberId)
      policies.delete(memberId)
      // A failed storage delete only resurrects the member at the next
      // restart — the live roster already dropped it.
      if (rosterTable !== undefined) {
        await rosterTable.delete(memberId).catch((error: unknown) => {
          ctx.logger.warn(`team: roster delete failed for "${memberId}": ${String(error)}`)
        })
      }
    },
    onPermissionRequest: (handler) => {
      permissionHandlers.add(handler)
      return () => { permissionHandlers.delete(handler) }
    },
    disposeAll: async () => {
      await Promise.allSettled([...connections.values()].map(connection => connection.stop()))
    },
  }
  ctx.provide('team', service)
  // Cordis awaits a disposer's returned promise (fiber disposal chains
  // thenables), so returning disposeAll lets plugin unload wait for every
  // member process to reach quiescence instead of fire-and-forget.
  ctx.effect(() => () => service.disposeAll(), 'team.disposeAll()')

  // Autostart: members declared with autostart (the default) spawn once the
  // roster has been merged, so a restart re-raises every member. Awaiting the
  // roster here means `ctx.plugin(team)` settles with the full roster visible.
  await ensureRoster()
  // Seed every dsh member's home before any of them spawns, backfilling any
  // missing artifact (per-file idempotent, so this is a no-op for complete
  // homes and repairs homes created before seeding existed or damaged out
  // from under the member). A load-time seed failure warns rather than aborts
  // boot: the member still joins, and its spawn or first session surfaces the
  // problem.
  for (const [id, member] of memberConfigs) {
    if (member.kind !== 'dsh') continue
    try {
      await seedMemberHome(member)
    } catch (error: unknown) {
      ctx.logger.warn(`team: member "${id}" failed to seed its home: ${String(error)}`)
    }
  }
  for (const connection of connections.values()) {
    if (connection.snapshot().autostart) {
      void connection.start().catch((error: unknown) => {
        ctx.logger.warn(`team: member "${connection.snapshot().id}" failed to autostart: ${String(error)}`)
      })
    }
  }
}

/** Look up one member by id, failing loud on a miss. */
function requireMember(connections: Map<string, MemberConnection>, memberId: string): MemberConnection {
  const connection = connections.get(memberId)
  if (connection === undefined) {
    throw new Error(`team: unknown member "${memberId}"`)
  }
  return connection
}

/** Roster writes must fail loud when persistence is broken (never silently drop members). */
function assertRosterWritable(fault: Error | undefined): void {
  if (fault !== undefined) throw fault
}

/** Validate a member configuration: resolve its spawn spec and fail loud on contradictions. */
function assertMemberConfig(member: MemberConfig): void {
  resolveMemberSpec(member)
}
