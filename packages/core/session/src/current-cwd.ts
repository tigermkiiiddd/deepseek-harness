/**
 * Resolve the effective working directory a session's tools default relative
 * paths against. Fixed sessions read their immutable `SessionHeader.cwd`;
 * free sessions (whose header has no `cwd`) read the last durable
 * `session/cwd` event so the directory can change at runtime and survives
 * resume. The fixed branch never consults the log, so an immutable-cwd
 * session is unaffected by any `session/cwd` event a plugin might append.
 * @module @deepseek-ai/dsh-session/current-cwd
 */

import type { Session, SessionEvent } from './index.ts'

/**
 * The effective working directory for `session`, or `undefined` when the
 * session is free (no immutable `header.cwd`) and has never logged one.
 * @param session - the session to resolve; its immutable header and durable
 *   `session/cwd` events are the only inputs read.
 * @returns the immutable header cwd for fixed sessions, the last `session/cwd`
 *   event for free sessions, or `undefined` for a free session with no event.
 */
export function currentSessionCwd(session: Session): string | undefined {
  if (session.header.cwd !== undefined) return session.header.cwd
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const event: SessionEvent | undefined = session.events[i]
    if (event === undefined) continue
    if (event.type === 'session/cwd') return event.data.cwd
  }
  return undefined
}
