/**
 * Reading a preset's plugin entries for the browser viewer.
 *
 * The browser needs the effective entry list: groups flattened, disabled state
 * propagated from ancestor groups, and `!!js` expressions evaluated so the
 * viewer shows the same on/off state the loader would apply at mount time.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AgentPresets, { COMPOSITION_FILE } from '@deepseek-ai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

let ctx: Context
let userRoot: string

/**
 * Hand-craft a preset directory under the user root so `readEntries` can read
 * arbitrary compositions without going through the copy API.
 */
async function seedPreset(id: string, composition: string): Promise<void> {
  await mkdir(join(userRoot, id), { recursive: true })
  await writeFile(join(userRoot, id, COMPOSITION_FILE), composition)
}

beforeEach(async () => {
  userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-read-entries-'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [
      { path: join(FIXTURES, 'system'), trust: 'system' as const },
      { path: userRoot, trust: 'user' as const },
    ],
    includeUserRoot: false,
  })
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('readEntries', () => {
  it('returns top-level plugin rows in order', async () => {
    await seedPreset('flat', '- id: a\n  name: plugin-a\n- id: b\n  name: plugin-b\n')

    const entries = await ctx.agentPresets.readEntries('flat')

    expect(entries).toEqual([
      { id: 'a', name: 'plugin-a', disabled: false },
      { id: 'b', name: 'plugin-b', disabled: false },
    ])
  })

  it('flattens cordis:group rows and skips the group container', async () => {
    await seedPreset('grouped', `
- id: a
  name: plugin-a
- id: grp
  name: cordis:group
  group: true
  config:
    - id: b
      name: plugin-b
    - id: c
      name: plugin-c
`)

    const entries = await ctx.agentPresets.readEntries('grouped')

    expect(entries).toEqual([
      { id: 'a', name: 'plugin-a', disabled: false },
      { id: 'b', name: 'plugin-b', disabled: false },
      { id: 'c', name: 'plugin-c', disabled: false },
    ])
  })

  it('propagates ancestor group disabled state to descendants', async () => {
    await seedPreset('ancestor-off', `
- id: grp
  name: cordis:group
  group: true
  disabled: true
  config:
    - id: child
      name: plugin-child
`)

    const entries = await ctx.agentPresets.readEntries('ancestor-off')

    expect(entries).toEqual([
      { id: 'child', name: 'plugin-child', disabled: true },
    ])
  })

  it('lets an ancestor disabled override an explicit child enabled', async () => {
    await seedPreset('ancestor-wins', `
- id: grp
  name: cordis:group
  group: true
  disabled: true
  config:
    - id: child
      name: plugin-child
      disabled: false
`)

    const entries = await ctx.agentPresets.readEntries('ancestor-wins')

    expect(entries).toEqual([
      { id: 'child', name: 'plugin-child', disabled: true },
    ])
  })

  it('propagates through nested groups', async () => {
    await seedPreset('nested', `
- id: outer
  name: cordis:group
  group: true
  disabled: true
  config:
    - id: inner
      name: cordis:group
      group: true
      config:
        - id: leaf
          name: plugin-leaf
`)

    const entries = await ctx.agentPresets.readEntries('nested')

    expect(entries).toEqual([
      { id: 'leaf', name: 'plugin-leaf', disabled: true },
    ])
  })

  it('evaluates !!js disabled expressions against the current platform', async () => {
    const isWin = process.platform === 'win32'
    await seedPreset('platform', `
- id: platform-row
  name: plugin-platform
  disabled: !!js process.platform === 'win32'
`)

    const entries = await ctx.agentPresets.readEntries('platform')

    expect(entries).toEqual([
      { id: 'platform-row', name: 'plugin-platform', disabled: isWin },
    ])
  })

  it('treats missing and null disabled as false', async () => {
    await seedPreset('defaults', `
- id: missing
  name: plugin-missing
- id: nullish
  name: plugin-nullish
  disabled: null
`)

    const entries = await ctx.agentPresets.readEntries('defaults')

    expect(entries.every(entry => !entry.disabled)).toBe(true)
  })

  it('falls back name to id when the row omits one', async () => {
    await seedPreset('no-name', '- id: unnamed\n')

    const entries = await ctx.agentPresets.readEntries('no-name')

    expect(entries).toEqual([
      { id: 'unnamed', name: 'unnamed', disabled: false },
    ])
  })

  it('falls back both id and name to empty string for an anomalous row', async () => {
    await seedPreset('anomaly', '- name: plugin-anomaly\n')

    const entries = await ctx.agentPresets.readEntries('anomaly')

    expect(entries).toEqual([
      { id: '', name: 'plugin-anomaly', disabled: false },
    ])
  })

  it('treats a group with non-list config as having no children', async () => {
    await seedPreset('bad-config', `
- id: lone
  name: plugin-lone
- id: bad-group
  name: cordis:group
  group: true
  config: not-a-list
`)

    const entries = await ctx.agentPresets.readEntries('bad-config')

    expect(entries).toEqual([
      { id: 'lone', name: 'plugin-lone', disabled: false },
    ])
  })

  it('throws UnknownPresetError for an unknown id', async () => {
    await expect(ctx.agentPresets.readEntries('never-existed'))
      .rejects.toThrow(/not found/)
  })

  it('reads shipped presets the same way', async () => {
    const entries = await ctx.agentPresets.readEntries('standard')

    expect(entries).toContainEqual({ id: 'alpha', name: '../../plugins/contribute.js', disabled: false })
    expect(entries).toContainEqual({ id: 'alpha-extra', name: '../../plugins/contribute.js', disabled: true })
  })

  it('rejects a composition that is not a top-level list', async () => {
    await seedPreset('bad-shape', 'name: not-a-list\n')

    await expect(ctx.agentPresets.readEntries('bad-shape'))
      .rejects.toThrow(/not a top-level list/)
  })

  it('falls back name to empty string when both id and name are absent', async () => {
    await seedPreset('bare', '- disabled: true\n')

    const entries = await ctx.agentPresets.readEntries('bare')

    expect(entries).toEqual([
      { id: '', name: '', disabled: true },
    ])
  })
})
