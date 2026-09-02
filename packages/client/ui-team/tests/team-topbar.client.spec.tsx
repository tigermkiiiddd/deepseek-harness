// @vitest-environment jsdom
/** TeamTopbar: the global lane renders the main instance plus every member as
 * nodes, shows live status colors, and clicking a node opens that member's
 * current topic through the regular session-selection path. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemberConfigInput, TeamMemberRow } from '@deepseek-ai/dsh-team/types'
import { TeamTopbar } from '../src/client/TeamTopbar.tsx'
import type { TeamTopbarProps } from '../src/client/TeamTopbar.tsx'
import type { TeamFacade } from '../src/client/team-facade.ts'
import { TeamController } from '../src/client/team-store.ts'

afterEach(cleanup)

const MEMBERS: TeamMemberRow[] = [
  { id: 'writer', title: 'Writer', description: null, kind: null, status: 'idle', autostart: true, lastError: null, model: null },
  { id: 'reviewer', title: 'Reviewer', description: null, kind: null, status: 'running', autostart: true, lastError: null, model: null },
]

function stubFacade(overrides: Partial<TeamFacade> = {}): TeamFacade {
  return {
    list: vi.fn(async () => MEMBERS),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    sessions: vi.fn(async () => [{ sessionId: 'topic-1', cwd: '' }]),
    newSession: vi.fn(async () => 'topic-1'),
    addMember: vi.fn(async (config: MemberConfigInput): Promise<TeamMemberRow> => ({
      id: config.id, title: config.title ?? config.id, description: null, kind: null, status: 'idle',
      autostart: true, lastError: null, model: null,
    })),
    removeMember: vi.fn(async () => undefined),
    ...overrides,
  }
}

function sessionsDouble(current?: SessionId) {
  const list = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  return {
    list,
    currentProvideInfo: {} as never,
    searchResultLimit: 20,
    open: vi.fn(),
    openSubagent: vi.fn(),
    subagentAddress: vi.fn(),
    setSubagentCatalogOpen: vi.fn(),
    refreshSubagents: vi.fn(),
    noteAgentPreset: vi.fn(),
    clear: vi.fn(),
    refresh: vi.fn(async () => {}),
    search: vi.fn(),
    fork: vi.fn(),
    rerun: vi.fn(),
    provide: vi.fn(() => () => {}),
    scope: vi.fn(),
    scopeOf: vi.fn(),
    sessionOf: vi.fn(),
    binding: vi.fn(),
  } satisfies ISessions
}

/** Build a sessions hook/store pair; tests may drive the store to assert main-instance status. */
function sessionsStore(initial: Partial<SessionListState> = {}) {
  const store = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    ...initial,
  })
  return { store, useSessions: bindSnapshotSelector(store) }
}
/** Build the injected props face for a controller (same shape apply() provides). */
function injected(controller: TeamController): Omit<TeamTopbarProps, 'wide' | 'useSessions'> {
  return {
    useTeamLive: bindSnapshotSelector(controller.store),
    loadMembers: () => { controller.loadMembers() },
    openMember: (memberId) => { controller.openMember(memberId) },
    start: (memberId) => { controller.start(memberId) },
    stop: (memberId) => { controller.stop(memberId) },
    restart: (memberId) => { controller.restart(memberId) },
    addMember: config => controller.addMember(config),
    removeMember: memberId => controller.removeMember(memberId),
  }
}

function mount(team: TeamFacade, sessions = sessionsStore(), sessionsSvc = sessionsDouble()): TeamController & { sessionsStore: ReturnType<typeof sessionsStore>['store']; sessionsSvc: ReturnType<typeof sessionsDouble> } {
  const controller = new TeamController(team, sessionsSvc)
  const props: TeamTopbarProps = {
    wide: true,
    useSessions: sessions.useSessions as never,
    ...injected(controller),
  } as TeamTopbarProps
  render(<TeamTopbar {...props} />)
  return Object.assign(controller, { sessionsStore: sessions.store, sessionsSvc })
}

/** The rendered node group whose text contains the given label. */
function nodeByLabel(label: string): SVGGElement | undefined {
  return [...document.querySelectorAll('g')].find(group => group.textContent?.includes(label))
}

