import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentStatus } from '@deepseek-ai/dsh-agent'

import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reseed-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, root }
}

function waitForStatus(ctx: Context, agent: Agent, status: AgentStatus): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status: current }) => {
      if (subject === agent && current === status) { dispose(); resolve() }
    })
  })
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return waitForStatus(ctx, agent, 'idle')
}

describe('AgentLoop factory reseed', () => {
  it('rebuilds an idle live agent in place on the kept prefix', async () => {
    const adapter = new MockAdapter([
      textResponse('first answer'),
      textResponse('second answer'),
      textResponse('third answer'),
    ])
    const { ctx } = await persistentHarness(adapter)
    const sessionId = SessionId('reseed-idle')
    const disposed: Agent[] = []
    ctx.on('agent/disposed', ({ agent }) => void disposed.push(agent))
    const sources: string[] = []
    ctx.on('agent/session-start', ({ source }) => void sources.push(source))

    const first = await ctx.agents.create({
      sessionId,
      meta: { cwd: '/w' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first.agent)
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first.agent)
    const events = [...first.agent.session.events]
    // Cut at the second turn's start: the kept prefix is exactly the first
    // turn. The followup's inbox admission splice precedes its turn/start, so
    // a cut that drops the second turn must also drop that splice — otherwise
    // the rebuilt agent inherits it as a pending message (the caller owns cut
    // computation; the fork path has the same boundary rule).
    const turnStarts = events.flatMap((event, index) => event.type === 'turn/start' ? [index] : [])
    let keepSeqs = turnStarts[1]!
    while (events[keepSeqs - 1]?.type === 'agent/inbox/spliced') keepSeqs -= 1
    const prefix = events.slice(0, keepSeqs)

    const rebuilt = await ctx.agents.reseed({ sessionId, keepSeqs })

    // The old lifecycle is gone; the same identity now names the rebuilt agent.
    expect(disposed).toEqual([first.agent])
    expect(rebuilt.agent).not.toBe(first.agent)
    expect(ctx.agents.get(sessionId)).toBe(rebuilt.agent)
    expect(rebuilt.agent.session.id).toBe(sessionId)
    expect(sources).toEqual(['startup', 'resume'])
    // The rebuilt log is the captured prefix plus the constructor end-seed marker.
    expect(rebuilt.agent.session.events).toHaveLength(keepSeqs + 1)
    expect([...rebuilt.agent.session.events.slice(0, keepSeqs)]).toEqual(prefix)
    expect(rebuilt.agent.session.events.at(-1)?.type).toBe('session/end-seed')
    // Truncation leaves the durable header unchanged; the in-memory header carries it.
    expect(rebuilt.agent.session.header.cwd).toBe('/w')
    expect(rebuilt.agent.session.header.createdAt).toBe(first.agent.session.header.createdAt)
    // Agent options carry forward when not overridden.
    expect(rebuilt.agent.options.provider).toBe('mock')
    expect(rebuilt.agent.options.model).toBe('mock')
    // The dropped turn is gone from the model-visible history.
    const messages = JSON.stringify(rebuilt.agent.session.deriveMessages())
    expect(messages).toContain('first question')
    expect(messages).not.toContain('second question')

    // A subsequent turn continues right after the marker (its inbox splice
    // precedes turn/start), with contiguous seqs.
    rebuilt.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'third question' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, rebuilt.agent)
    const continued = rebuilt.agent.session.events
    const newTurn = continued.findIndex((event, index) => index > keepSeqs && event.type === 'turn/start')
    expect(newTurn).toBeGreaterThan(keepSeqs)
    expect(continued[newTurn - 1]).toMatchObject({ type: 'agent/inbox/spliced' })
    expect(continued.map(event => event.seq)).toEqual(continued.map((_, index) => index))
    // The model request for the new turn never saw the dropped region.
    expect(adapter.requests).toHaveLength(3)
    const lastRequest = adapter.requests.at(-1)
    expect(JSON.stringify(lastRequest?.messages)).not.toContain('second question')

    // The durable log was physically truncated: after teardown it holds no
    // trace of the dropped turn.
    await rebuilt.dispose()
    const stored = await ctx.sessionPersistence.load(sessionId)
    expect(stored.events).toHaveLength(continued.length)
    expect(JSON.stringify(stored.events)).not.toContain('second question')
    expect(JSON.stringify(stored.events)).toContain('third answer')
    await ctx.fiber.dispose()
  })

  it('applies explicit meta overrides over the carried header and runs setup before publication', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([textResponse('a')]))
    const sessionId = SessionId('reseed-meta')
    const first = await ctx.agents.create({
      sessionId,
      meta: { cwd: '/w' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first.agent)
    const keepSeqs = first.agent.session.events.length
    const setupObservations: Array<{ published: boolean; agentPreset: string | undefined }> = []

    const rebuilt = await ctx.agents.reseed({
      sessionId,
      keepSeqs,
      meta: { agentPreset: 'preset-x' },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: (agentCtx) => {
        setupObservations.push({
          published: ctx.agents.get(sessionId) !== undefined,
          agentPreset: agentCtx.agent?.session.header.agentPreset,
        })
      },
    })

    expect(setupObservations).toEqual([{ published: false, agentPreset: 'preset-x' }])
    expect(rebuilt.agent.session.header.agentPreset).toBe('preset-x')
    expect(rebuilt.agent.session.header.cwd).toBe('/w')
    expect(rebuilt.agent.session.header.createdAt).toBe(first.agent.session.header.createdAt)
    expect(rebuilt.agent.session.events).toHaveLength(keepSeqs + 1)
    await rebuilt.dispose()
    await ctx.fiber.dispose()
  })

  it('stops a running turn and rebuilds on the prefix', async () => {
    const adapter = new MockAdapter(['hang', textResponse('rebuilt answer')])
    const { ctx } = await persistentHarness(adapter)
    const sessionId = SessionId('reseed-running')
    const disposed: Agent[] = []
    ctx.on('agent/disposed', ({ agent }) => void disposed.push(agent))

    const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    const running = waitForStatus(ctx, first.agent, 'running')
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'slow question' }], source: { kind: 'user' } }))
    await running
    expect(first.agent.status).toBe('running')
    // The hung stream must be the one in flight before the reseed, so the
    // rebuilt turn gets the scripted reply.
    await expect.poll(() => adapter.requests.length).toBe(1)

    // keepSeqs 0 drops the open turn along with everything else; the live
    // handle's teardown cancels the hung stream before truncation.
    const rebuilt = await ctx.agents.reseed({ sessionId, keepSeqs: 0 })
    expect(disposed).toEqual([first.agent])
    expect(rebuilt.agent.session.events.map(event => event.type)).toEqual(['session/end-seed'])

    rebuilt.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'after' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, rebuilt.agent)
    expect(rebuilt.agent.session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant'])

    await rebuilt.dispose()
    const stored = await ctx.sessionPersistence.load(sessionId)
    expect(JSON.stringify(stored.events)).not.toContain('partial')
    expect(JSON.stringify(stored.events)).toContain('rebuilt answer')
    await ctx.fiber.dispose()
  })

  it('rejects when no live agent has the session id', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    await expect(ctx.agents.reseed({ sessionId: SessionId('reseed-unknown'), keepSeqs: 0 }))
      .rejects.toThrow('cannot reseed session "reseed-unknown": no live agent has that id')
    await ctx.fiber.dispose()
  })

  it('rejects an invalid keepSeqs with the coordinator taxonomy', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('reseed-bad-cut')
    await ctx.agents.create({ sessionId })
    const length = ctx.agents.get(sessionId)!.session.events.length

    await expect(ctx.agents.reseed({ sessionId, keepSeqs: -1 }))
      .rejects.toThrow(new TypeError('reseed keepSeqs must be a non-negative safe integer, got -1'))
    await expect(ctx.agents.reseed({ sessionId, keepSeqs: 1.5 }))
      .rejects.toThrow(new TypeError('reseed keepSeqs must be a non-negative safe integer, got 1.5'))
    await expect(ctx.agents.reseed({ sessionId, keepSeqs: length + 1 }))
      .rejects.toThrow(new RangeError(`reseed keepSeqs ${length + 1} exceeds the live log length ${length} for session "${sessionId}"`))

    // Failed validation leaves the live agent untouched.
    expect(ctx.agents.get(sessionId)).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('rejects when session persistence is not configured', async () => {
    const adapter = new MockAdapter([textResponse('x')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const sessionId = SessionId('reseed-no-persistence')
    await ctx.agents.create({ sessionId })

    await expect(ctx.agents.reseed({ sessionId, keepSeqs: 0 }))
      .rejects.toThrow(/cannot reseed: session persistence is not configured/)
    expect(ctx.agents.get(sessionId)).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('rejects a live agent this loop does not own', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('reseed-foreign')
    const foreign = { id: sessionId, session: { id: sessionId } } as unknown as Agent
    const detach = ctx.agents.register(foreign)

    await expect(ctx.agents.reseed({ sessionId, keepSeqs: 0 }))
      .rejects.toThrow(`cannot reseed session "${sessionId}": its live agent is not owned by this agent loop`)
    expect(ctx.agents.get(sessionId)).toBe(foreign)
    detach()
    await ctx.fiber.dispose()
  })

  it('rejects when the loop becomes inactive after truncation', async () => {
    const { ctx } = await persistentHarness(new MockAdapter([textResponse('x')]))
    const sessionId = SessionId('reseed-loop-inactive')
    const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    // Materialize a durable artifact so truncation has a log to rewrite.
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first.agent)
    const loop = ctx.agentLoop as unknown as {
      ownership: { isActive: () => boolean }
    }
    vi.spyOn(loop.ownership, 'isActive').mockReturnValueOnce(false)

    await expect(ctx.agents.reseed({ sessionId, keepSeqs: 0 }))
      .rejects.toThrow('agent loop is not active')
    // The old lifecycle was torn down and nothing was republished.
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps a same-id replacement created during session disposal as the keyed live teardown', async () => {
    const adapter = new MockAdapter([textResponse('replacement turn')])
    const { ctx } = await persistentHarness(adapter)
    const sessionId = SessionId('reseed-replacement')
    const first = await ctx.agents.create({ sessionId })
    let replacement: Promise<AgentHandle> | undefined
    ctx.on('session/disposed', (session) => {
      if (session.id !== sessionId) return
      // Synchronously mint the next same-id lifecycle from inside teardown:
      // its keyed teardown claim must survive the outgoing lifecycle's untrack.
      replacement ??= ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    })

    await first.dispose()
    const second = await replacement!
    expect(ctx.agents.get(sessionId)).toBe(second.agent)
    second.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'kept' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, second.agent)

    // Reseed still finds the replacement's teardown — proof the first
    // lifecycle's untrack did not delete the newer claim.
    const rebuilt = await ctx.agents.reseed({ sessionId, keepSeqs: 0 })
    expect(rebuilt.agent).not.toBe(second.agent)
    expect(ctx.agents.get(sessionId)).toBe(rebuilt.agent)
    await rebuilt.dispose()
    await ctx.fiber.dispose()
  })
})
