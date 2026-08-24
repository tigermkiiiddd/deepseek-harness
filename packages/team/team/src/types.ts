/**
 * Team-member connection types and the team's Cordis event vocabulary: the
 * durable identities, wire results, and push events the team service exposes.
 * A member is a persistent ACP agent process that owns its own sessions
 * (topics) — the harness never mirrors or stores them. Type-only and
 * client-safe: the same module declares the events the Host emits and the
 * browser face subscribes to (`ctx.remote.$on`).
 *
 * @module @deepseek-ai/dsh-team/types
 */

import type { AgentCapabilities, PermissionOption, SessionUpdate, StopReason, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

/** One configured team member: how to spawn its persistent ACP process. */
export interface MemberConfig {
  /** Stable member id (unique within one deployment). */
  readonly id: string
  /** Display name shown in team views. */
  readonly title?: string
  /** One-line role/persona description shown in team views. */
  readonly description?: string
  /**
   * Member kind. When `'dsh'` the harness relaunches the current installation
   * (`dsh --profile acp`) with a per-member harness home; `command` and `args`
   * must be absent. When omitted, `command` is required and the member runs
   * any ACP server.
   */
  readonly kind?: 'dsh'
  /** Executable spawned for the member process (any ACP server, e.g. `dsh-acp-demo`). Required unless `kind: 'dsh'`. */
  readonly command?: string
  /** Arguments passed to {@link MemberConfig.command}. */
  readonly args?: string[]
  /**
   * Working directory for the member process and its ACP sessions. When
   * omitted, the member runs in the harness process's launch directory; no
   * caller session workspace is ever bound to a member.
   */
  readonly cwd?: string
  /**
   * Extra environment layered over the FULL parent environment. Members are
   * trusted peers: they inherit the main process's environment (credentials
   * included) unless a key is overridden or removed here.
   */
  readonly env?: Record<string, string>
  /** Auto-answer the member's `session/request_permission` prompts when no GUI subscriber answers them. */
  readonly permission?: 'allow' | 'reject'
  /** Spawn and connect this member when the service loads (default `true`). */
  readonly autostart?: boolean
  /**
   * The member's own agent preset composition: a YAML top-level list of plugin
   * rows (persona, tools, prompt sections) that makes this member unique.
   * Only `kind: 'dsh'` members carry one — they are the members with a harness
   * home to hold it. Seeded once at creation into the member home's preset
   * root and made the member's default preset; a restart never re-seeds, so
   * the composition is fixed for the member's lifetime in that home.
   */
  readonly preset?: string
}

/**
 * A member process's public status — the single external vocabulary:
 * `idle` (process up, handshake done, no prompt turn in flight),
 * `running` (at least one prompt turn in flight, `prompt` or blocking
 * `chat` alike), `offline` (process not running: never started, stopped, or
 * the connection was lost), `failed` (the last start's spawn or handshake
 * failed). Connecting is internal-only: while a start is in flight the
 * snapshot and events keep reporting the previous public status.
 */
export type MemberStatus = 'idle' | 'running' | 'offline' | 'failed'

/**
 * Runtime member-addition input: {@link MemberConfig} with the collection
 * fields optional. The team service resolves the defaults (`args: []`,
 * `env: {}`) at the `addMember` funnel, so every caller — host API, model
 * tool, future seams — reaches the connection with a complete config.
 */
export type MemberConfigInput = Omit<MemberConfig, 'args' | 'env'> & {
  readonly args?: string[]
  readonly env?: Record<string, string>
}

/** Resolved spawn parameters after kind expansion; `env` is merged last so explicit per-member entries win. */
export interface ResolvedMemberSpawnSpec {
  /** Executable to spawn. */
  readonly command: string
  /** Arguments after the executable. */
  readonly args: readonly string[]
  /** Environment entries merged after inherited env and `config.env`. */
  readonly env: Record<string, string>
}

/** The agent capabilities the member advertised in `initialize`, retained per connection. */
export type MemberCapabilities = AgentCapabilities

/** Read-only member identity, liveness, and negotiated capabilities for views and tools. */
export interface MemberSnapshot {
  readonly id: string
  readonly title: string
  readonly description: string | undefined
  readonly kind: 'dsh' | undefined
  readonly status: MemberStatus
  /** The member's `initialize` capabilities, when a connection has completed. */
  readonly capabilities: MemberCapabilities | undefined
  /** Whether this member autostarts with the service. */
  readonly autostart: boolean
  /** The last connection failure's message, for views. */
  readonly lastError: string | undefined
  /**
   * The last model id this member selected, when it has advertised a model
   * configuration option and we have seen its config. A convenience for views;
   * the authoritative per-session config is {@link TeamService.getConfig}.
   */
  readonly model: string | undefined
}

/**
 * One selectable value inside a session configuration option. The harness
 * never displays the raw value id alone — it pairs with {@link name}.
 */
export interface SessionConfigValueInfo {
  /** The value id the agent uses to select this option. */
  readonly value: string
  /** Human-readable label. */
  readonly name: string
  /** Optional description. */
  readonly description: string | undefined
}

/**
 * One resolved session configuration option — the subset the harness exposes.
 * `category` is the agent's UX hint (e.g. `"model"` / `"mode"`); it is never
 * required for correctness.
 */
export interface SessionConfigOptionInfo {
  readonly id: string
  readonly name: string
  readonly category: string | undefined
  readonly type: 'select' | 'boolean'
  /** The current value: a value id for `select`, a boolean for `boolean`. */
  readonly currentValue: string | boolean
  /** Selectable values when `type === 'select'`; empty for `boolean`. */
  readonly options: readonly SessionConfigValueInfo[]
}

/**
 * A resolved session configuration set plus the model shortcut. `model` is the
 * current model selection, when the member advertises a model option.
 */
export interface SessionConfigSnapshot {
  readonly options: readonly SessionConfigOptionInfo[]
  readonly model: {
    readonly currentValue: string
    readonly options: readonly SessionConfigValueInfo[]
  } | undefined
}

/**
 * One user-role content block for a member prompt, in ACP wire form. Text is
 * plain; images are base64 with their media type — the agent validates and
 * routes them on its own side.
 */
export type MemberPromptBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

/** A configurable provider as the member reports it via `providers/list`. */
export interface MemberProviderInfo {
  readonly id: string
  readonly required: boolean
  readonly supported: readonly string[]
  /** The provider's current routing config, when enabled. */
  readonly current: { readonly apiType: string; readonly baseUrl: string } | undefined
}

/**
 * Input to configure one provider (member-scoped). `headers` are optional and
 * never carry secrets into the harness — the agent stores them on its own side.
 */
export interface MemberProviderConfigInput {
  readonly id: string
  readonly apiType: string
  readonly baseUrl: string
  readonly headers: Record<string, string> | undefined
}

/** One conversation topic the member itself owns. */
export interface MemberSession {
  readonly sessionId: string
  readonly cwd: string
  /** Human-readable title the member reported, when any. */
  readonly title?: string | undefined
  /** ISO 8601 last-activity timestamp the member reported, when any. */
  readonly updatedAt?: string | undefined
}

/** One replayed conversation message (the member's own record of a topic). */
export interface MemberHistoryEntry {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** The terminal outcome of one chat turn against a member session. */
export interface ChatResult {
  /** The member's committed assistant text for this turn. */
  readonly text: string
  /** The ACP stop reason, mapped verbatim. */
  readonly stopReason: StopReason
}

/** The outcome a permission subscriber (or the deployment policy) returns. */
export type TeamPermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

/** One `session/request_permission` prompt surfaced to subscribers. */
export interface TeamPermissionRequest {
  /** Locally minted stable id used to answer this request. */
  readonly requestId: string
  /** The member that raised the request. */
  readonly memberId: string
  /** The member's session the request belongs to. */
  readonly sessionId: string
  /** The tool call awaiting permission, verbatim from the wire. */
  readonly toolCall: ToolCallUpdate
  /** The permission options the member offered, verbatim. */
  readonly options: readonly PermissionOption[]
}

/**
 * A permission-request subscriber: receives the request and may answer with an
 * outcome. Returning `undefined` (or resolving to it) means the subscriber
 * surfaced the request and an external answer will arrive through
 * `team.permission` — the request stays pending until then.
 */
export type TeamPermissionHandler = (
  request: TeamPermissionRequest,
) => TeamPermissionOutcome | undefined | Promise<TeamPermissionOutcome | undefined>

/** One member question batch surfaced to subscribers, verbatim from the wire. */
export interface TeamUserQuestionRequest {
  /** Locally minted stable id used to answer this batch. */
  readonly requestId: string
  /** The member that raised the questions. */
  readonly memberId: string
  /**
   * The member's own session (topic) the questions belong to, when the ask
   * came from an agent-owned tool call; absent for unbound batches.
   */
  readonly sessionId?: string
  /** The questions awaiting answers, verbatim from the wire-safe types. */
  readonly questions: readonly AskUserQuestionItem[]
}

/** The human's answers returned for one question batch. */
export interface TeamUserQuestionAnswer {
  /** Structured answers keyed by question id; empty when declined. */
  readonly answers: readonly AskUserQuestionAnswerItem[]
}

/**
 * A user-question subscriber: receives the batch and may answer inline with
 * the structured answers. Returning `undefined` means the subscriber surfaced
 * the batch and an external answer will arrive through
 * `team.answerUserQuestion` — the batch stays pending until then.
 */
export type TeamUserQuestionHandler = (
  request: TeamUserQuestionRequest,
) => TeamUserQuestionAnswer | undefined | Promise<TeamUserQuestionAnswer | undefined>

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A member's status migrated. Every transition emits exactly one public
     * event (`idle` / `running` / `offline` / `failed`). `connecting` is an
     * internal transition: during startup a member reads as `offline` until the
     * handshake completes. Consumers never poll. `error` carries the failure
     * message on `failed`.
     * @mode emit
     * @param memberId - the member whose status moved.
     * @param status - the new public status.
     * @param error - the failure message, on `failed`.
     */
    'team/status'(memberId: string, status: MemberStatus, error?: string): void
    /**
     * One typed `session/update` notification from a member, forwarded
     * losslessly: text/thought chunks, tool calls, plans, usage — the member
     * interface is a projection of this stream. Replays collected by a
     * `readHistory` call are consumed there and not re-forwarded.
     * @mode emit
     * @param memberId - the member that sent the update.
     * @param sessionId - the member's session the update belongs to.
     * @param update - one lossless ACP session update.
     */
    'team/member-update'(memberId: string, sessionId: string, update: SessionUpdate): void
    /**
     * A member raised `session/request_permission`. The GUI answers through
     * `team.permission`; with no subscriber the deployment policy answers.
     * @mode emit
     * @param request - the surfaced permission request.
     */
    'team/permission-requested'(request: TeamPermissionRequest): void
    /**
     * A member raised `dsh/user/question`. The GUI answers inline or through
     * `team.answerUserQuestion`; with no subscriber the batch declines.
     * @mode emit
     * @param request - the surfaced question batch.
     */
    'team/user-question'(request: TeamUserQuestionRequest): void
    /**
     * A prompt turn settled: the member answered `session/prompt` (or the
     * connection died and the turn was settled `cancelled` locally). A turn
     * the member rejected with a protocol error carries `error`; consumers
     * must branch on `error` first and treat `stopReason` as a placeholder.
     * @mode emit
     * @param memberId - the member whose turn settled.
     * @param sessionId - the member's session the turn belonged to.
     * @param promptId - the prompt id minted when the turn was accepted.
     * @param stopReason - the ACP stop reason the member returned.
     * @param error - the failure message when the member rejected the prompt.
     */
    'team/turn-end'(memberId: string, sessionId: string, promptId: string, stopReason: StopReason, error?: string): void
  }
}
