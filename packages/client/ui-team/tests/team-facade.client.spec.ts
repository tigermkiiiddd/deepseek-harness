/** Facade contract: unwrap throws on the error branch, and each facade method delegates to the wire face. */
import { describe, expect, it, vi } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { IApiClient, RpcResponse } from '@deepseek-ai/dsh-client-connection/client'
import { createTeamFacade, unwrap } from '../src/client/team-facade.ts'

/** One settled ok envelope. */
function ok<T>(value: T): Promise<RpcResponse<T>> {
  return Promise.resolve({ rpcId: RpcId('fx'), result: { ok: true, value } })
}

/** One settled error envelope. */
function fail(message: string): Promise<RpcResponse<never>> {
  return Promise.resolve({
    rpcId: RpcId('fx'),
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  })
}

const memberView = (id: string, title: string, status: string) => ({
  id, title, description: undefined as string | undefined, status,
  capabilities: undefined, autostart: true, lastError: undefined,
})

/** A complete wire face with unused methods failing loudly. */
function face(overrides: Partial<IApiClient['team']>): IApiClient['team'] {
  return {
    list: overrides.list ?? (() => fail('unused list')),
    start: overrides.start ?? (() => fail('unused start')),
    stop: overrides.stop ?? (() => fail('unused stop')),
    restart: overrides.restart ?? (() => fail('unused restart')),
    sessions: overrides.sessions ?? (() => fail('unused sessions')),
    newSession: overrides.newSession ?? (() => fail('unused newSession')),
    addMember: overrides.addMember ?? (() => fail('unused addMember')),
    removeMember: overrides.removeMember ?? (() => fail('unused removeMember')),
  } as IApiClient['team']
}

describe('unwrap', () => {
  it('returns the ok-branch value', async () => {
    await expect(unwrap(ok([memberView('m', 'M', 'idle')]))).resolves.toEqual([memberView('m', 'M', 'idle')])
  })

  it('throws the error-branch message', async () => {
    await expect(unwrap(fail('member process crashed'))).rejects.toThrow('member process crashed')
  })
})

describe('createTeamFacade', () => {
  const member = memberView('m1', 'Writer', 'idle')

  it('lists members with an empty payload', async () => {
    const list = vi.fn(() => ok([member]))
    const facade = createTeamFacade(face({ list }))
    await expect(facade.list()).resolves.toEqual([member])
    expect(list).toHaveBeenCalledWith({})
  })

  it('lists sessions and unwraps newSession to the bare id', async () => {
    const sessions = vi.fn(() => ok([{ sessionId: 's1', cwd: '' }]))
    const newSession = vi.fn(() => ok({ sessionId: 's2' }))
    const facade = createTeamFacade(face({ sessions, newSession }))
    await expect(facade.sessions('m1')).resolves.toEqual([{ sessionId: 's1', cwd: '' }])
    await expect(facade.newSession('m1')).resolves.toBe('s2')
    expect(sessions).toHaveBeenCalledWith({ memberId: 'm1' })
    expect(newSession).toHaveBeenCalledWith({ memberId: 'm1' })
  })

  it('delegates lifecycle verbs', async () => {
    const start = vi.fn(() => ok({}))
    const stop = vi.fn(() => ok({}))
    const restart = vi.fn(() => ok({}))
    const facade = createTeamFacade(face({ start, stop, restart }))
    await facade.start('m1')
    await facade.stop('m1')
    await facade.restart('m1')
    expect(start).toHaveBeenCalledWith({ memberId: 'm1' })
    expect(stop).toHaveBeenCalledWith({ memberId: 'm1' })
    expect(restart).toHaveBeenCalledWith({ memberId: 'm1' })
  })

  it('adds and removes members with their payloads', async () => {
    const addMember = vi.fn(() => ok(memberView('m2', 'Reviewer', 'connecting')))
    const removeMember = vi.fn(() => ok({}))
    const facade = createTeamFacade(face({ addMember, removeMember }))
    await expect(facade.addMember({ id: 'm2', title: 'Reviewer', command: 'dsh-acp-demo' }))
      .resolves.toEqual(memberView('m2', 'Reviewer', 'connecting'))
    await expect(facade.removeMember('m2')).resolves.toBeUndefined()
    expect(addMember).toHaveBeenCalledWith({ id: 'm2', title: 'Reviewer', command: 'dsh-acp-demo' })
    expect(removeMember).toHaveBeenCalledWith({ memberId: 'm2' })
  })

  it('propagates an error branch through every method', async () => {
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
