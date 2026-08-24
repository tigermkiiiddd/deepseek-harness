/**
 * team domain host-stream forwarding and the member-session bridge: a real
 * team service (real subprocess spawn of the scripted mock ACP agent) drives
 * member lifecycle through the API proxy, and member topics surface as
 * first-class sessions under virtual ids `member:<memberId>:<topicId>`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { Fiber } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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
  for (const key of ['MOCK_TEXT', 'MOCK_SESSION_ID', 'MOCK_HISTORY_RICH', 'MOCK_PERMISSION', 'MOCK_CONFIG_OPTIONS', 'MOCK_ECHO_IMAGES']) {
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
    const page = expectOk(await api.sessions.history(request({ sessionId: SessionId(`member:architect:${topicId}`) })))
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
    const sessionId = SessionId(`member:architect:${topicId}`)
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
    const sessionId = SessionId(`member:architect:${topicId}`)
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
    const requested = frames[0]!.payload as Extract<MuxFrame, { type: 'approval/requested' }>
    expect(requested.sessionId).toBe(sessionId)
    expect(requested.toolName).toBe('mock side effect')
    const receipt = await api.respond({
      type: 'client-response',
      rpcId: RpcId(frames[0]!.rpcId),
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
    expect(frames[1]!.payload).toEqual(expect.objectContaining({
      type: 'approval/resolved',
      sessionId,
      approvalId: requested.approvalId,
      outcome: 'allowed-once',
    }))
  })

  it('rejects fork loud but accepts rerun as a no-op for member session ids', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const sessionId = SessionId('member:architect:some-topic')
    // A member topic cannot truncate its own log; the caller's follow-up prompt
    // is the re-run. Fork has no ACP inverse in the dsh bridge — stays rejected.
    const fork = expectErr(await api.sessions.fork(request({ sessionId })))
    expect(fork.code).toBe('internal')
    expect(fork.message).toContain('not supported for member sessions')
    const rerun = expectOk(await api.sessions.rerun(request({ sessionId, atSeq: 5 })))
    expect(rerun.accepted).toBe(true)
  })

  it('refuses queue updates for member session ids loud', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    // Member topics have no local agent inbox; the refusal must not masquerade
    // as "queued item is no longer pending".
    const error = expectErr(await api.sessions.updateQueue(request({
      sessionId: SessionId('member:architect:some-topic'),
      itemId: 'q-1' as never,
      action: { kind: 'remove' },
    })))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('not supported for member sessions')
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
    const sessionId = SessionId(`member:architect:${topicId}`)
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

  it('serves the member model catalog synthesized from its config options', async () => {
    setMockEnv({ MOCK_CONFIG_OPTIONS: '1', MOCK_SESSION_ID: 'models-topic' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const value = expectOk(await api.sessions.models(request({ sessionId: SessionId(`member:architect:${topicId}`) })))
    expect(value.current).toEqual({ provider: 'member', model: 'mock-model-1' })
    expect(value.routable).toBe(true)
    expect(value.failures).toEqual([])
    expect(value.groups).toEqual([
      {
        id: 'member',
        name: 'architect',
        models: [
          { id: 'mock-model-1', name: 'Mock Model 1', description: 'Fast mock model' },
          { id: 'mock-model-2', name: 'Mock Model 2', description: 'Powerful mock model' },
        ],
      },
    ])
  })

  it('selects a member model through the config option and reflects it on re-read', async () => {
    setMockEnv({ MOCK_CONFIG_OPTIONS: '1', MOCK_SESSION_ID: 'select-topic' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const sessionId = SessionId(`member:architect:${topicId}`)
    const selected = expectOk(await api.sessions.selectModel(request({
      sessionId,
      provider: 'member',
      model: 'mock-model-2',
    })))
    expect(selected.selected).toEqual({ provider: 'member', model: 'mock-model-2' })
    const after = expectOk(await api.sessions.models(request({ sessionId })))
    expect(after.current).toEqual({ provider: 'member', model: 'mock-model-2' })
  })

  it('rejects a member model selection the agent does not offer loud', async () => {
    setMockEnv({ MOCK_CONFIG_OPTIONS: '1', MOCK_SESSION_ID: 'bad-select-topic' })
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const error = expectErr(await api.sessions.selectModel(request({
      sessionId: SessionId(`member:architect:${topicId}`),
      provider: 'member',
      model: 'not-offered',
    })))
    expect(error.code).toBe('model-unavailable')
    expect(error.message).toContain('does not offer model "not-offered"')
  })

  it('forwards a member prompt with images and mints them as attachment references', async () => {
    setMockEnv({ MOCK_ECHO_IMAGES: '1', MOCK_SESSION_ID: 'image-topic' })
    const ctx = await harness()
    // The member image path takes the same admission as the main path.
    const saveImage = vi.fn((input: { data: Uint8Array; mediaType: string }) => Promise.resolve({
      attachmentId: `att-${String(input.data[0])}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }))
    const attachments = {
      imageLimits: {
        maxImageBytes: 4,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 8,
        maxImagePixels: 4,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      validateImage: vi.fn(() => Promise.resolve()),
      saveImage,
    }
    ctx.provide('attachments', Object.setPrototypeOf(attachments, AttachmentStore.prototype) as never)
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const sessionId = SessionId(`member:architect:${topicId}`)
    // The agent echoes the block types it received, proving the image crossed the wire.
    const framesPromise = collectMux(api, ['session/event'], 8, async () => {
      expectOk(await api.sessions.prompt(request({
        sessionId,
        mode: 'queue',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', mediaType: 'image/png', data: 'AQ==' },
        ],
      })))
      await waitForStatus(api, 'architect', 'idle')
    })
    const frames = await framesPromise
    const events = frames.filter((frame): frame is Extract<typeof frame, { type: 'session/event' }> => frame.type === 'session/event')
      .map(frame => frame.event)
    expect(events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/chunk', 'assistant/chunk', 'assistant/message', 'step/end', 'turn/end',
    ])
    const userMessage = events.find(event => event.type === 'user/message')?.data as { content: unknown[] } | undefined
    expect(userMessage?.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ])
    const assistant = events.find(event => event.type === 'assistant/message')?.data as { message: { content: { type: string; text?: string }[] } } | undefined
    expect(assistant?.message.content).toEqual([{ type: 'text', text: 'blocks:text+image' }])
  })

  it('serves an admitted member image back through session.attachment', async () => {
    setMockEnv({ MOCK_SESSION_ID: 'image-read-topic' })
    const ctx = await harness()
    const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as never
    const saveImage = vi.fn(() => Promise.resolve(ref))
    const readImage = vi.fn((storedRef: typeof ref) => Promise.resolve({ ref: storedRef, data: Uint8Array.of(1) }))
    const attachments = {
      imageLimits: {
        maxImageBytes: 4,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 8,
        maxImagePixels: 4,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      validateImage: vi.fn(() => Promise.resolve()),
      saveImage,
      readImage,
    }
    ctx.provide('attachments', Object.setPrototypeOf(attachments, AttachmentStore.prototype) as never)
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const sessionId = SessionId(`member:architect:${topicId}`)
    expectOk(await api.sessions.prompt(request({
      sessionId,
      mode: 'queue',
      content: [{ type: 'image', mediaType: 'image/png', data: 'AQ==' }],
    })))
    await waitForStatus(api, 'architect', 'idle')
    // The user bubble resolves its image through the session-authorized read;
    // member topics have no host log, so admission is the authorization.
    const served = expectOk(await api.sessions.attachment(request({ sessionId, attachmentId: 'att-1' as never })))
    expect(served).toEqual({ attachment: ref, data: 'AQ==' })
    expect(readImage).toHaveBeenCalledOnce()
    // An id this process never admitted stays refused.
    const denied = await api.sessions.attachment(request({ sessionId, attachmentId: 'att-9' as never }))
    expect(denied.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'ATTACHMENT_NOT_ADMITTED' } },
    })
  })

  it('denies an over-limit member image batch before the turn opens', async () => {
    setMockEnv({ MOCK_SESSION_ID: 'limit-topic' })
    const ctx = await harness()
    const saveImage = vi.fn(() => Promise.resolve({
      attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }))
    const attachments = {
      imageLimits: {
        maxImageBytes: 4,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 8,
        maxImagePixels: 4,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      validateImage: vi.fn(() => Promise.resolve()),
      saveImage,
    }
    ctx.provide('attachments', Object.setPrototypeOf(attachments, AttachmentStore.prototype) as never)
    const api = createApiProxy(ctx, DEFAULTS)
    await api.team.start(request({ memberId: 'architect' }))
    const { sessionId: topicId } = expectOk(await api.team.newSession(request({ memberId: 'architect' })))
    const denied = await api.sessions.prompt(request({
      sessionId: SessionId(`member:architect:${topicId}`),
      mode: 'queue',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'AQ==' },
        { type: 'image', mediaType: 'image/png', data: 'Ag==' },
      ],
    }))
    expect(denied.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'TOO_MANY_IMAGES' } },
    })
    expect(saveImage).not.toHaveBeenCalled()
  })
})
