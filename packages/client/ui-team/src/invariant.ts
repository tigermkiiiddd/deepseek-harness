/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-team`.
 * @module @deepseek-ai/dsh-client-ui-team/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-team'

/** Cordis companion plugin name. */
export const name = 'ui-team-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the team view is a read/drive facade over the team
 * service, which owns all mutable member state; the slot registry and RPC
 * bridge enforce their own uniqueness.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
