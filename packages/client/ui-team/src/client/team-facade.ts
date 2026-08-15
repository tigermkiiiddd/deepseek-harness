/**
 * The team panel's drive surface: the team domain unwrapped from RPC
 * envelopes. Pure data operations — the panel reads and drives member
 * processes through these calls; no state lives here.
 */

import type {
  IApiClient, RpcResponse, TeamChatResultView, TeamHistoryEntryView, TeamMemberView, TeamSessionView,
} from '@deepseek-ai/dsh-client-connection/client'

/** The team operations the panel drives, each unwrapped from the host API.
 * Function-type properties: the facade is a bundle of closures over the wire
 * face, never a this-bound object. */
export interface TeamFacade {
  /** List configured members. */
  list: () => Promise<TeamMemberView[]>
  /** List a member's own conversation topics. */
  sessions: (memberId: string) => Promise<TeamSessionView[]>
  /** Replay one topic's history. */
  history: (memberId: string, sessionId: string) => Promise<TeamHistoryEntryView[]>
  /** Start a fresh topic on a member and return its id. */
  newSession: (memberId: string) => Promise<string>
  /** Send one turn and return the member's settled reply. */
  chat: (memberId: string, sessionId: string, text: string) => Promise<TeamChatResultView>
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
    sessions: memberId => unwrap(team.sessions({ memberId })),
    history: (memberId, sessionId) => unwrap(team.history({ memberId, sessionId })),
    newSession: async memberId => (await unwrap(team.newSession({ memberId }))).sessionId,
    chat: (memberId, sessionId, text) => unwrap(team.chat({ memberId, sessionId, text })),
  }
}
