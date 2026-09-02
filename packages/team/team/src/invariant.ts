/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-team`.
 * @module @deepseek-ai/dsh-team/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { MemberStatus } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-team'

/** Cordis companion plugin name. */
export const name = 'team-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: every `team/status` migration must be observable on the
 * roster snapshot at emission time. The connection updates its state before
 * the service emits, so a listener seeing a different status proves an
 * emitting path bypassed the connection's state (or a view mutated the
 * snapshot out from under the service). A member removed between the emit and
 * the listener's read is not a violation — removal always follows a settled
 * stop that already emitted the terminal status.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('team/status', (memberId: string, status: MemberStatus, error?: string) => {
      const team = ctx.get('team')
      if (team === undefined) return
      const snapshot = team.list().find(member => member.id === memberId)
      if (snapshot === undefined) return
      if (snapshot.status !== status || snapshot.lastError !== error) {
        fail(
          `team/status for "${memberId}" announced ${status} but the roster snapshot reports `
          + `${snapshot.status} — an emitting path bypassed the connection's state`,
        )
      }
    })
  },
  { inject: ['team'] },
)

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
