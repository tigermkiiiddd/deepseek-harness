/** Team view controller: state transitions and session selection through the runtime. */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type SessionId, type ISessions, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamMemberView } from '@deepseek-ai/dsh-client-connection/client'
import type { TeamFacade } from '../src/client/team-facade.ts'
import { TeamController } from '../src/client/team-store.ts'

const member = (overrides: Partial<TeamMemberView> = {}): TeamMemberView => ({
  id: 'architect',
  title: '架构师',
  description: undefined,
  status: 'running',
  capabilities: undefined,
  autostart: true,
  lastError: undefined,
  ...overrides,
})

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

function facade(overrides: Partial<TeamFacade> = {}): TeamFacade {
  return {
    list: vi.fn(async () => []),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    sessions: vi.fn(async () => []),
    newSession: vi.fn(async () => 'topic-new'),
    addMember: vi.fn(async () => member()),
    removeMember: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('TeamController', () => {
  it('starts on the main instance and opens a member to its latest topic', async () => {
    const sessions = sessionsDouble()
    const api = facade({
      list: vi.fn(async () => [member()]),
      sessions: vi.fn(async () => [
        { sessionId: 'topic-a', cwd: '' },
        { sessionId: 'topic-b', cwd: '' },
      ]),
    })
    const controller = new TeamController(api, sessions)
    expect(controller.store.getSnapshot().currentAgentId).toBeUndefined()
    controller.openMember('architect')
    await vi.waitFor(() => {
      const state = controller.store.getSnapshot()
      expect(state.currentAgentId).toBe('architect')
    })
    expect(sessions.open).toHaveBeenCalledWith('member:architect:topic-b' as SessionId)
  })

  it('creates a topic when the member has none, then opens it', async () => {
    const sessions = sessionsDouble()
    const api = facade({
      sessions: vi.fn(async () => []),
      newSession: vi.fn(async () => 'topic-fresh'),
    })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    await vi.waitFor(() => {
      expect(api.newSession).toHaveBeenCalledWith('architect')
    })
    await vi.waitFor(() => {
      expect(sessions.open).toHaveBeenCalledWith('member:architect:topic-fresh' as SessionId)
    })
  })

  it('opening the main instance clears the session selection', async () => {
    const sessions = sessionsDouble()
    const controller = new TeamController(facade(), sessions)
    controller.store.update((draft) => { draft.currentAgentId = 'architect' })
    controller.openMember(undefined)
    expect(controller.store.getSnapshot().currentAgentId).toBeUndefined()
    expect(sessions.clear).toHaveBeenCalled()
  })

  it('loadMembers clears a previous error on success', async () => {
    const api = facade({ list: vi.fn(async () => [member()]) })
    const controller = new TeamController(api, sessionsDouble())
    controller.store.update((draft) => { draft.error = 'previous failure' })
    controller.loadMembers()
    await vi.waitFor(() => {
      const state = controller.store.getSnapshot()
      expect(state.error).toBeUndefined()
      expect(state.members).toHaveLength(1)
    })
  })

  it('openMember is a no-op when the member is already current', async () => {
    const sessions = sessionsDouble()
    const api = facade({ sessions: vi.fn(async () => [{ sessionId: 'topic-a', cwd: '' }]) })
    const controller = new TeamController(api, sessions)
    controller.store.update((draft) => { draft.currentAgentId = 'architect' })
    controller.openMember('architect')
    expect(api.sessions).not.toHaveBeenCalled()
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('openMember ignores a stale topic load after switching back', async () => {
    let resolveSessions: ((value: { sessionId: string; cwd: string }[]) => void) | undefined
    const sessions = sessionsDouble()
    const api = facade({
      sessions: vi.fn(() => new Promise((resolve) => { resolveSessions = resolve })),
    })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    controller.openMember(undefined)
    resolveSessions?.([{ sessionId: 'topic-a', cwd: '' }])
    await vi.waitFor(() => { expect(sessions.clear).toHaveBeenCalled() })
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('removeMember drops the roster and closes the member view when selected', async () => {
    const sessions = sessionsDouble()
    const api = facade({ removeMember: vi.fn(async () => {}) })
    const controller = new TeamController(api, sessions)
    controller.store.update((draft) => {
      draft.members = [member(), member({ id: 'writer' })]
      draft.currentAgentId = 'writer'
    })
    await controller.removeMember('writer')
    const state = controller.store.getSnapshot()
    expect(state.members.map(candidate => candidate.id)).toEqual(['architect'])
    expect(state.currentAgentId).toBeUndefined()
  })

  it('surfaces topic load and new-session failures as the error', async () => {
    const sessions = sessionsDouble()
    const api = facade({
      sessions: vi.fn(async () => { throw new Error('sessions failed') }),
    })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    await vi.waitFor(() => { expect(controller.store.getSnapshot().error).toBe('sessions failed') })

    const api2 = facade({
      sessions: vi.fn(async () => []),
      newSession: vi.fn(async () => { throw new Error('member offline') }),
    })
    const controller2 = new TeamController(api2, sessionsDouble())
    controller2.openMember('architect')
    await vi.waitFor(() => { expect(controller2.store.getSnapshot().error).toBe('member offline') })
  })

  it('lifecycle verbs and add/remove propagate host failures', async () => {
    const api = facade({
      start: vi.fn(async () => { throw new Error('start failed') }),
      stop: vi.fn(async () => { throw new Error('stop failed') }),
      restart: vi.fn(async () => { throw new Error('restart failed') }),
      addMember: vi.fn(async () => { throw new Error('duplicate id') }),
      removeMember: vi.fn(async () => { throw new Error('unknown member') }),
    })
    const controller = new TeamController(api, sessionsDouble())
    controller.start('architect')
    controller.stop('architect')
    controller.restart('architect')
    await vi.waitFor(() => { expect(controller.store.getSnapshot().error).toBe('restart failed') })
    await expect(controller.addMember({ id: 'x', command: 'cmd' })).rejects.toThrow('duplicate id')
    await expect(controller.removeMember('x')).rejects.toThrow('unknown member')
    expect(controller.store.getSnapshot().error).toBe('unknown member')
  })

  it('onStatus upserts the roster and records pushed errors', () => {
    const controller = new TeamController(facade(), sessionsDouble())
    controller.store.update((draft) => { draft.members = [member({ status: 'offline' })] })
    controller.onStatus('architect', 'running')
    expect(controller.store.getSnapshot().members[0]?.status).toBe('running')
    controller.onStatus('architect', 'failed', 'crashed')
    const updated = controller.store.getSnapshot().members[0]
    expect(updated?.status).toBe('failed')
    expect(updated?.lastError).toBe('crashed')
    // A follow-up status without an error keeps the last error.
    controller.onStatus('architect', 'running')
    expect(controller.store.getSnapshot().members[0]?.lastError).toBe('crashed')
  })

  it('onStatus ignores unknown members', () => {
    const controller = new TeamController(facade(), sessionsDouble())
    controller.store.update((draft) => { draft.members = [member({ status: 'running' })] })
    controller.onStatus('ghost', 'failed')
    expect(controller.store.getSnapshot().members[0]?.status).toBe('running')
  })

  it('setError formats non-Error failures', async () => {
    const api = facade({ list: vi.fn(async () => { throw 'boom' }) })
    const controller = new TeamController(api, sessionsDouble())
    controller.loadMembers()
    await vi.waitFor(() => { expect(controller.store.getSnapshot().error).toBe('boom') })
  })

  it('initializes currentAgentId from a member session already current', () => {
    const sessions = sessionsDouble('member:architect:topic-1' as SessionId)
    const controller = new TeamController(facade(), sessions)
    expect(controller.store.getSnapshot().currentAgentId).toBe('architect')
    controller.dispose()
  })

  it('syncs currentAgentId when a member session becomes current via the sessions face', async () => {
    const sessions = sessionsDouble()
    const controller = new TeamController(facade(), sessions)
    sessions.list.update((draft) => { draft.current = 'member:architect:topic-1' as SessionId })
    await vi.waitFor(() => { expect(controller.store.getSnapshot().currentAgentId).toBe('architect') })
    sessions.list.update((draft) => { draft.current = 'main-session' as SessionId })
    await vi.waitFor(() => { expect(controller.store.getSnapshot().currentAgentId).toBeUndefined() })
    controller.dispose()
  })

  it('does not loop when the session list echoes the member opened by openMember', async () => {
    const sessions = sessionsDouble()
    const api = facade({ sessions: vi.fn(async () => [{ sessionId: 'topic-a', cwd: '' }]) })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    await vi.waitFor(() => { expect(sessions.open).toHaveBeenCalledWith('member:architect:topic-a' as SessionId) })
    sessions.list.update((draft) => { draft.current = 'member:architect:topic-a' as SessionId })
    await vi.waitFor(() => { expect(controller.store.getSnapshot().currentAgentId).toBe('architect') })
    controller.dispose()
  })
})
