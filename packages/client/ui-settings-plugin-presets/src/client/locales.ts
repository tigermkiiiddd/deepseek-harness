/** Copy dictionaries for the by-preset Plugins settings tab. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '按预设',
  loading: '正在读取预设…',
  error: '暂时无法读取预设。',
  retry: '重试',
  empty: '暂无预设。',
  defaultBadge: '默认',
  trustSystem: '系统',
  trustUser: 'user',
  broken: '无法加载',
  entries: '插件条目',
  disabledMarker: '已停用',
  readEntriesError: '无法读取条目',
} satisfies Record<string, string>

/** Plugin-presets locale key union. */
export type PresetPluginsLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'By preset',
  loading: 'Reading presets…',
  error: 'Presets are temporarily unavailable.',
  retry: 'Retry',
  empty: 'No presets are available.',
  defaultBadge: 'Default',
  trustSystem: 'system',
  trustUser: 'user',
  broken: 'Unavailable',
  entries: 'Plugin entries',
  disabledMarker: 'Disabled',
  readEntriesError: 'Could not read entries',
} satisfies Record<PresetPluginsLocaleKey, string>
