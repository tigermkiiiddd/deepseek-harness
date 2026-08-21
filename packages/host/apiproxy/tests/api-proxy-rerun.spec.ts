/** In-place session rerun: live reseed, the inbox-splice back-up rule, cold truncation, and guards. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ReseedAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`rerun-${String(nextRpc++)}`), payload }
}

/** One live agent lifecycle the reseed double can tear down before rebuilding under the same id. */
interface LiveEntry {
  session: Session
  followup: ReturnType<typeof vi.fn>
  teardown: () => void
}

async function composed(): Promise<{ ctx: Context; live: Map<SessionId, LiveEntry> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  const live = new Map<SessionId, LiveEntry>()
  ctx.agents.setFactory({
    createAgent: () => Promise.reject(new Error('rerun tests create sessions directly')),
    resume: () => Promise.reject(new Error('rerun test sources are live or persistence-doubled')),
    async reseedAgent(ownerCtx: Context, options: ReseedAgentOptions): Promise<AgentHandle> {
      const entry = live.get(options.sessionId)
      if (entry === undefined) throw new Error(`reseed: no live agent "${options.sessionId}"`)
      const seed = entry.session.events.slice(0, options.keepSeqs)
      const header = entry.session.header
      entry.teardown()
      live.delete(options.sessionId)
      const session = ctx.sessions.prepare(options.sessionId, {
        seed: [...seed],
        // The real factory carries the durable header forward when meta is omitted.
        meta: options.meta ?? { ...header.cwd === undefined ? {} : { cwd: header.cwd } },
      })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const followup = vi.fn()
      const agent = { id: session.id, session, status: 'idle', followup } as unknown as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, { ctx: agentCtx })
      await options.setup?.(agentCtx)
      const unregister = ctx.agents.register(agent)
      live.set(options.sessionId, { session, followup, teardown: () => { unregister(); detach() } })
      return { agent, dispose: () => Promise.resolve() }
    },
  })
  return { ctx, live }
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `prompt ${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Publish a session through the store's public prepare/enter/announce so tests own its detach. */
function publish(ctx: Context, id: string, meta?: { origin?: 'subagent' }): { session: Session; detach: () => void } {
  const session = ctx.sessions.prepare(sid(id), { meta: { cwd: '/proj', ...meta } })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  return { session, detach }
}

/** Register one live agent whose log holds `turns` completed turns. */
function liveAgent(
  ctx: Context,
  live: Map<SessionId, LiveEntry>,
  id: string,
  turns: number,
  meta?: { origin?: 'subagent' },
): { session: Session; agent: Agent } {
  const { session, detach } = publish(ctx, id, meta)
  for (let turn = 1; turn <= turns; turn++) appendTurn(session, turn)
  const followup = vi.fn()
  const agent = { id: session.id, session, status: 'idle', followup, ctx } as unknown as Agent
  const unregister = ctx.agents.register(agent)
  live.set(session.id, { session, followup, teardown: () => { unregister(); detach() } })
  return { session, agent }
}

describe('sessions.rerun', () => {
  it('rebuilds the live agent in place on the prefix before the anchored turn', async () => {
    const { ctx, live } = await composed()
    // A standalone out-of-band append after the boundary turn rides the kept
    // prefix (the cut extends through it to the next turn/start).
    const { session, detach } = publish(ctx, 'session-rerun')
    appendTurn(session, 1)
    session.append('session/title', { title: 'kept title', messageSeqs: [1], source: { kind: 'fallback' } })
    appendTurn(session, 2)
    appendTurn(session, 3)
    const followup = vi.fn()
    const agent = { id: session.id, session, status: 'idle', followup, ctx } as unknown as Agent
    const unregister = ctx.agents.register(agent)
    live.set(session.id, { session, followup, teardown: () => { unregister(); detach() } })

    // Anchor on turn 2's user message (seq 5): turn 2 and 3 are dropped, the
    // title sitting between turn 1 and 2 survives.
    const proxy = api(ctx)
    const response = await proxy.sessions.rerun(request({ sessionId: session.id, atSeq: 5 }))
    expect(response.result).toMatchObject({ ok: true, value: { accepted: true } })

    const rebuiltAgent = ctx.agents.get(session.id)
    if (rebuiltAgent === undefined) throw new Error('rerun did not republish the agent')
    expect(rebuiltAgent).not.toBe(agent)
    expect(rebuiltAgent.session.id).toBe(session.id)
    expect(rebuiltAgent.session.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'session/title', 'session/end-seed',
    ])
    expect(JSON.stringify(rebuiltAgent.session.events)).not.toContain('prompt 2')

    // A follow-up prompt reaches the rebuilt agent, not the torn-down one.
    const promptResponse = await proxy.sessions.prompt(request({
      sessionId: session.id,
      mode: 'queue',
      content: [{ type: 'text', text: 'again' }],
    }))
    expect(promptResponse.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(live.get(session.id)?.followup).toHaveBeenCalledOnce()
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('drops the admission splice that precedes the dropped message turn/start', async () => {
    const { ctx, live } = await composed()
    const { session } = liveAgent(ctx, live, 'session-splice', 1)
    // A followup message's admission splice lands BEFORE its turn/start.
    session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [createUserMessage({ content: [{ type: 'text', text: 'queued second' }], source: { kind: 'user' } })],
    })
    appendTurn(session, 2)

    // Anchor on turn 2's user message (seq 5): keeping the splice would
    // re-admit the dropped message into the rebuilt agent's inbox.
    const response = await api(ctx).sessions.rerun(request({ sessionId: session.id, atSeq: 5 }))
    expect(response.result).toMatchObject({ ok: true, value: { accepted: true } })
    const rebuiltAgent = ctx.agents.get(session.id)
    expect(rebuiltAgent?.session.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'session/end-seed',
    ])
    await ctx.fiber.dispose()
  })

  it('keeps an empty prefix when the anchor sits in the first turn', async () => {
    const { ctx, live } = await composed()
    const { session } = liveAgent(ctx, live, 'session-first', 2)
    const response = await api(ctx).sessions.rerun(request({ sessionId: session.id, atSeq: 1 }))
    expect(response.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(ctx.agents.get(session.id)?.session.events.map(event => event.type)).toEqual(['session/end-seed'])
    await ctx.fiber.dispose()
  })

  it('rejects an anchor beyond the log end', async () => {
    const { ctx, live } = await composed()
    const { session } = liveAgent(ctx, live, 'session-past-end', 1)
    const proxy = api(ctx)
    const pastEnd = await proxy.sessions.rerun(request({ sessionId: session.id, atSeq: 999 }))
    expect(pastEnd.result).toMatchObject({
      ok: false,
      error: { code: 'rerun-unavailable', details: { sessionId: session.id } },
    })
    // An empty log has no event to anchor on either.
    const blank = liveAgent(ctx, live, 'session-blank', 0)
    const empty = await proxy.sessions.rerun(request({ sessionId: blank.session.id, atSeq: 0 }))
    expect(empty.result).toMatchObject({
      ok: false,
      error: { code: 'rerun-unavailable', details: { sessionId: blank.session.id } },
    })
    expect(ctx.agents.get(session.id)?.session.events).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it('truncates a persisted-but-not-live session without creating an agent', async () => {
    const { ctx } = await composed()
    const sourceId = sid('session-cold')
    const header: SessionHeader = { version: 0, id: sourceId, createdAt: 1, cwd: '/proj' }
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } },
      {
        type: 'user/message',
        seq: 4,
        time: 5,
        data: createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const truncate = vi.fn<(id: SessionId, keepSeqs: number) => Promise<void>>()
      .mockImplementation((id, keepSeqs) => {
        expect(id).toBe(sourceId)
        events.length = keepSeqs
        return Promise.resolve()
      })
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({ meta: header, events: [...events] }),
      truncate,
    } as never)

    const response = await api(ctx).sessions.rerun(request({ sessionId: sourceId, atSeq: 4 }))

    expect(response.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(truncate).toHaveBeenCalledWith(sourceId, 3)
    expect(events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(ctx.agents.get(sourceId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects a session-backed subagent with agent-busy', async () => {
    const { ctx, live } = await composed()
    const { session } = liveAgent(ctx, live, 'session-owned', 1, { origin: 'subagent' })
    const response = await api(ctx).sessions.rerun(request({ sessionId: session.id, atSeq: 1 }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'agent-busy', details: { reason: 'use subagent delivery for this child session' } },
    })
    expect(ctx.agents.get(session.id)?.session.events).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it('reports an unknown session as session-not-found when persistence can answer', async () => {
    const { ctx } = await composed()
    ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    const missing = sid('session-missing')
    const response = await api(ctx).sessions.rerun(request({ sessionId: missing, atSeq: 0 }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'session-not-found', details: { sessionId: missing } },
    })
    await ctx.fiber.dispose()
  })

  it('reports an unreadable source as internal', async () => {
    const { ctx } = await composed()
    // No persistence mounted: inspecting a detached session fails before any cut.
    const response = await api(ctx).sessions.rerun(request({ sessionId: sid('session-nowhere'), atSeq: 0 }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!response.result.ok) expect(response.result.error.message).toMatch(/rerun source unavailable/)
    await ctx.fiber.dispose()
  })

  it('maps a reseed failure to internal', async () => {
    const { ctx } = await composed()
    // A live agent the double's lifecycle map does not own: the factory
    // rejects, and the gateway folds that into an internal error.
    const { session } = publish(ctx, 'session-foreign')
    appendTurn(session, 1)
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as unknown as Agent)
    const response = await api(ctx).sessions.rerun(request({ sessionId: session.id, atSeq: 1 }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!response.result.ok) expect(response.result.error.message).toMatch(/failed to rerun session/)
    await ctx.fiber.dispose()
  })

  it('reports rerun of an attached agent-less session as internal without persistence', async () => {
    const { ctx } = await composed()
    const { session } = publish(ctx, 'session-detached')
    appendTurn(session, 1)
    const response = await api(ctx).sessions.rerun(request({ sessionId: session.id, atSeq: 1 }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!response.result.ok) expect(response.result.error.message).toMatch(/no session-persistence service/)
    await ctx.fiber.dispose()
  })

  it('maps a truncation failure to internal', async () => {
    const { ctx } = await composed()
    const sourceId = sid('session-cold-failing')
    const header: SessionHeader = { version: 0, id: sourceId, createdAt: 1, cwd: '/proj' }
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({ meta: header, events }),
      truncate: () => Promise.reject(new Error('disk full')),
    } as never)
    const response = await api(ctx).sessions.rerun(request({ sessionId: sourceId, atSeq: 1 }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!response.result.ok) expect(response.result.error.message).toMatch(/failed to rerun session/)
    await ctx.fiber.dispose()
  })
})
