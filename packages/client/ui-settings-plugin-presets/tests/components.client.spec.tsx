// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresetPluginsTab } from '../src/client/PresetPluginsTab.tsx'
import type {
  PresetPluginsTabInjected,
  PresetPluginsTabProps,
} from '../src/client/PresetPluginsTab.tsx'
import { en, type PresetPluginsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type ListValue = Awaited<ReturnType<PresetPluginsTabInjected['list']>>
type ReadEntriesValue = Awaited<ReturnType<PresetPluginsTabInjected['readEntries']>>
const t = ((key: PresetPluginsLocaleKey): string => en[key]) as PresetPluginsTabProps['t']

function props(
  list: PresetPluginsTabInjected['list'],
  readEntries: PresetPluginsTabInjected['readEntries'],
): PresetPluginsTabProps {
  return {
    t,
    list,
    readEntries,
  } as PresetPluginsTabProps
}

const PRESETS: ListValue = {
  presets: [
    { id: 'standard', trust: 'system', isDefault: true, name: 'Standard', description: 'Shipped preset' },
    { id: 'custom', trust: 'user', isDefault: false, name: 'My preset' },
    { id: 'broken-preset', trust: 'user', isDefault: false, name: 'Broken', broken: 'missing composition' },
    { id: 'nameless', trust: 'system', isDefault: false },
    { id: 'empty-entries', trust: 'user', isDefault: false, name: 'Empty' },
  ],
  authorable: true,
  hasDocument: false,
}

const ENTRIES: Record<string, ReadEntriesValue> = {
  standard: {
    agentPreset: 'standard',
    trust: 'system',
    entries: [
      { id: 'bash', name: '@deepseek-ai/dsh-host-directory-picker-native', disabled: false },
      { id: 'web-search', name: '@deepseek-ai/dsh-client-ui-settings-plugins', disabled: true },
    ],
  },
  custom: {
    agentPreset: 'custom',
    trust: 'user',
    entries: [
      { id: 'loop', name: 'cordis:agent-loop', disabled: false },
    ],
  },
  'empty-entries': {
    agentPreset: 'empty-entries',
    trust: 'user',
    entries: [],
  },
}

describe('PresetPluginsTab', () => {
  it('renders one collapsible card per preset with badges and entries', async () => {
    const list = vi.fn(async () => PRESETS)
    const readEntries = vi.fn(async (id: string) => ENTRIES[id] ?? {
      agentPreset: id,
      trust: 'system' as const,
      entries: [{ id: 'fallback', name: 'fallback', disabled: false }],
    })
    const view = render(<PresetPluginsTab {...props(list, readEntries)} />)

    expect(screen.getByText(en.loading)).toBeTruthy()
    await waitFor(() => { expect(screen.getAllByRole('listitem')).toHaveLength(5) })

    expect(list).toHaveBeenCalledOnce()
    expect(readEntries).toHaveBeenCalledTimes(4)
    expect(readEntries).not.toHaveBeenCalledWith('broken-preset')

    expect(screen.getByRole('button', { name: 'Standard, system, Default' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'My preset, user' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Broken, user' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'nameless, system' })).toBeTruthy()

    const standard = screen.getByRole('button', { name: 'Standard, system, Default' })
    expect(standard.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(standard)
    expect(standard.getAttribute('aria-expanded')).toBe('true')

    expect(screen.getByText('directory-picker-native')).toBeTruthy()
    expect(screen.getByText('ui-settings-plugins')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByText('web-search')).toBeTruthy()
    expect(screen.getByText(en.disabledMarker)).toBeTruthy()

    fireEvent.click(standard)
    expect(view.container.querySelector('[data-entry-id]')).toBeNull()
  })

  it('shows empty entries and a nameless preset fallback', async () => {
    const list = vi.fn(async () => PRESETS)
    const readEntries = vi.fn(async (id: string) => ENTRIES[id]!)
    render(<PresetPluginsTab {...props(list, readEntries)} />)

    const empty = await screen.findByRole('button', { name: 'Empty, user' })
    fireEvent.click(empty)
    expect(screen.getByText(en.entries)).toBeTruthy()
  })

  it('shows the broken reason instead of entries for broken presets', async () => {
    const list = vi.fn(async () => PRESETS)
    const readEntries = vi.fn(async (id: string) => ENTRIES[id]!)
    render(<PresetPluginsTab {...props(list, readEntries)} />)

    const broken = await screen.findByRole('button', { name: 'Broken, user' })
    fireEvent.click(broken)
    expect(screen.getByText('missing composition')).toBeTruthy()
    expect(screen.queryByText(en.entries)).toBeNull()
  })

  it('shows a per-preset read error without sinking the roster', async () => {
    const list = vi.fn(async () => PRESETS)
    const readEntries = vi.fn(async (id: string) => {
      if (id === 'standard') throw new Error('preset not found')
      if (id === 'nameless') throw 'string failure'
      return ENTRIES[id]!
    })
    render(<PresetPluginsTab {...props(list, readEntries)} />)

    const standard = await screen.findByRole('button', { name: 'Standard, system, Default' })
    fireEvent.click(standard)
    expect(screen.getByText('preset not found')).toBeTruthy()
    expect(screen.queryByText('directory-picker-native')).toBeNull()

    const nameless = screen.getByRole('button', { name: 'nameless, system' })
    fireEvent.click(nameless)
    expect(screen.getByText('string failure')).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: 'My preset, user' }))
    expect(screen.getByText('loop')).toBeTruthy()
  })

  it('shows empty roster when no presets exist', async () => {
    const list = vi.fn(async (): Promise<ListValue> => ({ presets: [], authorable: false, hasDocument: false }))
    const readEntries = vi.fn(async (): Promise<ReadEntriesValue> => ({ agentPreset: '', trust: 'system', entries: [] }))
    render(<PresetPluginsTab {...props(list, readEntries)} />)

    expect(await screen.findByText(en.empty)).toBeTruthy()
    expect(readEntries).not.toHaveBeenCalled()
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<PresetPluginsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ presets: [], authorable: false, hasDocument: false })
    const readEntries = vi.fn(async (): Promise<ReadEntriesValue> => ({ agentPreset: '', trust: 'system', entries: [] }))
    render(<PresetPluginsTab {...props(list, readEntries)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('ignores results after unmount', async () => {
    const deferred = Promise.withResolvers<ListValue>()
    const list = vi.fn(() => deferred.promise)
    const readEntries = vi.fn(async (): Promise<ReadEntriesValue> => ({ agentPreset: '', trust: 'system', entries: [] }))
    const pending = render(<PresetPluginsTab {...props(list, readEntries)} />)
    pending.unmount()
    await act(async () => { deferred.resolve(PRESETS) })
  })
})
