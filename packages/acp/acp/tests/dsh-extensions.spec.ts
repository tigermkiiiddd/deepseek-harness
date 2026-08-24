import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

/**
 * dsh extension surface coverage: the bridge advertises its extMethod registry
 * in initialize, serves `dsh/session/historyPage` windows over the persisted
 * log, and fails loud on unknown methods, unknown sessions, and malformed
 * parameters.
 */

/** Build a minimal persisted user-message event; only the array index matters. */
function userEvent(text: string): SessionEvent {
  return {
    type: 'user/message',
    id: `evt-${text}`,
    timestamp: 0,
    payload: { text },
  } as unknown as SessionEvent
}

describe('dsh extension surface', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  const EVENTS: Record<string, SessionEvent[]> = {
    topic: Array.from({ length: 7 }, (_, index) => userEvent(`m${index}`)),
    big: Array.from({ length: 250 }, (_, index) => userEvent(`b${index}`)),
  }

  async function harnessWithHistory(): Promise<BridgeHarness> {
    return makeBridgeHarness({ persistence: { headers: [
      { id: 'topic', cwd: process.cwd() },
      { id: 'big', cwd: process.cwd() },
    ], eventsBySession: EVENTS } })
  }

  it('advertises the extension registry in initialize', async () => {
    harness = await harnessWithHistory()
    const { agentCapabilities } = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    const meta = (agentCapabilities as { _meta?: { dsh?: { extensions?: string[] } } })._meta
    expect(meta?.dsh?.extensions).toContain('dsh/session/historyPage')
  })

  it('serves the latest window when before is absent', async () => {
    harness = await harnessWithHistory()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const result = await harness.client.extMethod('dsh/session/historyPage', {
      sessionId: 'topic',
      limit: 3,
    }) as { events: unknown[]; total: number; nextBefore?: number }
    expect(result.events).toHaveLength(3)
    expect(result.total).toBe(7)
    expect(result.nextBefore).toBe(4)
  })

  it('walks to the oldest page and omits nextBefore there', async () => {
    harness = await harnessWithHistory()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const first = await harness.client.extMethod('dsh/session/historyPage', {
      sessionId: 'topic', limit: 5,
    }) as { nextBefore?: number }
    expect(first.nextBefore).toBe(2)
    const oldest = await harness.client.extMethod('dsh/session/historyPage', {
      sessionId: 'topic', limit: 5, before: first.nextBefore,
    }) as { events: unknown[]; total: number; nextBefore?: number }
    expect(oldest.events).toHaveLength(2)
    expect(oldest.total).toBe(7)
    expect(oldest.nextBefore).toBeUndefined()
  })

  it('clamps an oversized limit to the page maximum', async () => {
    harness = await harnessWithHistory()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const result = await harness.client.extMethod('dsh/session/historyPage', {
      sessionId: 'big', limit: 10_000,
    }) as { events: unknown[]; total: number; nextBefore?: number }
    expect(result.events.length).toBeLessThanOrEqual(200)
    expect(result.total).toBe(250)
  })

  it('rejects an unsupported extension method', async () => {
    harness = await harnessWithHistory()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.extMethod('dsh/session/nonexistent', {
      sessionId: 'topic',
    })).rejects.toThrow(/unsupported dsh extension/)
  })

  it('rejects malformed parameters and unknown sessions', async () => {
    harness = await harnessWithHistory()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(harness.client.extMethod('dsh/session/historyPage', {
      limit: 5,
    })).rejects.toThrow(/sessionId must be a non-empty string/)

    await expect(harness.client.extMethod('dsh/session/historyPage', {
      sessionId: 'topic', limit: 0,
    })).rejects.toThrow(/limit must be a positive integer/)

    await expect(harness.client.extMethod('dsh/session/historyPage', {
      sessionId: 'topic', limit: 5, before: -1,
    })).rejects.toThrow(/before must be a non-negative integer/)

    await expect(harness.client.extMethod('dsh/session/historyPage', {
      sessionId: 'missing', limit: 5,
    })).rejects.toThrow(/unknown session/)
  })

  it('renames a live session through the title service', async () => {
    harness = await makeBridgeHarness({ titleService: 'ok' })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const result = await harness.client.extMethod('dsh/session/rename', {
      sessionId,
      title: 'New Name',
    }) as { title: string; seq: number }
    expect(result).toEqual({ title: 'accepted', seq: 5 })
  })

  it('classifies a rejected title as a parameter error and a miss as unknown session', async () => {
    harness = await makeBridgeHarness({ titleService: 'invalid' })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.extMethod('dsh/session/rename', {
      sessionId,
      title: '',
    })).rejects.toThrow(/title must be a non-empty string/)

    await expect(harness.client.extMethod('dsh/session/rename', {
      sessionId,
      title: 'bad',
    })).rejects.toThrow(/invalid title: the title is empty/)

    await expect(harness.client.extMethod('dsh/session/rename', {
      sessionId: 'nope',
      title: 'bad',
    })).rejects.toThrow(/unknown session/)
  })

  it('fails loud when no title service is mounted', async () => {
    harness = await makeBridgeHarness({ titleService: 'none' })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.extMethod('dsh/session/rename', {
      sessionId,
      title: 'Any',
    })).rejects.toThrow(/requires a session-title service/)
  })

  describe('dsh/session/queue', () => {
    let harness: BridgeHarness | undefined
    let sessionId: string | undefined

    afterEach(async () => {
      await harness?.dispose()
      harness = undefined
      sessionId = undefined
    })

    /** Mount a live session for queue operations. */
    async function liveSession(): Promise<string> {
      harness = await makeBridgeHarness()
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      sessionId = created.sessionId
      return sessionId
    }

    const queue = (payload: Record<string, unknown>): Promise<unknown> =>
      harness!.client.extMethod('dsh/session/queue', payload)

    it('enqueues, lists, edits, and removes a pending item', async () => {
      const id = await liveSession()

      expect(await queue({ sessionId: id, op: 'list' })).toEqual({ items: [] })

      const enqueued = await queue({ sessionId: id, op: 'enqueue', text: 'later question' }) as { itemId: string }
      expect(enqueued.itemId).toBeDefined()

      let listed = await queue({ sessionId: id, op: 'list' }) as { items: { id: string; slot: string; text: string }[] }
      expect(listed.items).toEqual([{ id: enqueued.itemId, slot: 'next-turn', text: 'later question' }])

      await queue({ sessionId: id, op: 'edit', itemId: enqueued.itemId, text: 'edited question' })
      listed = await queue({ sessionId: id, op: 'list' }) as { items: { id: string; slot: string; text: string }[] }
      expect(listed.items[0]?.text).toBe('edited question')

      await queue({ sessionId: id, op: 'remove', itemId: enqueued.itemId })
      expect(await queue({ sessionId: id, op: 'list' })).toEqual({ items: [] })

      await expect(queue({ sessionId: id, op: 'remove', itemId: enqueued.itemId }))
        .rejects.toThrow(/no longer pending/)
    })

    it('refuses steering an idle session and fails loud on bad input', async () => {
      const id = await liveSession()
      const enqueued = await queue({ sessionId: id, op: 'enqueue', text: 'hold' }) as { itemId: string }

      // An idle session has no turn in flight, so steering is refused.
      await expect(queue({ sessionId: id, op: 'steer', itemId: enqueued.itemId }))
        .rejects.toThrow(/no longer accepts steering/)

      await expect(queue({ sessionId: id, op: 'enqueue', text: '' })).rejects.toThrow(/non-empty string/)
      await expect(queue({ sessionId: id, op: 'wat' })).rejects.toThrow(/unsupported queue op/)
      await expect(queue({ sessionId: 'missing', op: 'list' })).rejects.toThrow(/unknown session/)
    })
  })

  describe('dsh/attachment/get', () => {
    let harness: BridgeHarness | undefined

    afterEach(async () => {
      await harness?.dispose()
      harness = undefined
    })

    it('serves an admitted image back as base64 and rejects unknown ids', async () => {
      // The prompt path admits the image into the store; reading it back is
      // the same record.
      const PNG_1PX = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      )
      harness = await makeBridgeHarness({ imageCapable: true, script: [textResponse('ok')] })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      const saved = harness.attachments?.saved.at(-1)
      // Drive admission through a real image prompt so an id exists to read.
      await harness.client.prompt({
        sessionId,
        prompt: [{ type: 'image', data: PNG_1PX.toString('base64'), mimeType: 'image/png' }],
      })

      const storedId = harness.attachments?.objects.keys().next().value as string | undefined
      expect(storedId).toBeDefined()
      void saved
      const result = await harness.client.extMethod('dsh/attachment/get', {
        attachmentId: storedId,
      }) as { mediaType: string; bytes: number; data: string }
      expect(result.mediaType).toBe('image/png')
      expect(result.bytes).toBe(PNG_1PX.byteLength)
      expect(Buffer.from(result.data, 'base64').equals(PNG_1PX)).toBe(true)

      await expect(harness.client.extMethod('dsh/attachment/get', {
        attachmentId: 'sha256:unknown',
      })).rejects.toThrow(/unknown attachment/)
    })
  })

  describe('dsh/session/search', () => {
    let harness: BridgeHarness | undefined

    afterEach(async () => {
      await harness?.dispose()
      harness = undefined
    })

    it('projects hits from the member query service', async () => {
      harness = await makeBridgeHarness({ sessionQuery: 'ok' })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const result = await harness.client.extMethod('dsh/session/search', {
        query: 'matched',
      }) as { hits: { sessionId: string; title?: string; snippet: string }[]; disabled?: boolean }
      expect(result.hits).toEqual([{
        sessionId: 'topic',
        title: 'Topic',
        snippet: '…matched text…',
      }])
      expect(result.disabled).toBeUndefined()
    })

    it('answers disabled instead of erroring when search is off or unmounted', async () => {
      harness = await makeBridgeHarness({ sessionQuery: 'disabled' })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const off = await harness.client.extMethod('dsh/session/search', {
        query: 'x',
      }) as { hits: unknown[]; disabled?: boolean }
      expect(off).toEqual({ hits: [], disabled: true })

      await harness.dispose()
      harness = await makeBridgeHarness()
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const unmounted = await harness.client.extMethod('dsh/session/search', {
        query: 'x',
      }) as { hits: unknown[]; disabled?: boolean }
      expect(unmounted).toEqual({ hits: [], disabled: true })
    })

    it('validates parameters', async () => {
      harness = await makeBridgeHarness({ sessionQuery: 'ok' })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      await expect(harness.client.extMethod('dsh/session/search', {})).rejects.toThrow(/query must be a non-empty string/)
      await expect(harness.client.extMethod('dsh/session/search', { query: 'x', limit: 0 })).rejects.toThrow(/limit must be a positive integer/)
    })
  })

  describe('dsh/session/state and dsh/session/compact', () => {
    let harness: BridgeHarness | undefined

    afterEach(async () => {
      await harness?.dispose()
      harness = undefined
    })

    const STATE_EVENTS: Record<string, SessionEvent[]> = {
      topic: [
        { type: 'todo/write', data: { todos: [{ content: 'a', status: 'completed' }] } },
        { type: 'plan/mode', data: { active: true } },
        { type: 'goal/change', data: { objective: 'ship it' } },
      ] as unknown as SessionEvent[],
      empty: [],
    }

    async function stateHarness(compaction: 'none' | 'ok'): Promise<BridgeHarness> {
      return makeBridgeHarness({
        compaction,
        persistence: { headers: [{ id: 'topic', cwd: process.cwd() }, { id: 'empty', cwd: process.cwd() }], eventsBySession: STATE_EVENTS },
      })
    }

    it('folds the collaboration-state snapshot from the log, each domain optional', async () => {
      harness = await stateHarness('ok')
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

      const full = await harness.client.extMethod('dsh/session/state', { sessionId: 'topic' }) as Record<string, unknown>
      expect(full).toEqual({
        todo: { todos: [{ content: 'a', status: 'completed' }] },
        planMode: { active: true },
        goal: { objective: 'ship it' },
      })

      const blank = await harness.client.extMethod('dsh/session/state', { sessionId: 'empty' }) as Record<string, unknown>
      expect(blank).toEqual({})
    })

    it('drives the member compaction service against the live agent', async () => {
      harness = await makeBridgeHarness({ compaction: 'ok', script: [textResponse('ok')] })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

      const result = await harness.client.extMethod('dsh/session/compact', { sessionId }) as { accepted: boolean }
      expect(result.accepted).toBe(true)
      expect(harness.compactedWith).toHaveLength(1)
      expect(harness.compactedWith[0]).toBeDefined()

      await expect(harness.client.extMethod('dsh/session/compact', { sessionId: 'missing' }))
        .rejects.toThrow(/unknown session/)

      await harness.dispose()
      harness = await makeBridgeHarness()
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      await expect(harness.client.extMethod('dsh/session/compact', { sessionId: created.sessionId }))
        .rejects.toThrow(/requires a compaction service/)
    })
  })

  describe('user questions over the reverse extension channel', () => {
    let harness: BridgeHarness | undefined

    afterEach(async () => {
      await harness?.dispose()
      harness = undefined
    })

    it('round-trips a member ask through dsh/user/question', async () => {
      harness = await makeBridgeHarness({
        questions: true,
        onQuestion: questions => ({
          answers: [{ id: (questions as { id: string }[])[0]?.id, selected: ['Option A'] }],
        }),
      })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

      // The bridge registered itself as the member's question provider; the
      // service's ask() is the exact seam the member's tool path calls.
      const userQuestions = harness.ctx.get('userQuestions') as {
        ask(request: { questions: unknown }): Promise<{ answers: { id?: string; selected: string[] }[] }>
      }
      const answer = await userQuestions.ask({
        questions: [{ id: 'q1', question: 'Which way?', options: [{ label: 'Option A' }, { label: 'Option B' }] }],
      })
      expect(answer.answers).toEqual([{ id: 'q1', selected: ['Option A'] }])
    })

    it('fails soft when the client does not answer questions', async () => {
      harness = await makeBridgeHarness({ questions: true })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

      const userQuestions = harness.ctx.get('userQuestions') as {
        ask(request: { questions: unknown }): Promise<unknown>
      }
      // The SDK wraps the client's rejection into a generic JSON-RPC internal
      // error by the time it reaches the member process; the detail lives in
      // the wire payload only.
      await expect(userQuestions.ask({
        questions: [{ id: 'q1', question: 'Anyone there?' }],
      })).rejects.toThrow(/Internal error/)
    })
  })
})
