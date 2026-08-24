import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMemberHome } from '../src/member-home.ts'

/**
 * Keyless unit tests for the creation-time home seed. No model, no key.
 */

describe('seedMemberHome()', () => {
  const homes: string[] = []
  afterEach(async () => {
    await Promise.all(homes.map(dir => rm(dir, { recursive: true, force: true })))
  })

  /**
   * Create a temp main home seeded with the given document name → contents, and
   * return its path.
   * @param files - document basenames mapped to their text.
   * @returns the temp main home path.
   */
  async function tempMainHome(files: Record<string, string>): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-team-seed-'))
    homes.push(home)
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(home, name), contents, { mode: 0o600 })
    }
    return home
  }

  it('copies settings.yaml and .credentials.yaml into the member home', async () => {
    const home = await tempMainHome({
      'settings.yaml': 'agent-default-model:\n  model: deepseek-chat\n',
      '.credentials.yaml': 'api-key: secret\n',
    })
    await seedMemberHome({ id: 'm1', kind: 'dsh' }, { mainHome: home })
    const member = join(home, 'members', 'm1')
    expect(await readFile(join(member, 'settings.yaml'), 'utf8')).toBe('agent-default-model:\n  model: deepseek-chat\n')
    expect(await readFile(join(member, '.credentials.yaml'), 'utf8')).toBe('api-key: secret\n')
  })

  it('is idempotent: a re-seed does not overwrite the member home', async () => {
    const home = await tempMainHome({ 'settings.yaml': 'original\n', '.credentials.yaml': 'k: v\n' })
    await seedMemberHome({ id: 'm1', kind: 'dsh' }, { mainHome: home })
    const member = join(home, 'members', 'm1')
    // The member rewrote its own setting at runtime; a re-seed must keep it.
    await writeFile(join(member, 'settings.yaml'), 'member-wrote-this\n')
    await seedMemberHome({ id: 'm1', kind: 'dsh' }, { mainHome: home })
    expect(await readFile(join(member, 'settings.yaml'), 'utf8')).toBe('member-wrote-this\n')
  })

  it('skips a missing source file and still seeds the present one', async () => {
    const home = await tempMainHome({ 'settings.yaml': 'only-settings\n' })
    await seedMemberHome({ id: 'm1', kind: 'dsh' }, { mainHome: home })
    const member = join(home, 'members', 'm1')
    expect(await readFile(join(member, 'settings.yaml'), 'utf8')).toBe('only-settings\n')
    await expect(stat(join(member, '.credentials.yaml'))).rejects.toThrow()
  })

  it('creates an empty member home when the main home has no documents', async () => {
    const home = await tempMainHome({})
    await seedMemberHome({ id: 'm1', kind: 'dsh' }, { mainHome: home })
    const member = join(home, 'members', 'm1')
    const info = await stat(member)
    expect(info.isDirectory()).toBe(true)
  })

  it('does not seed a non-dsh member', async () => {
    const home = await tempMainHome({ 'settings.yaml': 'x\n', '.credentials.yaml': 'y\n' })
    // A member with no `kind` is non-`dsh`, so the seed must skip it.
    await seedMemberHome({ id: 'custom', command: 'dsh-acp' }, { mainHome: home })
    await expect(stat(join(home, 'members', 'custom'))).rejects.toThrow()
  })

  it('writes credentials at 0600 on non-Windows', async () => {
    if (process.platform === 'win32') return
    const home = await tempMainHome({ '.credentials.yaml': 'k: v\n' })
    await seedMemberHome({ id: 'm1', kind: 'dsh' }, { mainHome: home })
    const mode = (await stat(join(home, 'members', 'm1', '.credentials.yaml'))).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('seedMemberHome() with a member preset', () => {
  const homes: string[] = []
  afterEach(async () => {
    await Promise.all(homes.map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function tempMainHome(files: Record<string, string>): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-team-seed-preset-'))
    homes.push(home)
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(home, name), contents, { mode: 0o600 })
    }
    return home
  }

  const COMPOSITION = '- id: persona\n  name: some-persona-plugin\n'

  it('installs the composition under the member preset root and makes it the default', async () => {
    const home = await tempMainHome({ 'settings.yaml': 'agent-default-model:\n  model: deepseek-chat\n' })
    await seedMemberHome({ id: 'alice', kind: 'dsh', preset: COMPOSITION }, { mainHome: home })
    const member = join(home, 'members', 'alice')
    // The composition lands where the member's own roster discovers it.
    expect(await readFile(join(member, '.agent-presets', 'alice', 'agent.cordis.yml'), 'utf8')).toBe(COMPOSITION)
    // The member's settings point at its own preset and keep every other section.
    const settings = await readFile(join(member, 'settings.yaml'), 'utf8')
    expect(settings).toContain('agent-default-model:')
    expect(settings).toContain('agent-presets:')
    expect(settings).toMatch(/default:\s*alice/)
  })

  it('derives a safe preset id from an unsanitized member id', async () => {
    const home = await tempMainHome({})
    await seedMemberHome({ id: 'Alice 2', kind: 'dsh', preset: COMPOSITION }, { mainHome: home })
    const member = join(home, 'members', 'Alice 2')
    expect(await readFile(join(member, '.agent-presets', 'alice-2', 'agent.cordis.yml'), 'utf8')).toBe(COMPOSITION)
    expect(await readFile(join(member, 'settings.yaml'), 'utf8')).toMatch(/default:\s*alice-2/)
  })

  it('creates a settings document when the main home has none', async () => {
    const home = await tempMainHome({})
    await seedMemberHome({ id: 'm1', kind: 'dsh', preset: COMPOSITION }, { mainHome: home })
    const settings = await readFile(join(home, 'members', 'm1', 'settings.yaml'), 'utf8')
    expect(settings).toMatch(/default:\s*m1/)
  })

  it('patches a JSON settings document in place', async () => {
    const home = await tempMainHome({ 'settings.json': '{\n  "agent-default-model": {\n    "model": "deepseek-chat"\n  }\n}\n' })
    await seedMemberHome({ id: 'm1', kind: 'dsh', preset: COMPOSITION }, { mainHome: home })
    const settings = JSON.parse(await readFile(join(home, 'members', 'm1', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings).toEqual({
      'agent-default-model': { model: 'deepseek-chat' },
      'agent-presets': { default: 'm1' },
    })
  })

  it('refuses a composition the loader would reject', async () => {
    const home = await tempMainHome({ 'settings.yaml': 'x: y\n' })
    await expect(
      seedMemberHome({ id: 'm1', kind: 'dsh', preset: 'name: not-a-list\n' }, { mainHome: home }),
    ).rejects.toThrow(/unusable preset composition/)
  })

  it('refuses a member id that yields no usable preset id', async () => {
    const home = await tempMainHome({})
    await expect(
      seedMemberHome({ id: '///', kind: 'dsh', preset: COMPOSITION }, { mainHome: home }),
    ).rejects.toThrow(/no usable preset id/)
  })

  it('does not rewrite the member\'s own preset on a re-seed', async () => {
    const home = await tempMainHome({})
    await seedMemberHome({ id: 'm1', kind: 'dsh', preset: COMPOSITION }, { mainHome: home })
    const compositionPath = join(home, 'members', 'm1', '.agent-presets', 'm1', 'agent.cordis.yml')
    // The member (or its operator) edited the composition at runtime; a
    // restart re-seed must keep it, exactly like a settings write.
    await writeFile(compositionPath, '- id: persona\n  name: some-other-plugin\n')
    await seedMemberHome({ id: 'm1', kind: 'dsh', preset: COMPOSITION }, { mainHome: home })
    expect(await readFile(compositionPath, 'utf8')).toBe('- id: persona\n  name: some-other-plugin\n')
  })
})
