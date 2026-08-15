/**
 * Self-cognition entry: a system-prompt section telling the agent it can
 * evolve by editing its own source checkout, and a read-only `self_cognition`
 * tool reporting the live composition (source root, active preset, plugins).
 * @module @deepseek-ai/dsh-tool-self-cognition
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-self-cognition'
export const inject = ['loader', 'systemPrompt', 'tools']

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Model-facing phase of one plugin fiber; a disposed entry has no live phase. */
export type FiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, FiberPhase>

/** One mounted non-group plugin row of the caller's own composition. */
export interface SelfCognitionPluginRow {
  id: string
  name: string
  enabled: boolean
  fiberPhase: FiberPhase
}

/** The `self_cognition` canonical value; every field is read live per call. */
export interface SelfCognitionSnapshot {
  sourceCheckout: { available: true; root: string } | { available: false }
  preset:
    | { id: string; entries: { id: string; name: string; disabled: boolean }[] }
    | { unavailable: true; reason: string }
  plugins: SelfCognitionPluginRow[]
}

/** Marker set identifying the harness source checkout root. */
const CHECKOUT_MARKERS = ['pnpm-workspace.yaml', 'AGENTS.md', 'packages'] as const

/**
 * Walk up from `startDir` to the harness source checkout root.
 * @param startDir - directory of this package's own module.
 * @returns the checkout root, or `undefined` when the deployment carries no
 *   source checkout (an installed profile is a normal deployment, not an
 *   error).
 */
export function findSourceRoot(startDir: string): string | undefined {
  let dir = startDir
  while (true) {
    if (CHECKOUT_MARKERS.every(marker => existsSync(join(dir, marker)))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Render the `harness:self-cognition` prompt section for one deployment.
 * @param sourceRoot - the detected checkout root, if any.
 * @returns the section text; the unavailable variant says so plainly instead
 *   of advertising a source-editing path that does not exist here.
 */
export function selfCognitionPrompt(sourceRoot: string | undefined): string {
  if (sourceRoot === undefined) {
    return '## Self-cognition\n\n'
      + 'You are running on DeepSeek Harness. The `self_cognition` tool reports your live composition: '
      + 'mounted plugins and the agent preset this session was composed from. This deployment does not '
      + 'carry the harness source checkout, so source-level self-development is unavailable here; '
      + 'temporary or session-scoped extensions can still be built as dynamic Cordis plugins — load the '
      + '`cordis-plugin-development` skill for those.'
  }
  return '## Self-cognition and self-development\n\n'
    + `You are running on DeepSeek Harness from its source checkout at ${sourceRoot}. You can evolve `
    + 'yourself permanently by editing that checkout: read `AGENTS.md` and `docs/architecture.md` first, '
    + 'then load the `self-development` skill for the full workflow. Source changes take effect on the '
    + 'next process start; they never hot-reload into this session.\n\n'
    + 'The `self_cognition` tool reports your live composition: mounted plugins, the agent preset this '
    + 'session was composed from, and its plugin entries.\n\n'
    + 'Temporary, session-scoped, or experimental extensions belong to dynamic Cordis plugins instead — '
    + 'load the `cordis-plugin-development` skill for those, and do not edit the checkout for one-off needs.'
}

/**
 * Build the `self_cognition` canonical value from live services.
 * @param ctx - the plugin's own context (loader and preset roster reads).
 * @param agent - the calling agent, when the loop supplies one.
 * @param sourceRoot - the checkout root detected at mount time.
 * @returns the live composition snapshot.
 */
export async function selfCognitionSnapshot(
  ctx: Context,
  agent: Agent | undefined,
  sourceRoot: string | undefined,
): Promise<SelfCognitionSnapshot> {
  const plugins: SelfCognitionPluginRow[] = []
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    plugins.push({
      id: entry.id,
      name: entry.options.name,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
    })
  }

  const presets = ctx.get('agentPresets')
  const presetId = agent?.session.header.agentPreset
  let preset: SelfCognitionSnapshot['preset']
  if (presets === undefined) {
    preset = { unavailable: true, reason: 'this deployment mounts no agent preset roster' }
  } else if (presetId === undefined) {
    preset = { unavailable: true, reason: 'this session was not composed from an agent preset' }
  } else {
    const entries = await presets.readEntries(presetId)
    preset = { id: presetId, entries: entries.map(({ id, name: entryName, disabled }) => ({ id, name: entryName, disabled })) }
  }

  return {
    sourceCheckout: sourceRoot === undefined ? { available: false } : { available: true, root: sourceRoot },
    preset,
    plugins,
  }
}

/** Register the prompt section and the read-only `self_cognition` tool. */
export function apply(ctx: Context): void {
  const sourceRoot = findSourceRoot(dirname(fileURLToPath(import.meta.url)))

  ctx.systemPrompt.section({
    name: 'harness:self-cognition',
    order: -97,
    text: selfCognitionPrompt(sourceRoot),
  })

  ctx.tools.register(defineTool({
    name: 'self_cognition',
    description:
      'Report this agent\'s live composition: whether a harness source checkout is available and where, '
      + 'the agent preset this session was composed from with its plugin entries, and every mounted '
      + 'plugin with its enabled state and fiber phase. Read-only; call it to answer "what am I made of" '
      + 'before any self-development work.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceCheckout: {
            oneOf: [
              {
                type: 'object', additionalProperties: false,
                properties: {
                  available: { type: 'boolean', const: true, required: true },
                  root: { type: 'string', required: true },
                },
              },
              {
                type: 'object', additionalProperties: false,
                properties: {
                  available: { type: 'boolean', const: false, required: true },
                },
              },
            ],
            required: true,
          },
          preset: {
            oneOf: [
              {
                type: 'object', additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  entries: {
                    type: 'array', required: true,
                    items: {
                      type: 'object', additionalProperties: false,
                      properties: {
                        id: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                        disabled: { type: 'boolean', required: true },
                      },
                    },
                  },
                },
              },
              {
                type: 'object', additionalProperties: false,
                properties: {
                  unavailable: { type: 'boolean', const: true, required: true },
                  reason: { type: 'string', required: true },
                },
              },
            ],
            required: true,
          },
          plugins: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                fiberPhase: {
                  oneOf: [
                    { type: 'string', enum: ['pending', 'loading', 'active', 'failed', 'unloading'] },
                    { type: 'null' },
                  ],
                  required: true,
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute: (_args, exec) => selfCognitionSnapshot(ctx, exec.agent, sourceRoot),
  }))
}
