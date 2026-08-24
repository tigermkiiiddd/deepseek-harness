import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

/**
 * Session-list and session-load coverage for the automation ACP bridge: a
 * member process advertises its persisted conversation topics, a client lists
 * them, and loading one resumes the topic's history before the next prompt.
 */

/** A minimal persisted conversation: one user turn and one assistant reply. */
function persistedConversation(userText: string, assistantText: string): SessionEvent[] {
  return [
    {
      type: 'user/message',
      seq: 0,
      time: 1_700_000_000_000,
      surfaceOp: 'append',
      data: createUserMessage({
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }),
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1_700_000_000_001,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'mock', model: 'mock' },
          content: [{ type: 'text', text: assistantText }],
        }),
      },
    },
  ]
}

describe('ACP session listing', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('lists persisted sessions, filtered by workspace', async () => {
    harness = await makeBridgeHarness({
      persistence: {
        headers: [
          { id: 's1', cwd: '/workspace-a' },
          { id: 's2', cwd: '/workspace-b' },
          { id: 's3', cwd: '/workspace-a' },
        ],
        eventsBySession: {},
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    const all = await harness.client.listSessions({})
    expect(all.sessions.map(s => s.sessionId).sort()).toEqual(['s1', 's2', 's3'])

    const filtered = await harness.client.listSessions({ cwd: '/workspace-a' })
    expect(filtered.sessions.map(s => s.sessionId).sort()).toEqual(['s1', 's3'])
  })

  it('rejects listing when no persistence is mounted', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.listSessions({})).rejects.toThrow(/session listing requires session persistence/)
  })
})

describe('ACP session loading', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('loads a persisted session and resumes its history on the next prompt', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('resumed reply')],
      persistence: {
        headers: [{ id: 'topic-1', cwd: process.cwd() }],
        eventsBySession: {
          'topic-1': persistedConversation('earlier question', 'earlier answer'),
        },
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    const loaded = await harness.client.loadSession({
      sessionId: SessionId('topic-1'),
      cwd: process.cwd(),
      mcpServers: [],
    })
    // loadSession returns the model selector options the agent advertises.
    expect(loaded).toEqual({
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'mock',
        options: [{ value: 'mock', name: 'Mock' }],
      }],
    })

    const result = await harness.client.prompt({
      sessionId: 'topic-1',
      prompt: [{ type: 'text', text: 'continue' }],
    })
    expect(result.stopReason).toBe('end_turn')

    // The resumed agent's model request carries the persisted history.
    const request = harness.adapter.requests[0]
    expect(request).toBeDefined()
    expect(request!.messages.some(message =>
      message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === 'earlier question'))).toBe(true)
  })

  it('is idempotent for an already-live session', async () => {
    harness = await makeBridgeHarness({
      persistence: {
        headers: [{ id: 'topic-1', cwd: process.cwd() }],
        eventsBySession: { 'topic-1': persistedConversation('q', 'a') },
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await harness.client.loadSession({ sessionId: SessionId('topic-1'), cwd: process.cwd(), mcpServers: [] })
    await harness.client.loadSession({ sessionId: SessionId('topic-1'), cwd: process.cwd(), mcpServers: [] })
    // Only one agent was materialized for the topic.
    expect(harness.ctx.agents.list().filter(agent => agent.id === SessionId('topic-1'))).toHaveLength(1)
  })

  it('rejects an unknown session id', async () => {
    harness = await makeBridgeHarness({
      persistence: { headers: [], eventsBySession: {} },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(harness.client.loadSession({
      sessionId: SessionId('missing'),
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toThrow(/unknown session/)
  })

  it('streams the persisted history back as user/agent message chunks on load', async () => {
    harness = await makeBridgeHarness({
      persistence: {
        headers: [{ id: 'topic-1', cwd: process.cwd() }],
        eventsBySession: {
          'topic-1': persistedConversation('earlier question', 'earlier answer'),
        },
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await harness.client.loadSession({ sessionId: SessionId('topic-1'), cwd: process.cwd(), mcpServers: [] })

    const history = harness.sessionUpdates
      .filter(entry => entry.sessionId === 'topic-1')
      .map(entry => entry.update)
      .filter(update => update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk')
    expect(history).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } },
    ])
  })

  it('rejects a non-absolute workspace', async () => {
    harness = await makeBridgeHarness({
      persistence: {
        headers: [{ id: 'topic-1', cwd: process.cwd() }],
        eventsBySession: { 'topic-1': persistedConversation('q', 'a') },
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(harness.client.loadSession({
      sessionId: SessionId('topic-1'),
      cwd: 'relative/path',
      mcpServers: [],
    })).rejects.toThrow(/cwd must be an absolute path/)
  })
})
