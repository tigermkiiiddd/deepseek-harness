import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

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
})
