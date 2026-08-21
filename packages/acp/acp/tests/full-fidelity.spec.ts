import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createAssistantMessage, createToolResultMessage, createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  makeBridgeHarness,
  reasoningToolCallResponse,
  textResponse,
  type BridgeHarness,
  type CapturedUpdate,
} from './harness.ts'

/** The scripted turn: reason, call the echo tool, then answer in text. */
const SCRIPT = [
  reasoningToolCallResponse('thinking aloud', 'call-1', 'echo', { text: 'hi' }),
  textResponse('done'),
]

/** Register the real echo tool the scripted model call invokes. */
function registerEchoTool(harness: BridgeHarness): void {
  harness.ctx.tools.register(defineTool({
    name: 'echo',
    description: 'echoes its text argument',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: args => Promise.resolve(args.text),
  }))
}

async function newSession(harness: BridgeHarness, fullFidelity: boolean): Promise<string> {
  await harness.client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    ...fullFidelity ? { _meta: { fullFidelity: true } } : {},
  })
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

function kinds(updates: readonly CapturedUpdate[]): string[] {
  return updates.map(update => update.sessionUpdate)
}

describe('ACP full-fidelity mode', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('streams thought, tool-call, plan, and usage updates in order', async () => {
    harness = await makeBridgeHarness({ contextWindow: 1000, script: [...SCRIPT] })
    registerEchoTool(harness)
    const sessionId = await newSession(harness, true)

    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('end_turn')

    // A plan snapshot after the turn still reaches a full-fidelity client.
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('todo/write', { todos: [{ content: 'step one', status: 'in_progress' }] })

    await vi.waitFor(() => {
      expect(kinds(harness!.updates)).toEqual([
        'agent_thought_chunk',
        'usage_update',
        'tool_call',
        'tool_call_update',
        'agent_message_chunk',
        'usage_update',
        'plan',
      ])
    })

    const [thought, usage1, toolCall, toolResult, message, usage2, plan] = harness.updates
    expect(thought).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking aloud' },
    })
    // Step 1 usage: 7 input + 3 output against the advertised 1000-token window.
    expect(usage1).toMatchObject({ sessionUpdate: 'usage_update', used: 10, size: 1000 })
    expect(toolCall).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'echo',
      status: 'in_progress',
      rawInput: { text: 'hi' },
    })
    expect(toolResult).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
      rawOutput: [{ type: 'text', text: 'hi' }],
    })
    expect(message).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    })
    // Step 2 usage: 5 input + 4 output ('done').
    expect(usage2).toMatchObject({ sessionUpdate: 'usage_update', used: 9, size: 1000 })
    expect(plan).toMatchObject({
      sessionUpdate: 'plan',
      entries: [{ content: 'step one', status: 'in_progress', priority: 'medium' }],
    })
  })

  it('marks a failed tool result as failed', async () => {
    harness = await makeBridgeHarness({
      script: [reasoningToolCallResponse('thinking', 'call-1', 'boom', {}), textResponse('recovered')],
    })
    harness.ctx.tools.register(defineTool({
      name: 'boom',
      description: 'always fails',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.reject(new Error('tool exploded')),
    }))
    const sessionId = await newSession(harness, true)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => {
      expect(kinds(harness!.updates)).toContain('tool_call_update')
    })
    const update = harness.updates.find(entry => entry.sessionUpdate === 'tool_call_update')
    expect(update).toMatchObject({ toolCallId: 'call-1', status: 'failed' })
  })

  it('omits usage updates when the route advertises no context window', async () => {
    harness = await makeBridgeHarness({ script: [...SCRIPT] })
    registerEchoTool(harness)
    const sessionId = await newSession(harness, true)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => {
      expect(kinds(harness!.updates)).toContain('agent_message_chunk')
    })
    expect(kinds(harness.updates)).not.toContain('usage_update')
    expect(kinds(harness.updates)).toContain('tool_call')
  })

  it('keeps the automation stream text-only without the flag', async () => {
    harness = await makeBridgeHarness({ contextWindow: 1000, script: [...SCRIPT] })
    registerEchoTool(harness)
    const sessionId = await newSession(harness, false)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('todo/write', { todos: [{ content: 'step one', status: 'in_progress' }] })

    await vi.waitFor(() => {
      expect(harness!.updates).toHaveLength(1)
    })
    expect(harness.updates).toEqual([{
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    }])
  })

  it('replays persisted history with full-fidelity updates in log order', async () => {
    harness = await makeBridgeHarness({
      persistence: {
        headers: [{ id: 'topic-1', cwd: process.cwd() }],
        eventsBySession: { 'topic-1': persistedFullFidelityEvents() },
      },
    })
    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      _meta: { fullFidelity: true },
    })

    await harness.client.loadSession({
      sessionId: SessionId('topic-1'),
      cwd: process.cwd(),
      mcpServers: [],
    })

    expect(kinds(harness.updates)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'agent_thought_chunk',
      'usage_update',
      'tool_call',
      'tool_call_update',
      'plan',
    ])

    const [user, message, thought, usage, toolCall, toolResult, plan] = harness.updates
    expect(user).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hello' },
    })
    expect(message).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'answer' },
    })
    expect(thought).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    })
    expect(usage).toMatchObject({ sessionUpdate: 'usage_update', used: 8, size: 1000 })
    expect(toolCall).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'echo',
      status: 'in_progress',
      rawInput: { text: 'hi' },
    })
    expect(toolResult).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
      rawOutput: [{ type: 'text', text: 'hi' }],
    })
    expect(plan).toMatchObject({
      sessionUpdate: 'plan',
      entries: [{ content: 'step one', status: 'in_progress', priority: 'medium' }],
    })
  })

  it('keeps persisted history replay text-only without the flag', async () => {
    harness = await makeBridgeHarness({
      persistence: {
        headers: [{ id: 'topic-1', cwd: process.cwd() }],
        eventsBySession: { 'topic-1': persistedFullFidelityEvents() },
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await harness.client.loadSession({
      sessionId: SessionId('topic-1'),
      cwd: process.cwd(),
      mcpServers: [],
    })

    expect(harness.updates).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
    ])
  })
})

/** A persisted session exercising every full-fidelity mapping. */
function persistedFullFidelityEvents(): SessionEvent[] {
  const callId = CallId('call-1')
  return [
    {
      type: 'request/context',
      seq: 0,
      time: 1_700_000_000_000,
      data: { provider: 'mock', model: 'mock', contextWindow: 1000 },
    },
    {
      type: 'user/message',
      seq: 1,
      time: 1_700_000_000_001,
      surfaceOp: 'append',
      data: createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }),
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1_700_000_000_002,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          source: { provider: 'mock', model: 'mock' },
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'answer' },
          ],
        }),
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    },
    {
      type: 'tool/call',
      seq: 3,
      time: 1_700_000_000_003,
      data: { turn: 1, step: 1, callId, name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: 1_700_000_000_004,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'hi' }],
          isError: false,
        }),
      },
    },
    {
      type: 'todo/write',
      seq: 5,
      time: 1_700_000_000_005,
      data: { todos: [{ content: 'step one', status: 'in_progress' }] },
    },
  ]
}
