/** Team view controller: state transitions and session selection through the runtime. */
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentContext, ISessions, SessionBinding, SessionEventSource, SessionFace,
  SessionListState, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamMemberRow } from '@deepseek-ai/dsh-team/types'
import type { TeamFacade } from '../src/client/team-facade.ts'
import { TeamController } from '../src/client/team-store.ts'

const member = (overrides: Partial<TeamMemberRow> = {}): TeamMemberRow => ({
  id: 'architect',
  title: '架构师',
  description: null,
  kind: null,
  status: 'running',
  autostart: true,
  lastError: null,
  model: null,
  ...overrides,
})

function summary(sessionId: string, retainedBy: SessionListState['byId'][SessionId]['retainedBy'] = {}): SessionListState['byId'][SessionId] {
  return {
    id: sessionId as SessionId,
    displayTitle: sessionId,
    running: false,
    blank: false,
    updatedAt: 0,
    retainedBy,
  }
}

function sessionsDouble(currentMainView?: SessionId) {
  const byId: SessionListState['byId'] = currentMainView === undefined
    ? {}
    : { [currentMainView]: summary(String(currentMainView), { mainView: 1 }) }
  const list = createSnapshotStore<SessionListState>({
    ids: Object.keys(byId) as SessionId[], byId, phase: 'ready', projectionsBySession: {},
  })
  const references = new Map<SessionId, SessionReference>()
  const bindingOf = (id: SessionId): SessionBinding => ({
    sessionId: id,
    session: {} as SessionFace,
    eventSource: {} as SessionEventSource,
    ctx: {} as AgentContext,
  })
  const retain = vi.fn<ISessions['retain']>((target, options) => {
    const id = target as SessionId
    const state = list.getSnapshot()
    if (state.byId[id] === undefined) throw new Error(`sessions.retain: unknown session ${String(id)}`)
    const existing = references.get(id)
    if (existing !== undefined) return existing
    let released = false
    const reference = {
      sessionId: id,
      get binding() { return bindingOf(id) },
      ready: Promise.resolve(bindingOf(id)),
      release: () => {
        if (released) return
        released = true
        references.delete(id)
        const next = list.getSnapshot()
        const row = next.byId[id]
        if (row === undefined) return
        const sources = { ...row.retainedBy }
        const count = sources[options.source as keyof typeof sources]
        if (count === undefined) return
        const remaining = { ...sources }
        if (count > 1) remaining[options.source as keyof typeof remaining] = count - 1
        else {
          const { [options.source]: _dropped, ...rest } = remaining
          list.set({ ...next, byId: { ...next.byId, [id]: { ...row, retainedBy: rest } } })
          return
        }
        list.set({ ...next, byId: { ...next.byId, [id]: { ...row, retainedBy: remaining } } })
      },
      [Symbol.dispose]: () => { reference.release() },
    } satisfies SessionReference
    references.set(id, reference)
    const state2 = list.getSnapshot()
    const row = state2.byId[id]
    list.set({
      ...state2,
      byId: {
        ...state2.byId,
        [id]: {
          ...row,
          retainedBy: {
            ...row?.retainedBy,
            [options.source]: ((row?.retainedBy as Record<string, number> | undefined)?.[options.source] ?? 0) + 1,
          },
        },
      },
    })
    return reference
  })
  return {
    list,
    searchResultLimit: 20,
    create: vi.fn(async () => 'created' as SessionId),
    retain,
    using: vi.fn(),
    retainInfo: vi.fn(() => ({
      getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }),
      subscribe: () => () => {},
    })),
    subagentAddress: vi.fn(),
    refreshProjections: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    search: vi.fn(),
    fork: vi.fn(),
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
    sessions.list.update((draft) => {
      draft.byId['member:architect:topic-b' as SessionId] = summary('member:architect:topic-b')
    })
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
    expect(sessions.retain).toHaveBeenCalledWith('member:architect:topic-b' as SessionId, { source: 'mainView' })
  })

  it('creates a topic when the member has none, then opens it', async () => {
    const sessions = sessionsDouble()
    sessions.list.update((draft) => {
      draft.byId['member:architect:topic-fresh' as SessionId] = summary('member:architect:topic-fresh')
    })
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
      expect(sessions.retain).toHaveBeenCalledWith('member:architect:topic-fresh' as SessionId, { source: 'mainView' })
    })
  })

  it('re-baselines the list once when retain misses a topic newer than the baseline', async () => {
    const sessions = sessionsDouble()
    // First retain throws (the topic is not in this client's list yet); the
    // retry after refresh lands.
    const baseRetain = sessions.retain.getMockImplementation()
    let firstRetain = true
    sessions.retain.mockImplementation((target, options) => {
      if (firstRetain) {
        firstRetain = false
        throw new Error('sessions.retain: unknown session member:architect:topic-a')
      }
      // The refresh re-baseline landed the topic in the list.
      sessions.list.update((draft) => {
        draft.byId['member:architect:topic-a' as SessionId] = summary('member:architect:topic-a')
      })
      return baseRetain?.(target, options) as SessionReference
    })
    const api = facade({ sessions: vi.fn(async () => [{ sessionId: 'topic-a', cwd: '' }]) })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    await vi.waitFor(() => { expect(sessions.refresh).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(sessions.retain).toHaveBeenCalledTimes(2) })
    expect(controller.store.getSnapshot().error).toBeUndefined()
  })

  it('surfaces the error when the retry retain still misses', async () => {
    const sessions = sessionsDouble()
    sessions.retain.mockImplementation(() => { throw new Error('sessions.retain: unknown session member:architect:topic-a') })
    const api = facade({ sessions: vi.fn(async () => [{ sessionId: 'topic-a', cwd: '' }]) })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    await vi.waitFor(() => { expect(sessions.refresh).toHaveBeenCalledOnce() })
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().error).toBe('sessions.retain: unknown session member:architect:topic-a')
    })
  })

  it('opening the main instance releases the held member session reference', async () => {
    const sessions = sessionsDouble()
    sessions.list.update((draft) => {
      draft.byId['member:architect:topic-a' as SessionId] = summary('member:architect:topic-a')
    })
    const api = facade({ sessions: vi.fn(async () => [{ sessionId: 'topic-a', cwd: '' }]) })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    await vi.waitFor(() => { expect(sessions.retain).toHaveBeenCalled() })
    const references = sessions.retain.mock.results.map(result => result.value).filter(Boolean)
    expect(references).toHaveLength(1)
    controller.openMember(undefined)
    expect(controller.store.getSnapshot().currentAgentId).toBeUndefined()
    const first = references[0] as SessionReference
    expect(sessions.list.getSnapshot().byId['member:architect:topic-a' as SessionId]?.retainedBy.mainView).toBeUndefined()
    first.release()
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
    expect(sessions.retain).not.toHaveBeenCalled()
  })

  it('openMember ignores a stale topic load after switching back', async () => {
    let resolveSessions: ((value: { sessionId: string; cwd: string }[]) => void) | undefined
    const sessions = sessionsDouble()
    const api = facade({
      sessions: vi.fn((): Promise<{ sessionId: string; cwd: string }[]> => new Promise((resolve) => { resolveSessions = resolve })),
    })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    controller.openMember(undefined)
    resolveSessions?.([{ sessionId: 'topic-a', cwd: '' }])
    await vi.waitFor(() => { expect(controller.store.getSnapshot().currentAgentId).toBeUndefined() })
    expect(sessions.retain).not.toHaveBeenCalled()
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
    sessions.list.update((draft) => {
      draft.byId['member:architect:topic-1' as SessionId] = summary('member:architect:topic-1', { mainView: 1 })
    })
    await vi.waitFor(() => { expect(controller.store.getSnapshot().currentAgentId).toBe('architect') })
    sessions.list.update((draft) => {
      draft.byId['main-session' as SessionId] = summary('main-session', { mainView: 1 })
      draft.byId['member:architect:topic-1' as SessionId] = summary('member:architect:topic-1')
    })
    await vi.waitFor(() => { expect(controller.store.getSnapshot().currentAgentId).toBeUndefined() })
    controller.dispose()
  })

  it('does not loop when the session list echoes the member opened by openMember', async () => {
    const sessions = sessionsDouble()
    const api = facade({ sessions: vi.fn(async () => [{ sessionId: 'topic-a', cwd: '' }]) })
    const controller = new TeamController(api, sessions)
    controller.openMember('architect')
    await vi.waitFor(() => { expect(sessions.retain).toHaveBeenCalledWith('member:architect:topic-a' as SessionId, { source: 'mainView' }) })
    sessions.list.update((draft) => {
      draft.byId['member:architect:topic-a' as SessionId] = summary('member:architect:topic-a', { mainView: 1 })
    })
    await vi.waitFor(() => { expect(controller.store.getSnapshot().currentAgentId).toBe('architect') })
    controller.dispose()
  })
})
