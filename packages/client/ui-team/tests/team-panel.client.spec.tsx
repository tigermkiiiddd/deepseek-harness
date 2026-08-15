// @vitest-environment jsdom
/** TeamPanel behavior: closed renders nothing, open lists the roster, and
 * member/topic selection drives sessions, history, and chat through the facade. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { TeamPanel } from '../src/client/TeamPanel.tsx'
import type { TeamPanelProps } from '../src/client/TeamPanel.tsx'
import type { TeamFacade } from '../src/client/team-facade.ts'
import { createTeamPanelStore } from '../src/client/team-store.ts'

afterEach(cleanup)

const MEMBERS = [
  { id: 'writer', title: 'Writer', description: 'fixture member', status: 'idle' },
  { id: 'reviewer', title: 'Reviewer', description: undefined, status: 'idle' },
]
const SESSIONS = [{ sessionId: 'topic-1', cwd: '' }]
const HISTORY = [
  { role: 'user' as const, text: '开场' },
  { role: 'assistant' as const, text: '收到，我在。' },
]

/** A facade stub answering with the fixture data above. */
function stubFacade(overrides: Partial<TeamFacade> = {}): TeamFacade {
  return {
    list: vi.fn(async () => MEMBERS),
    sessions: vi.fn(async () => SESSIONS),
    history: vi.fn(async () => HISTORY),
    newSession: vi.fn(async () => 'topic-2'),
    chat: vi.fn(async () => ({ text: '已收到', stopReason: 'completed' })),
    ...overrides,
  }
}

/** Empty global standard-kit hooks (the panel reads neither). */
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

/** Build the four-share props with a real store instance and the given facade. */
function propsOf(team: TeamFacade): TeamPanelProps {
  const store = createTeamPanelStore().create()
  return {
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    team,
  }
}

/** Wait until the given text is on screen. */
async function seen(text: string): Promise<void> {
  await waitFor(() => { expect(screen.getByText(text)).toBeDefined() })
}

describe('TeamPanel', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<TeamPanel {...propsOf(stubFacade())} />)
    expect(container.firstChild).toBeNull()
  })

  it('lists the roster after opening', async () => {
    const props = propsOf(stubFacade())
    render(<TeamPanel {...props} />)
    act(() => { props.actions.toggle() })
    await seen('Writer')
    expect(screen.getByText('Reviewer')).toBeDefined()
    expect(screen.getByText(/fixture member/)).toBeDefined()
  })

  it("loads a member's topics and a topic's history on selection", async () => {
    const team = stubFacade()
    const props = propsOf(team)
    render(<TeamPanel {...props} />)
    act(() => { props.actions.toggle() })
    await seen('Writer')
    fireEvent.click(screen.getByText('Writer'))
    await seen('topic-1')
    fireEvent.click(screen.getByText('topic-1'))
    await seen('开场')
    expect(screen.getByText('收到，我在。')).toBeDefined()
    expect(team.sessions).toHaveBeenCalledWith('writer')
    expect(team.history).toHaveBeenCalledWith('writer', 'topic-1')
  })

  it('sends a turn and appends the user text and the reply', async () => {
    const team = stubFacade()
    const props = propsOf(team)
    render(<TeamPanel {...props} />)
    act(() => { props.actions.toggle() })
    await seen('Writer')
    fireEvent.click(screen.getByText('Writer'))
    await seen('topic-1')
    fireEvent.click(screen.getByText('topic-1'))
    await seen('开场')
    fireEvent.change(screen.getByPlaceholderText('给成员发消息'), { target: { value: '你好' } })
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => { expect(team.chat).toHaveBeenCalledWith('writer', 'topic-1', '你好') })
    await seen('已收到')
    expect(screen.getByText('你好')).toBeDefined()
  })

  it('creates a fresh topic and selects it', async () => {
    const team = stubFacade()
    const props = propsOf(team)
    render(<TeamPanel {...props} />)
    act(() => { props.actions.toggle() })
    await seen('Writer')
    fireEvent.click(screen.getByText('Writer'))
    await seen('topic-1')
    fireEvent.click(screen.getByText('＋ 新话题'))
    await waitFor(() => { expect(team.newSession).toHaveBeenCalledWith('writer') })
    await seen('topic-2')
    expect(screen.queryByText('选择一个成员和话题开始对话')).toBeNull()
  })

  it('shows the error when the roster load fails', async () => {
    const team = stubFacade({ list: vi.fn(async () => { throw new Error('team unavailable') }) })
    const props = propsOf(team)
    render(<TeamPanel {...props} />)
    act(() => { props.actions.toggle() })
    await seen('Error: team unavailable')
  })
})
