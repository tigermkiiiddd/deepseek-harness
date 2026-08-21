/**
 * team domain contract: the browser-facing read/drive surface over the team
 * service. Wire views are plain JSON (brands stripped); the member processes
 * own their sessions, and these methods only list, load, create, prompt,
 * cancel, and manage them. Live member output arrives as forwarded
 * `team/*` remote events over the host stream, never by polling.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One configured member's identity, liveness, and negotiated capabilities. */
export interface TeamMemberView {
  readonly id: string
  readonly title: string
  readonly description: string | undefined
  readonly kind: 'dsh' | undefined
  readonly status: string
  /** The member's `initialize` capabilities (verbatim JSON), when connected. */
  readonly capabilities: unknown
  /** Whether this member autostarts with the host. */
  readonly autostart: boolean
  /** The last connection failure's message, for views. */
  readonly lastError: string | undefined
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

/** The permission outcome the browser sends back for one request. */
export type TeamPermissionOutcomeView =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

/**
 * Team-domain unary methods. Every method delegates to the host team service
 * (`ctx.team`); member sessions stay in the member processes, and prompt
 * turns are accepted here and streamed back as remote events.
 */
export interface TeamApi {
  /** Every member with its connection status, capabilities, and last error. */
  list(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<TeamMemberView[]>>

  /** Start one member's process and complete the ACP handshake. */
  start(request: RpcRequest<{ memberId: string }>): Promise<RpcResponse<Record<string, never>>>

  /** Stop one member's process and return it to idle. */
  stop(request: RpcRequest<{ memberId: string }>): Promise<RpcResponse<Record<string, never>>>

  /** Stop then start one member. */
  restart(request: RpcRequest<{ memberId: string }>): Promise<RpcResponse<Record<string, never>>>

  /** One member's own conversation topics. */
  sessions(request: RpcRequest<{ memberId: string }>): Promise<RpcResponse<TeamSessionView[]>>

  /** One topic's replayed conversation history (from the member process). */
  history(request: RpcRequest<{ memberId: string; sessionId: string }>): Promise<RpcResponse<TeamHistoryEntryView[]>>

  /** Open a new topic on the member and return its id. */
  newSession(request: RpcRequest<{ memberId: string }>): Promise<RpcResponse<{ sessionId: string }>>

  /**
   * Accept one prompt turn and return immediately; chunks arrive as
   * `team/member-update` remote events and settlement as `team/turn-end`.
   */
  prompt(request: RpcRequest<{ memberId: string; sessionId: string; text: string }>): Promise<RpcResponse<{ promptId: string }>>

  /** Cancel the in-flight prompt turn of one session. */
  cancel(request: RpcRequest<{ memberId: string; sessionId: string }>): Promise<RpcResponse<Record<string, never>>>

  /** Answer one unanswered `session/request_permission` prompt. */
  permission(
    request: RpcRequest<{ memberId: string; requestId: string; outcome: TeamPermissionOutcomeView }>,
  ): Promise<RpcResponse<Record<string, never>>>

  /** Spawn a new member process at runtime, persist it in the roster, and join it. */
  addMember(request: RpcRequest<TeamAddMemberRequest>): Promise<RpcResponse<TeamMemberView>>

  /** Stop one member, drop it from the roster, and delete its persisted record. */
  removeMember(request: RpcRequest<{ memberId: string }>): Promise<RpcResponse<Record<string, never>>>
}

/** Runtime member-addition request: the same fields `Config.members` declares. */
export interface TeamAddMemberRequest {
  /** Stable member id (unique within one deployment). */
  readonly id: string
  /** Display name shown in team views. */
  readonly title?: string
  /** One-line role/persona description shown in team views. */
  readonly description?: string
  /** Member kind; `'dsh'` relaunches the current installation. */
  readonly kind?: 'dsh'
  /** Executable spawned for the member process (any ACP server). Required unless `kind: 'dsh'`. */
  readonly command?: string
  /** Arguments passed to the member command. */
  readonly args?: string[]
  /** Working directory for the member process (optional; defaults to the harness launch directory). */
  readonly cwd?: string
  /** Extra environment layered over the full parent environment. */
  readonly env?: Record<string, string>
  /** Auto-answer the member's permission prompts with this policy when no subscriber answers. */
  readonly permission?: 'allow' | 'reject'
  /** Start the member now and on every host restart (default true). */
  readonly autostart?: boolean
}
