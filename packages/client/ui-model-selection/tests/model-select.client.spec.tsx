// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { recordModelRecent } from '../src/client/recents.ts'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  // The recency store is localStorage-backed and jsdom storage outlives tests.
  localStorage.clear()
})

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek · DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek · DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('labels the trigger with the provider so same-named models on two routes read apart', () => {
    const groups = [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
      },
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
      },
    ]
    const directory = createSnapshotStore(state({
      groups,
      current: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    // The model id alone cannot say which route serves it; the provider group
    // name in the trigger is what makes an unintended route visible.
    expect(screen.getByRole('button', { name: '选择模型，当前 OpenCode Go · DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Provider · Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect recent selections', () => {
  const groups = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    },
  ]

  function mountWith(current: ModelSelection): ReturnType<typeof render> {
    const mounted = render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({ groups, current }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    return mounted
  }

  it('pins recent selections above the groups with the provider suffix', () => {
    recordModelRecent({ provider: 'opencode-go', model: 'deepseek-v4-pro' })
    recordModelRecent({ provider: 'opencode-go', model: 'deepseek-v4-flash' })
    mountWith({ provider: 'opencode-go', model: 'deepseek-v4-flash' })

    const recent = screen.getByRole('group', { name: '最近使用' })
    // Most recent first, and every row names its provider route — the same
    // model id served by two routes must read apart in the section too.
    expect(within(recent).getAllByRole('menuitemradio').map(row => row.textContent)).toEqual([
      'OpenCode Go · DeepSeek-V4-Flash',
      'OpenCode Go · DeepSeek-V4-Pro',
    ])
    expect(within(recent).getByRole('menuitemradio', { name: 'OpenCode Go · DeepSeek-V4-Flash' })
      .getAttribute('aria-checked')).toBe('true')
    // The groups follow the section, unchanged.
    expect(within(screen.getByRole('group', { name: 'DeepSeek' })).getAllByRole('menuitemradio'))
      .toHaveLength(1)
  })

  it('reads a stored pick its catalog dropped as raw ids and keeps it selectable', () => {
    recordModelRecent({ provider: 'gone-route', model: 'gone-model' })
    const select = vi.fn(async () => true)
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({ groups, current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }))}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))

    const row = within(screen.getByRole('group', { name: '最近使用' }))
      .getByRole('menuitemradio', { name: 'gone-route · gone-model' })
    fireEvent.click(row)
    return waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'gone-route', model: 'gone-model' })
    })
  })

  it('submits the stored provider/model pair from a recent row', async () => {
    recordModelRecent({ provider: 'opencode-go', model: 'deepseek-v4-pro' })
    const select = vi.fn(async () => true)
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({ groups, current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }))}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))

    fireEvent.click(within(screen.getByRole('group', { name: '最近使用' }))
      .getByRole('menuitemradio', { name: 'OpenCode Go · DeepSeek-V4-Pro' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'opencode-go', model: 'deepseek-v4-pro' })
    })
  })

  it('yields the card to matching groups while a filter is active', () => {
    recordModelRecent({ provider: 'opencode-go', model: 'deepseek-v4-pro' })
    mountWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    const search = screen.getByLabelText('搜索模型…')
    fireEvent.change(search, { target: { value: 'pro' } })
    expect(screen.queryByRole('group', { name: '最近使用' })).toBeNull()
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByRole('group', { name: '最近使用' })).toBeTruthy()
  })

  it('shows at most the five most recent picks', () => {
    for (let index = 0; index < 7; index++) {
      recordModelRecent({ provider: 'p', model: `m${String(index)}` })
    }
    mountWith({ provider: 'p', model: 'm6' })

    const recent = screen.getByRole('group', { name: '最近使用' })
    expect(within(recent).getAllByRole('menuitemradio')).toHaveLength(5)
    // The oldest pick aged out; the newest leads.
    expect(within(recent).queryByRole('menuitemradio', { name: 'p · m0' })).toBeNull()
    expect(within(recent).getAllByRole('menuitemradio')[0]?.textContent).toBe('p · m6')
  })
})

describe('ModelSelect search filter', () => {
  const groups = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      models: [{ id: 'm2.7', name: 'MiniMax M2.7' }],
    },
  ]

  function mount(): void {
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({ groups }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
  }

  const search = () => screen.getByLabelText<HTMLInputElement>('搜索模型…')

  it('filters by model name and id, and keeps a group whole when its name matches', () => {
    mount()

    fireEvent.change(search(), { target: { value: 'pro' } })
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Pro' })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /Flash/ })).toBeNull()
    expect(screen.queryByText('MiniMax M2.7')).toBeNull()

    // Matching the provider name keeps every one of its models, so a user who
    // remembers the provider but not the model still finds them all.
    fireEvent.change(search(), { target: { value: 'minimax' } })
    expect(screen.getByRole('menuitemradio', { name: 'MiniMax M2.7' })).toBeTruthy()

    // An id match lands too — users paste ids straight from settings.yaml.
    fireEvent.change(search(), { target: { value: 'm2.7' } })
    expect(screen.getByRole('menuitemradio', { name: 'MiniMax M2.7' })).toBeTruthy()
  })

  it('reports a search with no matches, and clears on escape before backing out', () => {
    mount()

    fireEvent.change(search(), { target: { value: 'no-such-model' } })
    expect(screen.getByText('没有匹配的模型。')).toBeTruthy()

    // The first escape only drops the filter; the pane and its list stay.
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(screen.queryByText('没有匹配的模型。')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: /Flash/ })).toBeTruthy()

    // An empty filter's escape backs out to the root pane — the search seat is
    // gone with it.
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(screen.queryByLabelText('搜索模型…')).toBeNull()
    expect(screen.getByRole('menuitem', { name: /模型/ })).toBeTruthy()
  })

  it('selects the first match on enter and resets the filter when the menu closes', async () => {
    const directory = createSnapshotStore(state({ groups, current: null }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ groups, current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))

    fireEvent.change(search(), { target: { value: 'pro' } })
    fireEvent.keyDown(search(), { key: 'Enter' })

    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    })

    // Reopening starts unfiltered rather than re-applying the old query.
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(search().value).toBe('')
  })
})
