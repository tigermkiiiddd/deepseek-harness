/** Shared Web and desktop developer-tool preference stored by the Host. */
import z from '@deepseek-ai/schemastery'

/** Namespace for developer UI and HTML preview capabilities. */
export const DEVELOPER_TOOLS_NAMESPACE = 'ui-settings'

/** Persisted developer-tool choice. */
export interface DeveloperToolsSettings {
  /** Enable diagnostic views, preset selection, change summaries and scripted HTML previews. */
  enabled: boolean
  /** Enable dynamic lazy tool folding to optimize KV cache and context tokens. */
  lazyToolFolding?: boolean
  /** Comma-separated or JSON list of custom pinned tool names. */
  pinnedTools?: string
}

/** New installations and missing values enable the full interface. */
export const DeveloperToolsSettingsFields = {
  enabled: z.boolean().default(true),
  lazyToolFolding: z.boolean().default(true),
  pinnedTools: z.string().default(''),
}

/** Schema for shared configuration values. */
export const DeveloperToolsSettingsSchema = z.object(DeveloperToolsSettingsFields)
