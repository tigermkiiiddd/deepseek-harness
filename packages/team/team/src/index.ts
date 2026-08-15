/**
 * Team-member connections: the `team` service owns one persistent ACP process
 * per configured member and exposes the member's own sessions (topics) plus
 * chat turns against them. The harness never mirrors or stores member sessions
 * — they live in the member's process and its persistence — so listing,
 * loading, and creating topics all go through the Agent Client Protocol.
 *
 * @module @deepseek-ai/dsh-team
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MemberConnection } from './member.ts'
import type { ChatResult, MemberConfig, MemberSession, MemberSnapshot } from './types.ts'

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
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    cwd: z.string(),
    env: z.dict(z.string()).default({}),
    permission: z.union(['allow', 'reject'] as const).default('reject'),
  })).required(),
})

/** The team service the plugin provides under `ctx.team`. */
export interface TeamService {
  /** Every configured member with its live connection status. */
  list(): MemberSnapshot[]
  /** One member's own conversation topics (persisted in the member process). */
  listSessions(memberId: string, cwd?: string): Promise<MemberSession[]>
  /** Resume one of the member's topics so chat continues its history. */
  loadSession(memberId: string, sessionId: string): Promise<void>
  /** Load one topic and collect its replayed conversation history. */
  readHistory(memberId: string, sessionId: string): Promise<{ role: 'user' | 'assistant'; text: string }[]>
  /** Open a new topic on the member and return its id. */
  newSession(memberId: string): Promise<string>
  /** Drive one chat turn against one of the member's topics. */
  chat(memberId: string, sessionId: string, text: string, signal?: AbortSignal): Promise<ChatResult>
  /** Tear down one member's process (its persisted sessions remain). */
  close(memberId: string): Promise<void>
  /** Tear down every member process. Idempotent. */
  disposeAll(): Promise<void>
}

/**
 * Mount the team service.
 * @param ctx - Cordis context with the subprocess seam.
 * @param config - the member roster.
 */
export function apply(ctx: Context, config: Config): void {
  // Validate the roster at load: duplicate ids and missing commands are
  // misconfigurations, not per-call surprises.
  const seen = new Set<string>()
  for (const member of config.members) {
    if (seen.has(member.id)) throw new Error(`team: duplicate member id "${member.id}"`)
    seen.add(member.id)
    if (member.command.trim() === '') throw new Error(`team: member "${member.id}" has an empty command`)
  }

  const resolveCwdFor = (member: MemberConfig): (() => string) => {
    // The first caller's session workspace binds the member process; resolved
    // lazily because no session exists at load time.
    let bound: string | undefined
    return () => {
      if (member.cwd !== undefined) return member.cwd
      if (bound !== undefined) return bound
      const agents = ctx.get('agents') as { currentInitiator(): { session: { header: { cwd?: string } } } | undefined } | undefined
      const callerCwd = agents?.currentInitiator()?.session.header.cwd
      if (callerCwd === undefined) {
        throw new Error(`team: member "${member.id}" needs a workspace — configure cwd or call from a session that has one`)
      }
      bound = callerCwd
      return bound
    }
  }

  const connections = new Map<string, MemberConnection>()
  for (const member of config.members) {
    connections.set(member.id, new MemberConnection(ctx, member, resolveCwdFor(member)))
  }

  const service: TeamService = {
    list: () => [...connections.values()].map(connection => connection.snapshot()),
    // Every method is async so member lookup failures surface as rejections,
    // not synchronous throws inside a caller's expression.
    listSessions: async (memberId, cwd) => requireMember(connections, memberId).listSessions(cwd),
    loadSession: async (memberId, sessionId) => requireMember(connections, memberId).loadSession(sessionId),
    readHistory: async (memberId, sessionId) => requireMember(connections, memberId).readHistory(sessionId),
    newSession: async memberId => requireMember(connections, memberId).newSession(),
    chat: async (memberId, sessionId, text, signal) => requireMember(connections, memberId).chat(sessionId, text, signal),
    close: async memberId => requireMember(connections, memberId).close(),
    disposeAll: async () => {
      await Promise.allSettled([...connections.values()].map(connection => connection.close()))
    },
  }
  ctx.provide('team', service)
  ctx.effect(() => () => { void service.disposeAll() }, 'team.disposeAll()')
}

/** Look up one member by id, failing loud on a miss. */
function requireMember(connections: Map<string, MemberConnection>, memberId: string): MemberConnection {
  const connection = connections.get(memberId)
  if (connection === undefined) {
    throw new Error(`team: unknown member "${memberId}"`)
  }
  return connection
}
