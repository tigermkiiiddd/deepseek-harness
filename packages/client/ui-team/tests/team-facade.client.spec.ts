/** Facade contract: unwrap throws on the error branch, and each facade method delegates to the wire face. */
import { describe, expect, it, vi } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcResponse } from '@deepseek-ai/dsh-client-connection/client'
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

describe('unwrap', () => {
  it('returns the ok-branch value', async () => {
    await expect(unwrap(ok([{ id: 'm', title: 'M', description: undefined, status: 'idle' }])))
      .resolves.toEqual([{ id: 'm', title: 'M', description: undefined, status: 'idle' }])
  })

  it('throws the error-branch message', async () => {
    await expect(unwrap(fail('member process crashed'))).rejects.toThrow('member process crashed')
  })
})

describe('createTeamFacade', () => {
  const member = { id: 'm1', title: 'Writer', description: undefined, status: 'idle' }

  it('lists members with an empty payload', async () => {
    const list = vi.fn(() => ok([member]))
    const facade = createTeamFacade({ list })
    await expect(facade.list()).resolves.toEqual([member])
    expect(list).toHaveBeenCalledWith({})
  })

  it('lists sessions and history with the member and topic ids', async () => {
    const sessions = vi.fn(() => ok([{ sessionId: 's1', cwd: '' }]))
    const history = vi.fn(() => ok([{ role: 'user', text: 'hi' }]))
    const facade = createTeamFacade({ sessions, history })
    await expect(facade.sessions('m1')).resolves.toEqual([{ sessionId: 's1', cwd: '' }])
    await expect(facade.history('m1', 's1')).resolves.toEqual([{ role: 'user', text: 'hi' }])
    expect(sessions).toHaveBeenCalledWith({ memberId: 'm1' })
    expect(history).toHaveBeenCalledWith({ memberId: 'm1', sessionId: 's1' })
  })

  it('unwraps newSession to the bare id and chat to the settled reply', async () => {
    const newSession = vi.fn(() => ok({ sessionId: 's2' }))
    const chat = vi.fn(() => ok({ text: 'reply', stopReason: 'completed' }))
    const facade = createTeamFacade({ newSession, chat })
    await expect(facade.newSession('m1')).resolves.toBe('s2')
    await expect(facade.chat('m1', 's2', 'hi')).resolves.toEqual({ text: 'reply', stopReason: 'completed' })
    expect(newSession).toHaveBeenCalledWith({ memberId: 'm1' })
    expect(chat).toHaveBeenCalledWith({ memberId: 'm1', sessionId: 's2', text: 'hi' })
  })

  it('propagates an error branch through every method', async () => {
    const facade = createTeamFacade({
      list: () => fail('team unavailable'),
      sessions: () => fail('member offline'),
      history: () => fail('member offline'),
      newSession: () => fail('member offline'),
      chat: () => fail('member offline'),
    })
    await expect(facade.list()).rejects.toThrow('team unavailable')
    await expect(facade.sessions('m1')).rejects.toThrow('member offline')
    await expect(facade.history('m1', 's1')).rejects.toThrow('member offline')
    await expect(facade.newSession('m1')).rejects.toThrow('member offline')
    await expect(facade.chat('m1', 's1', 'hi')).rejects.toThrow('member offline')
  })
})
