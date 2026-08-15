import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'

import {
  apply, findSourceRoot, selfCognitionPrompt, selfCognitionSnapshot,
  inject, name, type SelfCognitionSnapshot,
} from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A minimal Agent stand-in carrying only the session header the tool reads. */
function agentWithPreset(agentPreset: string | undefined): Agent {
  return { session: { header: { ...agentPreset === undefined ? {} : { agentPreset } } } } as unknown as Agent
}

/** A stub Loader service exposing exactly the entries the snapshot maps. */
function loaderStub(entries: unknown[]): Context['loader'] {
  return { entries: () => entries } as unknown as Context['loader']
}

function entry(options: { id: string; name: string; group?: boolean }, disabled = false, state?: number) {
  return {
    id: options.id,
    disabled,
    options: { id: options.id, name: options.name, ...options.group === undefined ? {} : { group: options.group } },
    ...state === undefined ? {} : { fiber: { state } },
  }
}

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function fakeCheckout(): { root: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-self-cognition-'))
  tempDirs.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(root, 'AGENTS.md'), '# agents\n')
  mkdirSync(join(root, 'packages'))
  const nested = join(root, 'packages', 'extensions', 'self-cognition', 'lib')
  mkdirSync(nested, { recursive: true })
  return { root, nested }
}

describe('findSourceRoot', () => {
  it('walks up from a nested module directory to the checkout root', () => {
    const { root, nested } = fakeCheckout()
    expect(findSourceRoot(nested)).toBe(root)
  })

  it('returns undefined when no ancestor carries the checkout markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-self-cognition-empty-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'packages'))
    expect(findSourceRoot(dir)).toBeUndefined()
  })
})

describe('selfCognitionPrompt', () => {
  it('points at source-level self-development when a checkout is available', () => {
    const text = selfCognitionPrompt('/repo')
    expect(text).toContain('/repo')
    expect(text).toContain('self-development')
    expect(text).toContain('never hot-reload')
    expect(text).toContain('cordis-plugin-development')
  })

  it('says self-development is unavailable without a checkout', () => {
    const text = selfCognitionPrompt(undefined)
    expect(text).toContain('self_cognition')
    expect(text).toContain('does not carry the harness source checkout')
    expect(text).not.toContain('self-development` skill for the full workflow')
  })
})

describe('selfCognitionSnapshot', () => {
  it('maps non-group loader entries with their fiber phases', async () => {
    const ctx = new Context()
    ctx.provide('loader', loaderStub([
      entry({ id: 'a', name: 'pkg-a' }, false, 2),
      entry({ id: 'b', name: 'pkg-b' }, true, 0),
      entry({ id: 'c', name: 'pkg-c' }, false, 4),
      entry({ id: 'd', name: 'pkg-d' }),
      entry({ id: 'grp', name: 'pkg-grp', group: true }, false, 2),
    ]))

    const snapshot = await selfCognitionSnapshot(ctx, undefined, '/repo')
    expect(snapshot.plugins).toEqual([
      { id: 'a', name: 'pkg-a', enabled: true, fiberPhase: 'active' },
      { id: 'b', name: 'pkg-b', enabled: false, fiberPhase: 'pending' },
      { id: 'c', name: 'pkg-c', enabled: true, fiberPhase: null },
      { id: 'd', name: 'pkg-d', enabled: true, fiberPhase: null },
    ])
    expect(snapshot.sourceCheckout).toEqual({ available: true, root: '/repo' })
    expect(snapshot.preset).toEqual({
      unavailable: true,
      reason: 'this deployment mounts no agent preset roster',
    })
  })

  it('reports a missing preset selection when the roster is mounted but the session has none', async () => {
    const ctx = new Context()
    ctx.provide('loader', loaderStub([]))
    ctx.provide('agentPresets', { readEntries: async () => [] } as unknown as Context['agentPresets'])

    const snapshot = await selfCognitionSnapshot(ctx, agentWithPreset(undefined), undefined)
    expect(snapshot.sourceCheckout).toEqual({ available: false })
    expect(snapshot.preset).toEqual({
      unavailable: true,
      reason: 'this session was not composed from an agent preset',
    })
  })

  it('resolves the session preset entries through the roster', async () => {
    const ctx = new Context()
    ctx.provide('loader', loaderStub([]))
    ctx.provide('agentPresets', {
      readEntries: async (id: string) => [
        { id: `${id}-row`, name: '@deepseek-ai/dsh-tools', disabled: false },
        { id: 'off-row', name: '@deepseek-ai/dsh-plan', disabled: true },
      ],
    } as unknown as Context['agentPresets'])

    const snapshot = await selfCognitionSnapshot(ctx, agentWithPreset('cordis'), '/repo')
    expect(snapshot.preset).toEqual({
      id: 'cordis',
      entries: [
        { id: 'cordis-row', name: '@deepseek-ai/dsh-tools', disabled: false },
        { id: 'off-row', name: '@deepseek-ai/dsh-plan', disabled: true },
      ],
    })
  })
})

describe('self-cognition plugin', () => {
  async function setup(): Promise<Context> {
    const ctx = new Context()
    ctx.provide('loader', loaderStub([
      entry({ id: 'self-cognition', name: '@deepseek-ai/dsh-self-cognition' }, false, 2),
      entry({ id: 'grp', name: 'group-row', group: true }, false, 2),
    ]))
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin({ name, inject, apply })
    return ctx
  }

  it('registers the harness:self-cognition section and the self_cognition tool', async () => {
    const ctx = await setup()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === 'harness:self-cognition')
    expect(section).toBeDefined()
    expect(section!.text).toContain('self_cognition')

    const schema = ctx.tools.schemas().find(s => s.name === 'self_cognition')
    expect(schema).toBeDefined()
    expect(schema!.description).toContain('live composition')
  })

  it('executes read-only through the registry and projects the loader entries', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('call-1'),
      name: 'self_cognition',
      arguments: {},
      agent: agentWithPreset(undefined),
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected self_cognition success')
    const value = result.value as unknown as SelfCognitionSnapshot
    expect(value.sourceCheckout.available).toBe(true)
    expect(value.plugins).toEqual([
      { id: 'self-cognition', name: '@deepseek-ai/dsh-self-cognition', enabled: true, fiberPhase: 'active' },
    ])
    expect(value.preset).toEqual({
      unavailable: true,
      reason: 'this deployment mounts no agent preset roster',
    })
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('')
    expect(text).toContain('"plugins"')
  })
})
