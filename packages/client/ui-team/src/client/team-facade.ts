/**
 * The team panel's drive surface: the team domain unwrapped from RPC
 * envelopes. Pure data operations — the panel reads and drives member
 * processes through these calls; no state lives here.
 */

import type {
  IApiClient, RpcResponse, TeamMemberView, TeamSessionView,
} from '@deepseek-ai/dsh-client-connection/client'

/** The team operations the panel drives, each unwrapped from the host API.
 * Function-type properties: the facade is a bundle of closures over the wire
 * face, never a this-bound object. */
export interface TeamFacade {
  /** List members with their connection status, capabilities, and last error. */
  list: () => Promise<TeamMemberView[]>
  /** Start one member's process. */
  start: (memberId: string) => Promise<void>
  /** Stop one member's process. */
  stop: (memberId: string) => Promise<void>
  /** Stop then start one member. */
  restart: (memberId: string) => Promise<void>
  /** List a member's own conversation topics. */
  sessions: (memberId: string) => Promise<TeamSessionView[]>
  /** Start a fresh topic on a member and return its id. */
  newSession: (memberId: string) => Promise<string>
  /** Spawn a new member process at runtime, persist it in the roster, and join it. */
  addMember: (config: import('@deepseek-ai/dsh-client-connection/client').TeamAddMemberRequest) => Promise<TeamMemberView>
  /** Tear down one member's process, drop it from the roster, and delete its persisted record. */
  removeMember: (memberId: string) => Promise<void>
}

/**
 * Unwrap a team unary response, throwing on the error branch.
 * @param call - a pending team domain response.
 * @returns the ok-branch value.
 */
export async function unwrap<T>(call: Promise<RpcResponse<T>>): Promise<T> {
  const response = await call
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

/**
 * Build the panel facade over the wire face.
 * @param team - the team domain of the connection's API client.
 * @returns the unwrapped facade.
 */
export function createTeamFacade(team: IApiClient['team']): TeamFacade {
  return {
    list: () => unwrap(team.list({})),
    start: async (memberId) => { await unwrap(team.start({ memberId })) },
    stop: async (memberId) => { await unwrap(team.stop({ memberId })) },
    restart: async (memberId) => { await unwrap(team.restart({ memberId })) },
    sessions: memberId => unwrap(team.sessions({ memberId })),
    newSession: async memberId => (await unwrap(team.newSession({ memberId }))).sessionId,
    addMember: config => unwrap(team.addMember(config)),
    removeMember: async (memberId) => { await unwrap(team.removeMember({ memberId })) },
  }
}
