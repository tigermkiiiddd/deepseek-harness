/**
 * Model-facing `set-cwd` tool: change the effective working directory a free
 * session's tools resolve relative paths against. Fixed sessions (whose
 * `SessionHeader.cwd` is present) are immutable and reject the call; free
 * sessions append a durable `session/cwd` event so the directory survives
 * resume and replay. The tool performs no filesystem I/O — it only records the
 * working-directory intent that the shared resolution path reads.
 * @module @deepseek-ai/dsh-tool-fs/src/set-cwd
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Append a durable `session/cwd` event to `session`, rejecting a fixed session
 * whose working directory is immutable and an unknown-owner (no-session) call.
 * @param session - the calling agent's session; must be free (no `header.cwd`).
 * @param cwd - the absolute directory to switch to.
 * @returns the accepted absolute path.
 */
function applySetCwd(session: Session, cwd: string): string {
  if (session.header.cwd !== undefined) {
    throw new Error('set-cwd cannot change a fixed session: its working directory is set at creation. Create a free (no-cwd) session to switch directories.')
  }
  if (cwd.trim().length === 0 || !isAbsolute(cwd)) {
    throw new Error(`set-cwd requires an absolute directory, got "${cwd}"`)
  }
  session.append('session/cwd', { cwd: cwd.trim() })
  return cwd.trim()
}

/**
 * Register the `set-cwd` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 */
export function applySetCwdTool(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:set-cwd',
    order: 101,
    text: 'Use the set-cwd tool to change the working directory a free (no-cwd) session resolves relative paths against. Fixed sessions inherit their immutable creation directory. In a free session under workspace-write policy, the writable boundary IS the current working directory: it moves with every set-cwd call, so only files under the directory most recently set are modifiable.',
  })

  ctx.tools.register(defineTool({
    name: 'set_cwd',
    description: 'Set the working directory a free session resolves relative paths against. Absolute path required. Rejects fixed (immutable-cwd) sessions. Under workspace-write file policy this directory is also the writable boundary: moving the cwd moves what the session may modify.',
    parameters: {
      cwd: { type: 'string', required: true, description: 'The absolute directory to switch to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Working directory set to ${value.cwd}` }],
      presentationMeta: (_args, value) => ({ cwd: value.cwd }),
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('set-cwd requires a calling session')
      }
      const cwd = applySetCwd(session, args.cwd)
      return Promise.resolve({ cwd })
    },
  }))
}
