/**
 * team domain host-stream forwarding and the member-session bridge: a real
 * team service (real subprocess spawn of the scripted mock ACP agent) drives
 * member lifecycle through the API proxy, and member topics surface as
 * first-class sessions under virtual ids `member:<memberId>:<topicId>`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { Fiber } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SessionStore from '@deepseek-ai/dsh-session'
import * as Team from '@deepseek-ai/dsh-team'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { HostFrame, MuxFrame } from '../src/api/index.ts'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const mockServer = fileURLToPath(new URL('../../../subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new Error(`expected ok, got ${JSON.stringify(response.result.error)}`)
  return response.result.value
}

function expectErr(response: RpcResponse<unknown>): { code: string; message: string } {
  if (response.result.ok) throw new Error('expected error, got ok')
  return { code: response.result.error.code, message: response.result.error.message }
}

const fibers: Fiber[] = []

function setMockEnv(env?: Record<string, string>): void {
  if (env === undefined) return
  for (const [key, value] of Object.entries(env)) process.env[key] = value
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  const mount = async (plugin: unknown, config?: unknown): Promise<void> => {
    const fiber = ctx.plugin(plugin as never, config as never)
    fibers.push(fiber)
    await fiber
  }
  await mount(SessionStore)
  await mount(LocalSubprocessRuntime)
  await mount(UserQuestionService)
  // The host-stream opener reads the committed-workspace baseline; the stub
  // suffices — the workspace composition is api-proxy-workspace.spec's.
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  await mount(Team, {
    members: [{
      id: 'architect',
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      autostart: false,
    }],
  })
  return ctx
}

beforeEach(() => {
  nextRpc = 1
})

afterEach(async () => {
  // Reverse mount order so the team service's dispose-all stops the member
  // process before the subprocess runtime unloads.
  const pending = fibers.splice(0)
  await Promise.allSettled(pending.reverse().map(async fiber => fiber.dispose()))
  // Reset mock-server env so later tests do not inherit scripted behavior.
  for (const key of ['MOCK_TEXT', 'MOCK_SESSION_ID', 'MOCK_HISTORY_RICH', 'MOCK_PERMISSION']) {
    Reflect.deleteProperty(process.env, key)
  }
})

/** Drain `count` host frames matching `types`, then abort the stream. */
async function collectHost(
  api: ReturnType<typeof createApiProxy>,
  types: string[],
  count: number,
  run: () => Promise<void>,
): Promise<HostFrame[]> {
  const abort = new AbortController()
  const frames: HostFrame[] = []
  const stream = api.events.host(request({}), abort.signal)
  const consume = (async () => {
    for await (const frame of stream) {
      if (!types.includes(frame.payload.type)) continue
      frames.push(frame.payload)
      if (frames.length >= count) abort.abort()
    }
  })()
  await run()
  await consume
  return frames
}

/** Drain `count` mux frames matching `types`, then abort the stream. */
async function collectMux(
  api: ReturnType<typeof createApiProxy>,
  types: string[],
  count: number,
  run: () => Promise<void>,
): Promise<MuxFrame[]> {
  const abort = new AbortController()
  const frames: MuxFrame[] = []
  const stream = api.events.mux(request({}), abort.signal)
  const consume = (async () => {
    for await (const frame of stream) {
      if (!types.includes(frame.payload.type)) continue
      frames.push(frame.payload)
      if (frames.length >= count) abort.abort()
    }
  })()
  await run()
  await consume
  return frames
}

