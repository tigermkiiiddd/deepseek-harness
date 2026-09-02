/** Facade contract: Remote failures reject and every method preserves its arguments. */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TeamMemberRow } from '@deepseek-ai/dsh-team/types'
import { describe, expect, it, vi } from 'vitest'
import { inject } from '../src/client/index.ts'
import { createTeamFacade, type TeamRemoteNamespace, unwrap } from '../src/client/team-facade.ts'

function ok<T>(value: T): Promise<RemoteResult<T>> {
  return Promise.resolve({ ok: true, value })
}

function fail<T>(message: string): Promise<RemoteResult<T>> {
  return Promise.resolve({
    ok: false,
    error: { code: 'internal', message, details: {} } as never,
  })
}

const memberRow = (id: string, title: string, status: TeamMemberRow['status']): TeamMemberRow => ({
  id,
  title,
  description: null,
  kind: null,
  status,
  autostart: true,
  lastError: null,
  model: null,
})

function face(overrides: Partial<TeamRemoteNamespace>): TeamRemoteNamespace {
  return {
    list: overrides.list ?? (() => fail('unused list')),
    start: overrides.start ?? (() => fail('unused start')),
    stop: overrides.stop ?? (() => fail('unused stop')),
    restart: overrides.restart ?? (() => fail('unused restart')),
    sessions: overrides.sessions ?? (() => fail('unused sessions')),
    newSession: overrides.newSession ?? (() => fail('unused newSession')),
    addMember: overrides.addMember ?? (() => fail('unused addMember')),
    removeMember: overrides.removeMember ?? (() => fail('unused removeMember')),
  }
}

describe('Team client lifecycle', () => {
  it('waits for the Remote carrier, sessions, and slots before mounting', () => {
    expect(inject).toEqual(['remote', 'sessions', 'slots'])
  })
})

describe('unwrap', () => {
  it('returns the successful value', async () => {
    await expect(unwrap(ok([memberRow('m', 'M', 'idle')]))).resolves.toEqual([memberRow('m', 'M', 'idle')])
  })

  it('throws the Remote failure message', async () => {
    await expect(unwrap(fail('member process crashed'))).rejects.toThrow('member process crashed')
  })
})

describe('createTeamFacade', () => {
  const member = memberRow('m1', 'Writer', 'idle')

  it('lists members', async () => {
    const list = vi.fn(() => ok([member]))
    await expect(createTeamFacade(face({ list })).list()).resolves.toEqual([member])
    expect(list).toHaveBeenCalledWith()
  })

  it('lists sessions and creates a session', async () => {
    const sessions = vi.fn(() => ok([{ sessionId: 's1', cwd: '' }]))
    const newSession = vi.fn(() => ok('s2'))
    const facade = createTeamFacade(face({ sessions, newSession }))
    await expect(facade.sessions('m1')).resolves.toEqual([{ sessionId: 's1', cwd: '' }])
    await expect(facade.newSession('m1')).resolves.toBe('s2')
    expect(sessions).toHaveBeenCalledWith('m1')
    expect(newSession).toHaveBeenCalledWith('m1')
  })

  it('delegates lifecycle operations', async () => {
    const start = vi.fn(() => ok(undefined))
    const stop = vi.fn(() => ok(undefined))
    const restart = vi.fn(() => ok(undefined))
    const facade = createTeamFacade(face({ start, stop, restart }))
    await facade.start('m1')
    await facade.stop('m1')
    await facade.restart('m1')
    expect(start).toHaveBeenCalledWith('m1')
    expect(stop).toHaveBeenCalledWith('m1')
    expect(restart).toHaveBeenCalledWith('m1')
  })

  it('adds and removes members', async () => {
    const addMember = vi.fn(() => ok(memberRow('m2', 'Reviewer', 'idle')))
    const removeMember = vi.fn(() => ok(undefined))
    const facade = createTeamFacade(face({ addMember, removeMember }))
    const config = { id: 'm2', title: 'Reviewer', command: 'dsh-acp-demo' }
    await expect(facade.addMember(config)).resolves.toEqual(memberRow('m2', 'Reviewer', 'idle'))
    await expect(facade.removeMember('m2')).resolves.toBeUndefined()
    expect(addMember).toHaveBeenCalledWith(config)
    expect(removeMember).toHaveBeenCalledWith('m2')
  })

  it('propagates Remote failures through every method', async () => {
    const facade = createTeamFacade(face({
      list: () => fail('team unavailable'),
      start: () => fail('unknown member'),
      stop: () => fail('unknown member'),
      restart: () => fail('unknown member'),
      sessions: () => fail('member offline'),
      newSession: () => fail('member offline'),
      addMember: () => fail('duplicate member id'),
      removeMember: () => fail('unknown member'),
    }))
    await expect(facade.list()).rejects.toThrow('team unavailable')
    await expect(facade.start('m1')).rejects.toThrow('unknown member')
    await expect(facade.stop('m1')).rejects.toThrow('unknown member')
    await expect(facade.restart('m1')).rejects.toThrow('unknown member')
    await expect(facade.sessions('m1')).rejects.toThrow('member offline')
    await expect(facade.newSession('m1')).rejects.toThrow('member offline')
    await expect(facade.addMember({ id: 'm1', command: 'x' })).rejects.toThrow('duplicate member id')
    await expect(facade.removeMember('m1')).rejects.toThrow('unknown member')
  })
})