describe('TeamTopbar', () => {
  it('renders the main instance node and each member node', async () => {
    mount(stubFacade())
    await waitFor(() => { expect(nodeByLabel('Writer')).toBeDefined() })
    expect(nodeByLabel('主实例')).toBeDefined()
    expect(nodeByLabel('Reviewer')).toBeDefined()
  })

  it('paints a distinct status class per member state', async () => {
    mount(stubFacade())
    await waitFor(() => { expect(document.querySelectorAll('circle').length).toBeGreaterThan(1) })
    const classes = [...document.querySelectorAll('circle')].map(node => node.getAttribute('class') ?? '')
    expect(classes.some(cls => cls.includes('idle'))).toBe(true)
    expect(classes.some(cls => cls.includes('running'))).toBe(true)
  })

  it('clicking a member node opens its latest topic as a member: session', async () => {
    const team = stubFacade({
      sessions: vi.fn(async () => [
        { sessionId: 'topic-a', cwd: '' },
        { sessionId: 'topic-b', cwd: '' },
      ]),
    })
    const { sessionsSvc } = mount(team)
    await waitFor(() => { expect(nodeByLabel('Writer')).toBeDefined() })
    fireEvent.click(nodeByLabel('Writer')!)
    await waitFor(() => { expect(sessionsSvc.open).toHaveBeenCalledWith('member:writer:topic-b' as SessionId) })
  })

  it('clicking a member with no topics creates one then opens it', async () => {
    const team = stubFacade({
      sessions: vi.fn(async () => []),
      newSession: vi.fn(async () => 'topic-fresh'),
    })
    const { sessionsSvc } = mount(team)
    await waitFor(() => { expect(nodeByLabel('Writer')).toBeDefined() })
    fireEvent.click(nodeByLabel('Writer')!)
    await waitFor(() => { expect(team.newSession).toHaveBeenCalledWith('writer') })
    await waitFor(() => { expect(sessionsSvc.open).toHaveBeenCalledWith('member:writer:topic-fresh' as SessionId) })
  })

  it('clicking the main instance node returns to the main instance', async () => {
    const { sessionsSvc } = mount(stubFacade())
    await waitFor(() => { expect(nodeByLabel('Writer')).toBeDefined() })
    fireEvent.click(nodeByLabel('Writer')!)
    await waitFor(() => { expect(sessionsSvc.open).toHaveBeenCalled() })
    fireEvent.click(nodeByLabel('主实例')!)
    await waitFor(() => { expect(sessionsSvc.clear).toHaveBeenCalled() })
  })

  it('adds a member through the new-member form', async () => {
    const team = stubFacade()
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'writer2' } })
    fireEvent.change(screen.getByPlaceholderText('显示名称（可选）'), { target: { value: 'Writer 2' } })
    fireEvent.change(screen.getByPlaceholderText('命令（任意 ACP agent，如 dsh-acp-demo）'), { target: { value: 'dsh-acp-demo' } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => { expect(team.addMember).toHaveBeenCalledWith({
      id: 'writer2', title: 'Writer 2', description: undefined, command: 'dsh-acp-demo', args: [], autostart: true,
    }) })
    await waitFor(() => { expect(screen.getByText('＋ 新建成员')).toBeDefined() })
  })

  it('shows the add error when the host rejects', async () => {
    const team = stubFacade({ addMember: vi.fn(async () => { throw new Error('duplicate member id') }) })
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'writer' } })
    fireEvent.change(screen.getByPlaceholderText('命令（任意 ACP agent，如 dsh-acp-demo）'), { target: { value: 'dsh-acp-demo' } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => { expect(screen.getByText('duplicate member id')).toBeDefined() })
  })

  it('paints distinct status classes for idle, running, failed, and offline members', async () => {
    const team = stubFacade({
      list: vi.fn(async () => [
        { id: 'i', title: 'I', description: null, kind: null, status: 'idle', autostart: true, lastError: null, model: null },
        { id: 'r', title: 'R', description: null, kind: null, status: 'running', autostart: true, lastError: null, model: null },
        { id: 'f', title: 'F', description: null, kind: null, status: 'failed', autostart: true, lastError: null, model: null },
        { id: 'o', title: 'O', description: null, kind: null, status: 'offline', autostart: true, lastError: null, model: null },
      ]),
    })
    mount(team)
    await waitFor(() => { expect(nodeByLabel('I')).toBeDefined() })
    const classes = [...document.querySelectorAll('circle')].map(node => node.getAttribute('class') ?? '')
    expect(classes.some(cls => cls.includes('idle'))).toBe(true)
    expect(classes.some(cls => cls.includes('running'))).toBe(true)
    expect(classes.some(cls => cls.includes('failed'))).toBe(true)
    expect(classes.some(cls => cls.includes('offline'))).toBe(true)
  })

  it('derives the main instance status from the current session running state', async () => {
    const team = stubFacade()
    const sessionId = 'session-1' as SessionId
    const summary: SessionSummary = { id: sessionId, displayTitle: 'S1', running: false, blank: false, updatedAt: 0 }
    const sessions = sessionsStore({
      current: sessionId,
      byId: { [sessionId]: summary },
    })
    mount(team, sessions)
    await waitFor(() => { expect(nodeByLabel('主实例')).toBeDefined() })
    const idleClasses = [...document.querySelectorAll('circle')].map(node => node.getAttribute('class') ?? '')
    expect(idleClasses.some(cls => cls.includes('idle'))).toBe(true)
    sessions.store.update((draft) => {
      draft.byId[sessionId] = { ...summary, running: true }
    })
    await waitFor(() => {
      const classes = [...document.querySelectorAll('circle')].map(node => node.getAttribute('class') ?? '')
      expect(classes.some(cls => cls.includes('running'))).toBe(true)
    })
  })

  it('parses quoted args without splitting inside quotes', async () => {
    const team = stubFacade()
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'q' } })
    fireEvent.change(screen.getByPlaceholderText('命令（任意 ACP agent，如 dsh-acp-demo）'), { target: { value: 'cmd' } })
    fireEvent.change(screen.getByPlaceholderText('参数（空格分隔，可选）'), { target: { value: '-m "hello world"' } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => { expect(team.addMember).toHaveBeenCalledWith(expect.objectContaining({ id: 'q', args: ['-m', 'hello world'] })) })
  })

  it('parses args and env from the form and fills every optional field', async () => {
    const team = stubFacade()
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'grok2' } })
    fireEvent.change(screen.getByPlaceholderText('显示名称（可选）'), { target: { value: 'Grok 2' } })
    fireEvent.change(screen.getByPlaceholderText('描述（可选）'), { target: { value: 'second grok' } })
    fireEvent.change(screen.getByPlaceholderText('命令（任意 ACP agent，如 dsh-acp-demo）'), { target: { value: 'grok' } })
    fireEvent.change(screen.getByPlaceholderText('参数（空格分隔，可选）'), { target: { value: '-q fast' } })
    fireEvent.change(screen.getByPlaceholderText('工作目录 cwd（可选）'), { target: { value: '/tmp' } })
    fireEvent.change(screen.getByPlaceholderText('env（每行 KEY=VALUE，继承完整父环境）'), { target: { value: 'KEY=one\nEMPTY=two' } })
    fireEvent.click(screen.getByLabelText('随主机启动'))
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => { expect(team.addMember).toHaveBeenCalledWith({
      id: 'grok2', title: 'Grok 2', description: 'second grok', command: 'grok',
      args: ['-q', 'fast'], cwd: '/tmp', env: { KEY: 'one', EMPTY: 'two' },
      permission: undefined, autostart: false,
    }) })
  })

  it('rejects a malformed env line and keeps the form open', async () => {
    const team = stubFacade()
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'x' } })
    fireEvent.change(screen.getByPlaceholderText('命令（任意 ACP agent，如 dsh-acp-demo）'), { target: { value: 'cmd' } })
    fireEvent.change(screen.getByPlaceholderText('env（每行 KEY=VALUE，继承完整父环境）'), { target: { value: 'BROKEN' } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => { expect(screen.getByText(/env 行需要 KEY=VALUE 格式/)).toBeDefined() })
    expect(team.addMember).not.toHaveBeenCalled()
    // The form stays open.
    expect(screen.getByText('添加')).toBeDefined()
  })

  it('removes a member from its node without switching agents', async () => {
    const team = stubFacade({ removeMember: vi.fn(async () => undefined) })
    const controller = mount(team)
    await waitFor(() => { expect(nodeByLabel('Writer')).toBeDefined() })
    const writer = nodeByLabel('Writer')!
    const removeMark = [...writer.querySelectorAll('text')].find(text => text.textContent === '✕')!
    fireEvent.click(removeMark)
    await waitFor(() => { expect(team.removeMember).toHaveBeenCalledWith('writer') })
    expect(controller.store.getSnapshot().currentAgentId).toBeUndefined()
  })

  it('cancels the new-member form without submitting', async () => {
    const team = stubFacade()
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('取消'))
    expect(screen.getByText('＋ 新建成员')).toBeDefined()
    expect(team.addMember).not.toHaveBeenCalled()
  })

  it('requires id and command before adding', async () => {
    const team = stubFacade()
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.click(screen.getByText('添加'))
    expect(team.addMember).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('添加'))
    expect(team.addMember).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('命令（任意 ACP agent，如 dsh-acp-demo）'), { target: { value: 'cmd' } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => { expect(team.addMember).toHaveBeenCalled() })
  })

  it('submits the permission policy when chosen', async () => {
    const team = stubFacade()
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'p' } })
    fireEvent.change(screen.getByPlaceholderText('命令（任意 ACP agent，如 dsh-acp-demo）'), { target: { value: 'cmd' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'allow' } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => { expect(team.addMember).toHaveBeenCalledWith(expect.objectContaining({ id: 'p', permission: 'allow' })) })
  })

  it('formats a non-Error host rejection as a string', async () => {
    const team = stubFacade({ addMember: vi.fn(async () => { throw 'raw failure' }) })
    mount(team)
    fireEvent.click(screen.getByText('＋ 新建成员'))
    fireEvent.change(screen.getByPlaceholderText('成员 id（唯一）'), { target: { value: 'x' } })
    fireEvent.change(screen.getByPlaceholderText('命令（任意 ACP agent，如 dsh-acp-demo）'), { target: { value: 'cmd' } })
    fireEvent.click(screen.getByText('添加'))
    await waitFor(() => { expect(screen.getByText('raw failure')).toBeDefined() })
  })
})