/** Wait for a member to reach the given public status by polling team.list. */
async function waitForStatus(
  api: ReturnType<typeof createApiProxy>,
  memberId: string,
  status: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = expectOk(await api.team.list(request({}))) as { id: string; status: string }[]
    if (list.find(member => member.id === memberId)?.status === status) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for member "${memberId}" to reach ${status}`)
}

describe('team domain host-stream forwarding', () => {
  it('forwards a member status migration as a verbatim host/remote-event frame', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    expect(expectOk(await api.team.list(request({})))).toEqual([
      expect.objectContaining({ id: 'architect', status: 'offline' }),
    ])
    const frames = await collectHost(api, ['host/remote-event'], 1, async () => {
      expectOk(await api.team.start(request({ memberId: 'architect' })))
    })
    // The handshake completed with no turn in flight: the public `idle`
    // migration is the single emitted status (connecting stays internal).
    expect(frames).toEqual([
      { type: 'host/remote-event', event: 'team/status', args: ['architect', 'idle'] },
    ])
  })
})

describe('member session bridge', () => {
  it('lists member topics as first-class sessions', async () => {
    setMockEnv({ MOCK_SESSION_ID: 'list-topic' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const list = expectOk(await api.sessions.list(request({}))).items
    const memberSession = list.find(item => item.sessionId === `member:architect:${topicId}`)
    expect(memberSession).toBeDefined()
    expect(memberSession).toEqual(expect.objectContaining({
      sessionId: `member:architect:${topicId}`,
      blank: false,
      running: false,
    }))
  })

  it('returns translated tool/call+result history for a member session id', async () => {
    setMockEnv({ MOCK_HISTORY_RICH: '1', MOCK_SESSION_ID: 'rich-topic' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const page = expectOk(await api.sessions.history(request({ sessionId: `member:architect:${topicId}` })))
    const types = page.events.map(entry => entry.event.type)
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
    const call = page.events.find(entry => entry.event.type === 'tool/call')?.event.data as { name: string; callId: string }
    expect(call.name).toBe('rich_tool')
    expect(page.hasMore).toBe(false)
  })

  it('flows prompt→update→turn-end as session/event frames with contiguous seq', async () => {
    setMockEnv({ MOCK_TEXT: 'hello member', MOCK_SESSION_ID: 'live-topic' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const sessionId = `member:architect:${topicId}`
    // Open the mux before prompting so the baseline and live events are captured.
    const framesPromise = collectMux(api, ['session/event'], 7, async () => {
      expectOk(await api.sessions.prompt(request({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'hi' }],
      })))
      await waitForStatus(api, 'architect', 'idle')
    })
    const frames = await framesPromise
    const events = frames.filter((frame): frame is Extract<typeof frame, { type: 'session/event' }> => frame.type === 'session/event')
      .map(frame => frame.event)
    const seqs = events.map(event => event.seq)
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
  })

  it('surfaces a member permission request as approval/requested and resolves through api.respond', async () => {
    setMockEnv({ MOCK_PERMISSION: '1', MOCK_TEXT: 'allowed', MOCK_SESSION_ID: 'perm-topic' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const sessionId = `member:architect:${topicId}`
    const abort = new AbortController()
    const stream = api.events.mux(request({}), abort.signal)
    const frames: { rpcId: string; payload: MuxFrame }[] = []
    const consume = (async () => {
      for await (const frame of stream) {
        if (frame.payload.type === 'approval/requested' || frame.payload.type === 'approval/resolved') {
          frames.push({ rpcId: frame.rpcId, payload: frame.payload })
        }
      }
    })()
    expectOk(await api.sessions.prompt(request({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'do it' }],
    })))
    // Wait until the requested frame arrives, then answer it.
    while (frames.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
    const requested = frames[0].payload as Extract<MuxFrame, { type: 'approval/requested' }>
    expect(requested.sessionId).toBe(sessionId)
    expect(requested.toolName).toBe('mock side effect')
    const receipt = await api.respond({
      rpcId: frames[0].rpcId,
      result: {
        ok: true,
        value: { sessionId, approvalId: requested.approvalId, outcome: 'allowed-once' },
      },
    })
    expect(receipt.accepted).toBe(true)
    await waitForStatus(api, 'architect', 'idle')
    abort.abort()
    await consume
    expect(frames).toHaveLength(2)
    expect(frames[1].payload).toEqual(expect.objectContaining({
      type: 'approval/resolved',
      sessionId,
      approvalId: requested.approvalId,
      outcome: 'allowed-once',
    }))
  })

  it('rejects fork and rerun for member session ids loud', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const sessionId = 'member:architect:some-topic'
    const fork = expectErr(await api.sessions.fork(request({ sessionId })))
    expect(fork.code).toBe('internal')
    expect(fork.message).toContain('not supported for member sessions')
    const rerun = expectErr(await api.sessions.rerun(request({ sessionId, atSeq: 5 })))
    expect(rerun.code).toBe('internal')
    expect(rerun.message).toContain('not supported for member sessions')
  })

  it('carries a composed title projection in session.list', async () => {
    setMockEnv({ MOCK_SESSION_ID: 'title-topic', MOCK_SESSION_TITLE: 'Project Planning' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const list = expectOk(await api.sessions.list(request({}))).items
    const memberSession = list.find(item => item.sessionId === `member:architect:${topicId}`)
    expect(memberSession).toBeDefined()
    expect(memberSession?.projections).toEqual({
      asOfSeq: -1,
      values: { title: 'architect · Project Planning' },
    })
  })

  it('prefers the topic updatedAt over first-seen time in session.list', async () => {
    setMockEnv({ MOCK_SESSION_ID: 'dated-topic', MOCK_SESSION_UPDATED_AT: '2025-01-01T00:00:00.000Z' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const list = expectOk(await api.sessions.list(request({}))).items
    const memberSession = list.find(item => item.sessionId === `member:architect:${topicId}`)
    expect(memberSession).toBeDefined()
    expect(memberSession?.updatedAt).toBe(new Date('2025-01-01T00:00:00.000Z').getTime())
  })

  it('serves cached topics and history after the member is stopped', async () => {
    setMockEnv({ MOCK_HISTORY_RICH: '1', MOCK_SESSION_ID: 'cached-topic' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const sessionId = `member:architect:${topicId}`
    // Populate the durable cache by reading history while the member is online.
    const onlinePage = expectOk(await api.sessions.history(request({ sessionId })))
    expect(onlinePage.events.length).toBeGreaterThan(0)
    // Stop the member; listing and history must still serve from cache.
    expectOk(await api.team.stop(request({ memberId: 'architect' })))
    await waitForStatus(api, 'architect', 'offline')
    const list = expectOk(await api.sessions.list(request({}))).items
    expect(list.some(item => item.sessionId === sessionId)).toBe(true)
    const offlinePage = expectOk(await api.sessions.history(request({ sessionId })))
    expect(offlinePage.events.map(entry => entry.event.type)).toEqual(
      onlinePage.events.map(entry => entry.event.type),
    )
  })
})
