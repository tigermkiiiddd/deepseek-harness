/** Browser facade over the generated Team Remote namespace. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { MemberConfigInput, TeamMemberRow, TeamSessionRow } from '@deepseek-ai/dsh-team/types'

/** Generated Team Remote methods consumed by the Team view. */
export interface TeamRemoteNamespace {
  list(): Promise<RemoteResult<TeamMemberRow[]>>
  start(memberId: string): Promise<RemoteResult<void>>
  stop(memberId: string): Promise<RemoteResult<void>>
  restart(memberId: string): Promise<RemoteResult<void>>
  sessions(memberId: string): Promise<RemoteResult<TeamSessionRow[]>>
  newSession(memberId: string): Promise<RemoteResult<string>>
  addMember(config: MemberConfigInput): Promise<RemoteResult<TeamMemberRow>>
  removeMember(memberId: string): Promise<RemoteResult<void>>
}

/** Rejection-based Team operations used by the controller. */
export interface TeamFacade {
  list(): Promise<TeamMemberRow[]>
  start(memberId: string): Promise<void>
  stop(memberId: string): Promise<void>
  restart(memberId: string): Promise<void>
  sessions(memberId: string): Promise<TeamSessionRow[]>
  newSession(memberId: string): Promise<string>
  addMember(config: MemberConfigInput): Promise<TeamMemberRow>
  removeMember(memberId: string): Promise<void>
}

/**
 * Unwrap one generated Remote result.
 * @param call - pending Remote result.
 * @returns the successful value.
 */
export async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Adapt the generated Remote namespace to the controller's rejection-based API.
 * @param team - mounted Team Remote namespace.
 * @returns Team controller facade.
 */
export function createTeamFacade(team: TeamRemoteNamespace): TeamFacade {
  return {
    list: () => unwrap(team.list()),
    start: async (memberId) => { await unwrap(team.start(memberId)) },
    stop: async (memberId) => { await unwrap(team.stop(memberId)) },
    restart: async (memberId) => { await unwrap(team.restart(memberId)) },
    sessions: memberId => unwrap(team.sessions(memberId)),
    newSession: memberId => unwrap(team.newSession(memberId)),
    addMember: config => unwrap(team.addMember(config)),
    removeMember: async (memberId) => { await unwrap(team.removeMember(memberId)) },
  }
}
