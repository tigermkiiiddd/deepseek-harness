// @vitest-environment jsdom
/** TeamAction behavior: the icon-only rail form, the label when wide, and the store toggle. */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { TeamAction } from '../src/client/TeamAction.tsx'
import type { TeamActionProps } from '../src/client/TeamAction.tsx'
import { createTeamPanelStore } from '../src/client/team-store.ts'

afterEach(cleanup)

/** Empty global standard-kit hooks (the action reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

/** Build the composed props around a fresh store instance. */
function propsOf(wide: boolean): TeamActionProps {
  const store = createTeamPanelStore().create()
  return {
    wide,
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
  }
}

describe('TeamAction', () => {
  it('shows only the icon in rail mode', () => {
    render(<TeamAction {...propsOf(false)} />)
    const button = screen.getByRole('button', { name: /👥/ })
    expect(button.textContent).not.toContain('团队')
    expect(button.getAttribute('title')).toBe('团队')
  })

  it('adds the label when wide', () => {
    render(<TeamAction {...propsOf(true)} />)
    expect(screen.getByRole('button', { name: /👥 团队/ })).toBeDefined()
  })

  it('toggles the shared panel store on click', () => {
    const props = propsOf(true)
    render(<TeamAction {...props} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button', { name: /✕ 团队/ })).toBeDefined()
  })

  it('reflects the open state from the store', () => {
    const store = createTeamPanelStore().create()
    const props: TeamActionProps = {
      wide: true,
      useStore: bindSnapshotSelector(store),
      actions: store.actions,
      useSessions: emptySessions(),
      useWorkspaces: emptyWorkspaces(),
    }
    render(<TeamAction {...props} />)
    act(() => { store.actions.toggle() })
    expect(screen.getByRole('button', { name: /✕ 团队/ })).toBeDefined()
  })
})
