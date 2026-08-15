/**
 * team domain contract: the browser-facing read/drive surface over the team
 * service. Wire views are plain JSON (brands stripped); the member processes
 * own their sessions, and these methods only list, load, create, and chat
 * with them.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One configured member's identity and liveness. */
export interface TeamMemberView {
  readonly id: string
  readonly title: string
  readonly description: string | undefined
  readonly status: string
}

/** One conversation topic owned by a member process. */
export interface TeamSessionView {
  readonly sessionId: string
  readonly cwd: string
}

/** One replayed conversation message. */
export interface TeamHistoryEntryView {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** The terminal outcome of one chat turn. */
export interface TeamChatResultView {
  readonly text: string
  readonly stopReason: string
}

/**
 * Team-domain unary methods. Every method delegates to the host team service
 * (`ctx.team`); member sessions stay in the member processes.
 */
export interface TeamApi {
  /** Every configured member with its connection status. */
  list(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<TeamMemberView[]>>

  /** One member's own conversation topics. */
  sessions(request: RpcRequest<{ memberId: string }>): Promise<RpcResponse<TeamSessionView[]>>

  /** One topic's replayed conversation history (from the member process). */
  history(request: RpcRequest<{ memberId: string; sessionId: string }>): Promise<RpcResponse<TeamHistoryEntryView[]>>

  /** Open a new topic on the member and return its id. */
  newSession(request: RpcRequest<{ memberId: string }>): Promise<RpcResponse<{ sessionId: string }>>

  /** Drive one chat turn against one of the member's topics. */
  chat(request: RpcRequest<{ memberId: string; sessionId: string; text: string }>): Promise<RpcResponse<TeamChatResultView>>
}
