/** Read-only By-preset Plugins settings tab, browser half. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.plugins.tab' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { PresetPluginsTab, type PresetPluginsTabInjected } from './PresetPluginsTab.tsx'
import { en, zh, type PresetPluginsLocaleKey } from './locales.ts'

export type { PresetPluginsTabInjected, PresetPluginsTabProps } from './PresetPluginsTab.tsx'
export type { PresetPluginsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only by-preset Plugins settings copy. */
    'settings.pluginPresets': PresetPluginsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginPresets'

/** Services required by the Settings registration and generated API face. */
export const inject = ['slots', 'locale', 'connection']

/** Contribute the lazy by-preset tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-presets: dictionaries')

  const { api } = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)

  const list: PresetPluginsTabInjected['list'] = async () => {
    const response = await api.agentPresets.list({})
    if (!response.result.ok) {
      throw new Error(`agentPresets.list failed: ${response.result.error.code}: ${response.result.error.message}`)
    }
    return response.result.value
  }
  const readEntries: PresetPluginsTabInjected['readEntries'] = async (agentPreset) => {
    const response = await api.agentPresets.readEntries({ agentPreset })
    if (!response.result.ok) {
      throw new Error(`agentPresets.readEntries failed: ${response.result.error.code}: ${response.result.error.message}`)
    }
    return response.result.value
  }
  const injected = (): PresetPluginsTabInjected => ({ list, readEntries })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'by-preset',
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PresetPluginsTab))
}
