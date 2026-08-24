/**
 * Progressive disclosure for large tool catalogs. The registry keeps the
 * authoritative definitions server-side while the model sees a compact
 * catalog and three stable bridge tools.
 * @module @deepseek-ai/dsh-tools/src/lazy-loading
 */

import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from './schema.ts'
import type { ToolDefinition, ToolRunContext, ToolRuntime } from './index.ts'
import type { ToolSdkSchema } from './ts-types.ts'

/** Reserved bridge name used to search the deferred catalog. */
export const TOOL_SEARCH_NAME = 'tool_search'
/** Reserved bridge name used to retrieve one exact deferred schema. */
export const TOOL_DESCRIBE_NAME = 'tool_describe'
/** Reserved bridge name used to invoke one deferred tool. */
export const TOOL_CALL_NAME = 'tool_call'

/** Names reserved by progressive disclosure and unavailable to ordinary tool registrations. */
export const LAZY_BRIDGE_NAMES: ReadonlySet<string> = new Set([
  TOOL_SEARCH_NAME,
  TOOL_DESCRIBE_NAME,
  TOOL_CALL_NAME,
])

/** Activation policy for progressive tool disclosure. */
export type LazyLoadingMode = 'off' | 'auto' | 'on'

/** User-facing configuration accepted by the tool runtime and preset-scoped presentation plugin. */
export interface LazyLoadingConfig {
  /** `off` preserves the legacy full catalog; `auto` gates on schema cost; `on` always defers eligible tools. */
  enabled?: LazyLoadingMode
  /** Estimated deferred-schema tokens that activate `auto` (default 8000). */
  activationThresholdTokens?: number
  /** Maximum approximate tokens used by the compact model-facing listing (default 4000). */
  listingMaxTokens?: number
  /** Registered tools that retain their exact native/SDK schema while lazy loading is active. */
  alwaysVisible?: string[]
}

/** Validated progressive-disclosure configuration with all defaults applied. */
export interface ResolvedLazyLoadingConfig {
  readonly enabled: LazyLoadingMode
  readonly activationThresholdTokens: number
  readonly listingMaxTokens: number
  readonly alwaysVisible: ReadonlySet<string>
}

/** Computed deferred catalog and activation decision for one agent scope. */
export interface LazyLoadingState {
  readonly active: boolean
  readonly deferred: ToolDefinition[]
  readonly estimatedTokens: number
}

const CHARS_PER_TOKEN = 4
const DEFAULT_ACTIVATION_THRESHOLD_TOKENS = 8000
const DEFAULT_LISTING_MAX_TOKENS = 4000
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 20

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return resolved
}

/**
 * Validate progressive-disclosure settings and apply stable defaults.
 * @param config - optional host- or preset-scoped settings.
 * @returns a fully resolved immutable configuration view.
 */
export function resolveLazyLoadingConfig(config: LazyLoadingConfig | undefined): ResolvedLazyLoadingConfig {
  const enabled = config?.enabled ?? 'off'
  return {
    enabled,
    activationThresholdTokens: positiveInteger(
      config?.activationThresholdTokens,
      DEFAULT_ACTIVATION_THRESHOLD_TOKENS,
      'lazyLoading.activationThresholdTokens',
    ),
    listingMaxTokens: positiveInteger(
      config?.listingMaxTokens,
      DEFAULT_LISTING_MAX_TOKENS,
      'lazyLoading.listingMaxTokens',
    ),
    alwaysVisible: new Set(config?.alwaysVisible ?? []),
  }
}

function isInfrastructure(name: string): boolean {
  return name === 'run_code' || LAZY_BRIDGE_NAMES.has(name)
}

