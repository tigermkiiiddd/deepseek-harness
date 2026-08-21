/**
 * Member-session bridge routing helpers. External ACP agents driven by the
 * team service (packages/team/team) appear as first-class sessions in the Web
 * client under virtual session ids of the form `member:<memberId>:<topicId>`.
 * This module is pure string/contract plumbing and contains no Cordis context
 * access.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/team-sessions
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionsBlock, SessionSummary } from './api/index.ts'

/** Prefix for virtual session ids that address a team member's topic. */
export const MEMBER_SESSION_PREFIX = 'member:'

/**
 * Whether a session id is the member-topic virtual form.
 * @param id - any session id seen on the wire.
 * @returns true when the id carries the `member:` prefix.
 */
export function isMemberSessionId(id: string): boolean {
  return id.startsWith(MEMBER_SESSION_PREFIX)
}

/**
 * Parse one member session id into its owner and topic parts.
 * @param id - a session id, member-virtual or not.
 * @returns the member/topic pair, or undefined for non-member or malformed ids.
 */
export function parseMemberSessionId(id: string): { memberId: string; topicId: string } | undefined {
  if (!isMemberSessionId(id)) return undefined
  const rest = id.slice(MEMBER_SESSION_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon === -1) return undefined
  const memberId = rest.slice(0, colon)
  const topicId = rest.slice(colon + 1)
  if (memberId.length === 0 || topicId.length === 0) return undefined
  return { memberId, topicId }
}

/**
 * Build the canonical virtual session id for one member topic.
 * @param memberId - the roster id of the member owning the topic.
 * @param topicId - the topic id inside the member's own session store.
 * @returns the `member:<memberId>:<topicId>` session id.
 */
export function makeMemberSessionId(memberId: string, topicId: string): SessionId {
  return `${MEMBER_SESSION_PREFIX}${memberId}:${topicId}` as SessionId
}

/**
 * The member owning one session id, when it is member-virtual.
 * @param id - a session id, member-virtual or not.
 * @returns the owning member id, or undefined for main-instance sessions.
 */
export function memberSessionOwner(id: string): string | undefined {
  return parseMemberSessionId(id)?.memberId
}

/**
 * Human-facing label for a member topic, shown as the session title fallback.
 * @param memberTitle - the member's configured display title.
 * @param topicId - the topic id inside the member's own session store.
 * @returns the composed label `<memberTitle> · <topicId>`.
 */
export function memberSessionDisplayTitle(memberTitle: string, topicId: string): string {
  return `${memberTitle} · ${topicId}`
}

/**
 * Shape one member topic into the SessionSummary the client session list expects.
 * @param memberId - the roster id of the member owning the topic.
 * @param topic - the member's own topic record (its session id, workspace, and optional title/updatedAt from the member).
 * @param options - projection inputs: list ordering timestamp, live turn flag, and the member's configured display title.
 * @returns the summary row for the virtual `member:` session id.
 */
export function memberTopicSummary(
  memberId: string,
  topic: { sessionId: string; cwd: string; title?: string | undefined; updatedAt?: string | undefined },
  options: {
    updatedAt: number
    running: boolean
    memberTitle: string
  },
): SessionSummary {
  const sessionId = makeMemberSessionId(memberId, topic.sessionId)
  const topicLabel = topic.title !== undefined && topic.title.length > 0 ? topic.title : topic.sessionId
  const title = memberSessionDisplayTitle(options.memberTitle, topicLabel)
  const projections: SessionProjectionsBlock | undefined = {
    asOfSeq: -1,
    values: { title },
  }
  return {
    sessionId,
    updatedAt: options.updatedAt,
    running: options.running,
    blank: false,
    cwd: topic.cwd,
    projections,
  }
}
