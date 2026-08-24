/**
 * Resolve a member's configured spawn specification. The `dsh` kind relaunches
 * the current harness installation with a per-member harness home. The member
 * is self-contained: its home is seeded once at creation with the main
 * instance's settings and credentials (see `member-home.ts`), so it reads only
 * its own home at runtime and carries no `DSH_MAIN_HOME`.
 *
 * @module @deepseek-ai/dsh-team/resolve
 */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { MemberConfigInput, ResolvedMemberSpawnSpec } from './types.ts'

/**
 * Node debug/inspect flags that must not be forwarded to a member process:
 * a member sharing the parent's debug port would collide and fail to start.
 * Both `--flag=value` and `--flag value` spellings are removed.
 */
const INSPECT_FLAGS = new Set([
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--debug',
  '--debug-brk',
  '--debug-port',
])

/** Whether a flag is a Node debug/inspect flag (including `--flag=value`). */
function isInspectFlag(arg: string): boolean {
  if (INSPECT_FLAGS.has(arg)) return true
  return /^--inspect(?:-brk|-port)?=/.test(arg) || /^--debug(?:-brk|-port)?=/.test(arg)
}

/**
 * Remove Node debug/inspect flags from the current process's execArgv. Flags
 * that take a separate value consume that value; `--flag=value` is removed as
 * one token.
 * @param execArgv - the current process's execArgv.
 * @returns execArgv with inspect/debug flags removed.
 */
function removeInspectFlags(execArgv: readonly string[]): string[] {
  const result: string[] = []
  let skipValue = false
  for (const arg of execArgv) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (INSPECT_FLAGS.has(arg)) {
      skipValue = !arg.includes('=')
      continue
    }
    if (isInspectFlag(arg)) continue
    result.push(arg)
  }
  return result
}

/**
 * Resolve the spawn spec for a member configuration. A `kind: 'dsh'` member
 * relaunches the current installation (`process.execPath`, the current script
 * via `process.argv[1]`, `--profile acp`) with `DSH_HOME` set to a per-member
 * directory under the main home. The member is self-contained: its home is
 * seeded once at creation with the main instance's settings and credentials
 * (see `member-home.ts`), so it reads only its own home at runtime and carries
 * no `DSH_MAIN_HOME` — inheriting the main instance at runtime would break that
 * independence. Custom members require `command` and may set `args`.
 *
 * @param config - the member configuration.
 * @returns the resolved spawn spec.
 * @throws when `kind: 'dsh'` is combined with `command`/`args`, when a custom
 * member has no command, or when a preset is set on a member without a harness
 * home to hold it.
 */
export function resolveMemberSpec(config: MemberConfigInput): ResolvedMemberSpawnSpec {
  const hasCommand = config.command !== undefined && config.command.trim().length > 0
  // A preset lives in the member's harness home; only `dsh` members have one,
  // so a preset on any other kind is misconfiguration, not an ignored field.
  if (config.preset !== undefined && config.kind !== 'dsh') {
    throw new Error(`team: member "${config.id}" cannot set preset without kind:'dsh' — only dsh members have a home to hold it`)
  }
  if (config.kind === 'dsh') {
    if (hasCommand) {
      throw new Error(`team: member "${config.id}" cannot set both kind:'dsh' and command`)
    }
    if (config.args !== undefined && config.args.length > 0) {
      throw new Error(`team: member "${config.id}" cannot set args with kind:'dsh'`)
    }
    const mainHome = resolveDshHome()
    const memberHome = join(mainHome, 'members', config.id)
    const script = process.argv[1]
    if (script === undefined) {
      throw new Error(`team: member "${config.id}" cannot resolve the current dsh script (process.argv[1] is undefined)`)
    }
    return {
      command: process.execPath,
      args: [...removeInspectFlags(process.execArgv), script, '--profile', 'acp'],
      env: {
        DSH_HOME: memberHome,
      },
    }
  }
  if (!hasCommand) {
    throw new Error(`team: member "${config.id}" requires command or kind:'dsh'`)
  }
  return {
    command: config.command,
    args: config.args ?? [],
    env: {},
  }
}
