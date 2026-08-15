/**
 * Derive the workspace root an `lsp` call resolves against: the calling agent's effective
 * per-session workspace (`currentSessionCwd`: immutable header cwd, or the `set_cwd` value
 * for a free session), mirroring how the filesystem tools resolve paths.
 * Unlike those tools, LSP has NO provider fallback — a missing cwd fails the call as
 * `LSP_WORKSPACE_REQUIRED`, because the local provider must canonicalize a real workspace before it
 * can start a server.
 * @module @deepseek-ai/dsh-tool-lsp/session-cwd
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { currentSessionCwd } from '@deepseek-ai/dsh-session'

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling session's effective cwd, or undefined for a non-agent caller.
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  const session = exec.agent?.session
  return session === undefined ? undefined : currentSessionCwd(session)
}
