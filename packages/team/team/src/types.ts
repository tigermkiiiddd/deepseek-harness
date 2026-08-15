/**
 * Team-member connection types: the durable identities and wire results the
 * team service exposes. A member is a persistent ACP agent process that owns
 * its own sessions (topics) — the harness never mirrors or stores them.
 *
 * @module @deepseek-ai/dsh-team/types
 */

/** One configured team member: how to spawn its persistent ACP process. */
export interface MemberConfig {
  /** Stable member id (unique within one deployment). */
  readonly id: string
  /** Display name shown in team views. */
  readonly title?: string
  /** One-line role/persona description shown in team views. */
  readonly description?: string
  /** Executable spawned for the member process (any ACP server, e.g. `dsh-acp-demo`). */
  readonly command: string
  /** Arguments passed to {@link MemberConfig.command}. */
  readonly args: string[]
  /**
   * Working directory for the member process. When omitted, the first caller's
   * session workspace is used at connect time and kept for the process lifetime.
   */
  readonly cwd?: string
  /** Extra environment layered over a credential-scrubbed parent environment. */
  readonly env?: Record<string, string>
  /** Auto-answer the member's `session/request_permission` prompts. */
  readonly permission?: 'allow' | 'reject'
}

/** A member process's connection state. */
export type MemberStatus = 'connecting' | 'connected' | 'failed' | 'closed'

/** Read-only member identity and liveness for views and tools. */
export interface MemberSnapshot {
  readonly id: string
  readonly title: string
  readonly description: string | undefined
  readonly status: MemberStatus
}

/** One conversation topic the member itself owns. */
export interface MemberSession {
  readonly sessionId: string
  readonly cwd: string
}

/** The terminal outcome of one chat turn against a member session. */
export interface ChatResult {
  /** The member's committed assistant text for this turn. */
  readonly text: string
  /** The ACP stop reason, mapped verbatim. */
  readonly stopReason: import('@agentclientprotocol/sdk').StopReason
}
