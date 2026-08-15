/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-self-cognition`.
 * @module @deepseek-ai/dsh-tool-self-cognition/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-self-cognition'

/** Cordis companion plugin name. */
export const name = 'self-cognition-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns no event stream or mutable runtime
 * data — it contributes one static prompt section and one read-only tool that
 * re-reads the Loader and preset roster on every call, so there is no owned
 * relationship a periodic check could assert; behavior is enforced by unit
 * tests.
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
