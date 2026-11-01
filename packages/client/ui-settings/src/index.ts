/** Host registration of shared Web and desktop developer-tool preferences. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'
import { DeveloperToolsSettingsFields } from './developer-tools-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Whether developer tools are enabled. */
  enabled: Volatile<boolean>
  /** Whether lazy tool folding is enabled. */
  lazyToolFolding?: Volatile<boolean>
  /** Pinned tools list. */
  pinnedTools?: Volatile<string>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  enabled: DeveloperToolsSettingsFields['enabled'].volatile(),
  lazyToolFolding: DeveloperToolsSettingsFields['lazyToolFolding'].volatile(),
  pinnedTools: DeveloperToolsSettingsFields['pinnedTools'].volatile(),
})

/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