function deferredDefinitions(
  definitions: Iterable<ToolDefinition>,
  config: ResolvedLazyLoadingConfig,
): ToolDefinition[] {
  return [...definitions]
    .filter(definition => !isInfrastructure(definition.name) && !config.alwaysVisible.has(definition.name))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/**
 * Approximate provider-token cost of exact deferred definitions without taking a tokenizer dependency.
 * @param definitions - exact definitions eligible for deferral.
 * @returns the estimated provider-token cost.
 */
export function estimateToolSchemaTokens(definitions: Iterable<ToolDefinition>): number {
  let characters = 0
  for (const definition of definitions) {
    characters += definition.name.length + definition.description.length
    const pending: unknown[] = [definition.parameters, definition.output.schema]
    while (pending.length > 0) {
      const value = pending.pop()
      if (value === null) {
        characters += 4
      } else if (typeof value === 'string') {
        characters += value.length + 2
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        characters += String(value).length
      } else if (Array.isArray(value)) {
        characters += value.length + 2
        for (const child of value as unknown[]) pending.push(child)
      } else if (typeof value === 'object') {
        const entries = Object.entries(value)
        characters += entries.length + 2
        for (const [key, child] of entries) {
          characters += key.length + 3
          pending.push(child)
        }
      }
    }
  }
  return Math.ceil(characters / CHARS_PER_TOKEN)
}

/**
 * Resolve whether progressive disclosure is active and which definitions it defers.
 * @param definitions - authoritative definitions visible in the current scope.
 * @param config - validated progressive-disclosure settings.
 * @returns the activation decision and deterministic deferred catalog.
 */
export function resolveLazyLoadingState(
  definitions: Iterable<ToolDefinition>,
  config: ResolvedLazyLoadingConfig,
): LazyLoadingState {
  const deferred = deferredDefinitions(definitions, config)
  if (config.enabled === 'off') return { active: false, deferred: [], estimatedTokens: 0 }
  const estimatedTokens = estimateToolSchemaTokens(deferred)
  const active = deferred.length > 0
    && (config.enabled === 'on' || estimatedTokens >= config.activationThresholdTokens)
  return { active, deferred, estimatedTokens }
}

function compactDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim()
}

/**
 * Render a stable, bounded prompt listing; search remains authoritative when it is truncated.
 * @param state - computed deferred catalog for the current scope.
 * @param config - validated settings that bound the listing size.
 * @returns the model-facing catalog section, or an empty string when inactive.
 */
export function renderLazyCatalog(state: LazyLoadingState, config: ResolvedLazyLoadingConfig): string {
  if (!state.active) return ''
  const heading = [
    '## Deferred tools',
    '',
    `${state.deferred.length} tool definitions stay server-side (~${state.estimatedTokens} tokens avoided).`,
    `Use \`${TOOL_SEARCH_NAME}\` to discover tools, \`${TOOL_DESCRIBE_NAME}\` to read one exact schema, then \`${TOOL_CALL_NAME}\` to invoke it.`,
    'The compact listing below may be truncated; search before concluding that a capability is unavailable.',
    '',
  ]
  const maximumCharacters = config.listingMaxTokens * CHARS_PER_TOKEN
  let text = heading.join('\n')
  let shown = 0
  for (const definition of state.deferred) {
    const description = compactDescription(definition.description)
    const line = `- ${definition.name}${description.length > 0 ? ` — ${description}` : ''}\n`
    if (text.length + line.length > maximumCharacters) break
    text += line
    shown += 1
  }
  if (shown < state.deferred.length) text += `- … ${state.deferred.length - shown} more; use ${TOOL_SEARCH_NAME}\n`
  return text.trimEnd()
}

function searchScore(definition: ToolDefinition, query: string): number {
  const normalized = query.toLowerCase().trim()
  if (normalized.length === 0) return 0
  const name = definition.name.toLowerCase()
  const description = definition.description.toLowerCase()
  const terms = normalized.split(/\s+/).filter(Boolean)
  let score = 0
  if (name === normalized) score += 1000
  if (name.startsWith(normalized)) score += 300
  if (name.includes(normalized)) score += 150
  if (description.includes(normalized)) score += 75
  for (const term of terms) {
    if (name.includes(term)) score += 30
    if (description.includes(term)) score += 10
  }
  return score
}

