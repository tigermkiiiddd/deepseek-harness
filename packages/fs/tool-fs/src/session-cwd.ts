/**
 * Derive the working directory a filesystem tool resolves relative paths against: the calling
 * agent's per-session workspace. Fixed sessions use their immutable
 * `session.header.cwd`; free sessions use their runtime `session/cwd` value so
 * the directory can switch via `set-cwd`. Non-agent calls return `undefined`,
 * leaving the fallback in the provider rather than reading `process.cwd()`
 * at the tool boundary.
 * @module @deepseek-ai/dsh-tool-fs/session-cwd
 */

import { isAbsolute } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { currentSessionCwd } from '@deepseek-ai/dsh-session'

const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * Fixed sessions return their immutable header cwd; free sessions return their
 * last `session/cwd` value (undefined before the first `set-cwd`).
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @param requestedPath - the path the provider will resolve; parent traversal
 *   makes a symlinked cwd's filesystem identity observable.
 * @returns the effective session cwd, or undefined for a non-agent caller or a
 *   free session with no directory yet.
 */
export function sessionCwd(exec: ToolExecution, requestedPath: string): string | undefined {
  const session = exec.agent?.session
  if (session === undefined) return undefined
  const cwd = currentSessionCwd(session)
  if (cwd === undefined || (!PARENT_PATH_SEGMENT.test(cwd) && !PARENT_PATH_SEGMENT.test(requestedPath))) return cwd
  return canonicalPath(cwd)
}

/**
 * Resolution options shared by all model-facing filesystem tools. A free
 * session (no immutable cwd) that has never recorded a directory rejects a
 * relative path here rather than silently resolving it against the server's
 * `process.cwd()`; an explicit absolute path always passes through.
 * @param exec - the tool-execution context supplying session cwd and cancellation.
 * @param requestedPath - the path the provider will resolve.
 * @param policyWorkspaceRoot - resolved per-call root, when a mutation carries sandbox policy.
 * @returns provider resolution options for the current tool call.
 * @throws when `requestedPath` is relative and the session has no working
 *   directory to resolve it against.
 */
export function sessionResolveOptions(
  exec: ToolExecution,
  requestedPath: string,
  policyWorkspaceRoot?: string,
): { cwd?: string; signal?: AbortSignal } {
  const cwd = policyWorkspaceRoot ?? sessionCwd(exec, requestedPath)
  if (cwd === undefined && policyWorkspaceRoot === undefined && !isAbsolute(requestedPath)) {
    throw new Error('no session working directory: pass an absolute path, or set one with the set_cwd tool')
  }
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}
