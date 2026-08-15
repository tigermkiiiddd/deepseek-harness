/** Locale bundles for the plugin configuration section and its plugin cards. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'configurableTab' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'webSearchExaTitle' | 'webSearchExaDescription'
  | 'webSearchExaApiKey' | 'webSearchExaApiKeyHint' | 'webSearchExaApiKeySet' | 'webSearchExaApiKeyUnset'
  | 'webSearchExaBaseUrl' | 'webSearchExaBaseUrlHint'
  | 'webSearchExaSearchType' | 'webSearchExaSearchTypeHint'
  | 'webSearchExaNumResults' | 'webSearchExaNumResultsHint'
  | 'webSearchExaHighlightsPerResult' | 'webSearchExaHighlightsPerResultHint'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'Configure and inspect the plugins installed in this deployment.',
  tabs: 'Plugin views',
  configurableTab: 'Plugin configuration',
  empty: 'This deployment exposes no plugin settings.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'The DeepSeek search provider.',
  webSearchApiKey: 'API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'Endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
  webSearchExaTitle: 'Web search (Exa)',
  webSearchExaDescription: 'The Exa search provider.',
  webSearchExaApiKey: 'API key',
  webSearchExaApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchExaApiKeySet: 'A key is configured.',
  webSearchExaApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchExaBaseUrl: 'Endpoint',
  webSearchExaBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchExaSearchType: 'Search type',
  webSearchExaSearchTypeHint: 'auto lets Exa choose; keyword or neural force a mode. Leave blank to use the provider default.',
  webSearchExaNumResults: 'Default result count',
  webSearchExaNumResultsHint: 'Sent when a request carries no count of its own. Leave blank to send no default.',
  webSearchExaHighlightsPerResult: 'Highlights per result',
  webSearchExaHighlightsPerResultHint: 'Highlight sentences requested for each result.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '插件',
  title: '插件',
  intro: '配置和查看本部署已安装的插件。',
  tabs: '插件视图',
  configurableTab: '插件配置',
  empty: '本部署没有开放任何插件设置。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  webSearchTitle: '网页搜索',
  webSearchDescription: 'DeepSeek 搜索提供方。',
  webSearchApiKey: 'API Key',
  webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchApiKeySet: '已配置密钥。',
  webSearchApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
  webSearchBaseUrl: '接口地址',
  webSearchBaseUrlHint: '留空则使用提供方默认地址。',
  webSearchMaxUses: '单次请求最多搜索次数',
  webSearchMaxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
  webSearchExaTitle: '网页搜索（Exa）',
  webSearchExaDescription: 'Exa 搜索提供方。',
  webSearchExaApiKey: 'API Key',
  webSearchExaApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchExaApiKeySet: '已配置密钥。',
  webSearchExaApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
  webSearchExaBaseUrl: '接口地址',
  webSearchExaBaseUrlHint: '留空则使用提供方默认地址。',
  webSearchExaSearchType: '搜索类型',
  webSearchExaSearchTypeHint: 'auto 由 Exa 自行选择；keyword 或 neural 强制指定模式。留空则使用提供方默认值。',
  webSearchExaNumResults: '默认结果数',
  webSearchExaNumResultsHint: '请求未自带数量时使用。留空则不发送默认值。',
  webSearchExaHighlightsPerResult: '每条结果高亮句数',
  webSearchExaHighlightsPerResultHint: '为每条结果请求的高亮摘要句子数。',
}
