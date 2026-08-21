// @vitest-environment jsdom
/**
 * AppRoot boot-gate smoke: loading page until the settled signal flips (status
 * alone never opens the gate), fail-loud entry list + boot failure report,
 * one-pass switch to the real UI, and the post-settle crash fallback — a
 * service withdrawal after settle (connection loss, hot reload) must land on
 * the fail-loud card and recover on the next kernel store change, never on an
 * unmounted blank tree. The full browser chain (real module system + vendored
 * Loader + bundles) is the e2e's job; this pins the shell-owned gate
 * semantics. Stores are the kernel-own signals production boot uses (shell
 * self-sufficiency: the loading page depends on no plugin package).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

afterEach(cleanup)
import { AppRoot } from '@deepseek-ai/dsh-client-web/src/AppRoot.tsx'
import { createLoaderStatusStore, createSignal } from '@deepseek-ai/dsh-client-web/src/loader-status.ts'

function mount() {
  const settled = createSignal(false)
  const error = createSignal<string | undefined>(undefined)
  const status = createLoaderStatusStore()
  let renders = 0
  const utils = render(
    <AppRoot
      settled={settled}
      status={status}
      error={error}
      renderApp={() => { renders += 1; return <div data-testid="real-ui" /> }}
    />,
  )
  return { settled, status, error, counts: () => renders, ...utils }
}

describe('AppRoot', () => {
  it('shows the loading page and never calls renderApp before settled', () => {
    const { queryByTestId, counts, getByText } = mount()
    expect(getByText('HARNESS')).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
    expect(counts()).toBe(0)
  })

  it('all-active status alone does not open the gate (settled signal is the only key)', () => {
    const { status, queryByTestId } = mount()
    act(() => {
      status.set('a', 'active')
      status.set('b', 'active')
    })
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('lists failed entries and stays on the loading page', () => {
    const { status, getByText, queryByTestId } = mount()
    act(() => {
      status.set('@deepseek-ai/dsh-client-ui-layout', 'failed')
      status.set('ok', 'active')
    })
    expect(getByText('Failed to load plugins')).toBeTruthy()
    expect(getByText('@deepseek-ai/dsh-client-ui-layout')).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('renders the boot failure report even when no entry projected failed', () => {
    const { error, getByText, queryByTestId } = mount()
    act(() => { error.set('web boot: 1 entry did not activate\nx: pending (waiting for service: y)') })
    expect(getByText('Failed to load plugins')).toBeTruthy()
    expect(getByText(/waiting for service/)).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('flipping settled switches to the real UI in one pass', () => {
    const { settled, getByTestId, queryByText, counts } = mount()
    act(() => { settled.set(true) })
    expect(getByTestId('real-ui')).toBeTruthy()
    expect(queryByText('HARNESS')).toBeNull()
    expect(counts()).toBe(1)
  })

  it('falls back to the failure card when the settled UI throws, instead of unmounting', () => {
    const settled = createSignal(false)
    const status = createLoaderStatusStore()
    const withdrawn = true
    const view = render(
      <AppRoot
        settled={settled}
        status={status}
        error={createSignal<string | undefined>(undefined)}
        renderApp={() => {
          if (withdrawn) throw new Error('web boot: appShell service missing after settled')
          return <div data-testid="real-ui" />
        }}
      />,
    )
    act(() => { settled.set(true) })
    expect(view.getByText('Failed to render the UI')).toBeTruthy()
    expect(view.getByText(/appShell service missing after settled/)).toBeTruthy()
    expect(view.queryByTestId('real-ui')).toBeNull()
  })

  it('recovers the real UI after a crash once plugin states change', () => {
    const settled = createSignal(false)
    const status = createLoaderStatusStore()
    let withdrawn = true
    const view = render(
      <AppRoot
        settled={settled}
        status={status}
        error={createSignal<string | undefined>(undefined)}
        renderApp={() => {
          if (withdrawn) throw new Error('web boot: appShell service missing after settled')
          return <div data-testid="real-ui" />
        }}
      />,
    )
    act(() => { settled.set(true) })
    expect(view.getByText('Failed to render the UI')).toBeTruthy()
    withdrawn = false
    // Fiber-state projections change while a withdrawn service graph
    // recovers; each change re-arms the boundary's retry.
    act(() => { status.set('@deepseek-ai/dsh-client-runtime', 'active') })
    expect(view.getByTestId('real-ui')).toBeTruthy()
    expect(view.queryByText('Failed to render the UI')).toBeNull()
  })

  it('keeps re-attempting while the withdrawal persists, without crashing the tree', () => {
    const settled = createSignal(false)
    const status = createLoaderStatusStore()
    const view = render(
      <AppRoot
        settled={settled}
        status={status}
        error={createSignal<string | undefined>(undefined)}
        renderApp={() => { throw new Error('web boot: appShell service missing after settled') }}
      />,
    )
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      act(() => { settled.set(true) })
      act(() => { status.set('a', 'active') })
      act(() => { status.set('b', 'active') })
      expect(view.getByText('Failed to render the UI')).toBeTruthy()
      expect(view.getByText(/appShell service missing after settled/)).toBeTruthy()
    } finally {
      reported.mockRestore()
    }
  })
})