function renderJson(value: JsonValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Host operations required by the three stable progressive-disclosure bridges. */
export interface LazyBridgeHost {
  state(scope?: ToolRunContext['agent']): LazyLoadingState
  executeUnderlying(name: string, args: JsonValue, exec: ToolRunContext): Promise<JsonValue>
}

/**
 * Build the three reserved bridge definitions inserted outside ordinary registration layers.
 * @param host - scoped catalog lookup and nested dispatch operations.
 * @returns bridge definitions keyed by their reserved names.
 */
export function createLazyBridgeTools(host: LazyBridgeHost): ReadonlyMap<string, ToolDefinition> {
  const search = defineTool({
    name: TOOL_SEARCH_NAME,
    description: 'Search deferred tools by capability, action, object, or exact tool name.',
    parameters: {
      query: { type: 'string', required: true, description: 'Capability or tool to search for.' },
      limit: { type: 'integer', description: `Maximum matches, 1-${MAX_SEARCH_LIMIT}.` },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    execute(args, exec) {
      const query = args.query.trim()
      if (query.length === 0) throw new Error('query must be non-empty')
      const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, args.limit ?? DEFAULT_SEARCH_LIMIT))
      const state = host.state(exec.agent)
      const matches = state.deferred
        .map(definition => ({ definition, score: searchScore(definition, query) }))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score || (a.definition.name < b.definition.name ? -1 : 1))
        .slice(0, limit)
        .map(({ definition }) => ({ name: definition.name, description: definition.description }))
      return Promise.resolve({ query, totalAvailable: state.deferred.length, matches })
    },
  })

  const describe = defineTool({
    name: TOOL_DESCRIBE_NAME,
    description: `Return the exact input and output JSON schemas for one tool found by ${TOOL_SEARCH_NAME}.`,
    parameters: {
      name: { type: 'string', required: true, description: 'Exact deferred tool name.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    execute(args, exec) {
      const definition = host.state(exec.agent).deferred.find(candidate => candidate.name === args.name)
      if (definition === undefined) throw new Error(`deferred tool "${args.name}" is not available in this scope`)
      return Promise.resolve({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters as JsonValue,
        output: definition.output.schema as JsonValue,
      })
    },
  })

  const call = defineTool({
    name: TOOL_CALL_NAME,
    description: `Invoke one deferred tool after reading its schema with ${TOOL_DESCRIBE_NAME}.`,
    parameters: {
      name: { type: 'string', required: true, description: 'Exact deferred tool name.' },
      arguments: { type: 'json', required: true, description: 'Arguments matching the described input schema.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    execute(args, exec) {
      return host.executeUnderlying(args.name, args.arguments, exec)
    },
  })

  return new Map([
    [search.name, search],
    [describe.name, describe],
    [call.name, call],
  ])
}

/**
 * Project one definition into the generated Code Mode SDK contract.
 * @param definition - authoritative internal tool definition.
 * @returns the corresponding SDK schema.
 */
export function definitionToSdkSchema(definition: ToolDefinition): ToolSdkSchema {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output.schema,
  }
}

/**
 * Project one definition into the model-facing wire schema used by lazy native/both modes.
 * @param definition - authoritative internal tool definition.
 * @returns the provider-facing tool schema.
 */
export function definitionToToolSchema(definition: ToolDefinition): ToolSchema {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }
}

/**
 * Execute the real tool beneath the bridge while preserving policy and nested-result semantics.
 * @param registry - authoritative host-plane registry used for nested dispatch.
 * @param stateFor - preset-scoped progressive-disclosure resolver.
 * @param name - exact deferred tool name.
 * @param args - arguments matching the described schema.
 * @param exec - outer bridge execution context.
 * @returns the deferred tool's canonical JSON value.
 */
export async function executeDeferredTool(
  registry: ToolRuntime,
  stateFor: (scope?: ToolRunContext['agent']) => LazyLoadingState,
  name: string,
  args: JsonValue,
  exec: ToolRunContext,
): Promise<JsonValue> {
  const state = stateFor(exec.agent)
  if (!state.active || !state.deferred.some(definition => definition.name === name)) {
    throw new Error(`deferred tool "${name}" is not available in this scope`)
  }
  const result = await registry.execute({
    signal: exec.signal,
    callId: CallId(`${exec.callId}:deferred`),
    rootCallId: exec.rootCallId,
    name,
    arguments: args,
    ...exec.agent === undefined ? {} : { agent: exec.agent },
    parent: exec.token,
  })
  if (result.isError) throw new Error(result.error.message)
  if (result.content.some(block => block.type === 'image')) {
    exec.deferContext(createUserMessage({
      content: result.content,
      source: { kind: 'plugin', plugin: 'tools-lazy-loading' },
    }))
  }
  for (const context of result.additionalContexts ?? []) exec.deferContext(context)
  if (result.concludesTurn) exec.concludeTurn()
  return result.value
}

/**
 * Project the stable bridges into generated Code Mode SDK contracts.
 * @param bridges - bridge definitions keyed by reserved name.
 * @returns SDK schemas in bridge insertion order.
 */
export function lazyBridgeSdkSchemas(bridges: ReadonlyMap<string, ToolDefinition>): ToolSdkSchema[] {
  return [...bridges.values()].map(definitionToSdkSchema)
}
