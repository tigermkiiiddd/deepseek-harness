import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpUpdateTranslator, stopReasonToTurnEnd } from '../src/fidelity-reverse.ts'

/**
 * Unit tests for the ACP→SessionEvent reverse translator. Each row of the
 * translation table is exercised in isolation; stateful behavior (chunk
 * accumulation, block indexing, tool pairing, turn boundaries) is validated
 * across sequences.
 */

describe('stopReasonToTurnEnd', () => {
  it('maps end_turn to completed', () => {
    expect(stopReasonToTurnEnd('end_turn')).toEqual({ kind: 'completed' })
  })

  it('maps cancelled to aborted by user', () => {
    expect(stopReasonToTurnEnd('cancelled')).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('maps max_tokens to max-tokens', () => {
    expect(stopReasonToTurnEnd('max_tokens')).toEqual({ kind: 'max-tokens' })
  })

  it('maps refusal to a structured error', () => {
    expect(stopReasonToTurnEnd('refusal')).toEqual({
      kind: 'error',
      error: { message: 'the member refused the prompt', code: 'REFUSAL' },
    })
  })

  it('maps max_turn_requests to a structured error', () => {
    expect(stopReasonToTurnEnd('max_turn_requests')).toEqual({
      kind: 'error',
      error: { message: 'the member exceeded its turn request limit', code: 'MAX_TURN_REQUESTS' },
    })
  })
})

describe('AcpUpdateTranslator user chunks', () => {
  it('accumulates multiple user chunks into one user/message', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(userChunk('Hello')),
      ...translator.update(userChunk(' world')),
      ...translator.finish(),
    ]
    expect(events.map(e => e.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    const message = events.find(e => e.type === 'user/message')
    expect(message?.data.content).toEqual([{ type: 'text', text: 'Hello world' }])
    expect((message as { surfaceOp: string }).surfaceOp).toBe('append')
  })

  it('drops non-text user chunks', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update({ sessionUpdate: 'user_message_chunk', content: { type: 'image', url: 'x' } } as unknown as SessionUpdate),
      ...translator.finish(),
    ]
    expect(events).toEqual([])
  })
})

describe('AcpUpdateTranslator agent chunks', () => {
  it('opens step and text block once, then emits text-deltas', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(agentChunk('Hello')),
      ...translator.update(agentChunk(' world')),
    ]
    expect(events.map(e => e.type)).toEqual([
      'turn/start',
      'step/start',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
    ])
    const chunks = events.filter(e => e.type === 'assistant/chunk').map(e => e.data.chunk)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'Hello' })
    expect(chunks[2]).toEqual({ type: 'text-delta', index: 0, text: ' world' })
  })

  it('places reasoning deltas on a separate block index', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(thoughtChunk('thinking')),
      ...translator.update(agentChunk('answer')),
    ]
    const chunks = events.filter(e => e.type === 'assistant/chunk').map(e => e.data.chunk)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'thinking' })
    expect(chunks[2]).toEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks[3]).toEqual({ type: 'text-delta', index: 1, text: 'answer' })
  })

  it('drops non-text agent chunks', () => {
    const translator = new AcpUpdateTranslator()
    const events = translator.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', url: 'x' } } as unknown as SessionUpdate)
    expect(events).toEqual([])
  })
})

describe('AcpUpdateTranslator tool calls', () => {
  it('emits tool/call with stringified arguments', () => {
    const translator = new AcpUpdateTranslator()
    const events = translator.update(toolCall('tc-1', 'search', { query: 'foo' }))
    expect(events.map(e => e.type)).toEqual(['turn/start', 'step/start', 'tool/call'])
    const call = events.find(e => e.type === 'tool/call')?.data
    expect(call).toMatchObject({ turn: 1, step: 1, callId: 'tc-1', name: 'search', arguments: '{"query":"foo"}' })
  })

  it('keeps raw string arguments verbatim', () => {
    const translator = new AcpUpdateTranslator()
    const events = translator.update(toolCall('tc-1', 'search', '{"query":"foo"}'))
    const call = events.find(e => e.type === 'tool/call')?.data
    expect(call?.arguments).toBe('{"query":"foo"}')
  })

  it('defaults absent rawInput to an empty object', () => {
    const translator = new AcpUpdateTranslator()
    const events = translator.update(toolCall('tc-1', 'search', undefined))
    const call = events.find(e => e.type === 'tool/call')?.data
    expect(call?.arguments).toBe('{}')
  })

  it('emits tool/result for completed updates and pairs by toolCallId', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(toolCall('tc-1', 'search', { query: 'foo' })),
      ...translator.update(toolResult('tc-1', 'completed', [{ type: 'content', content: { type: 'text', text: 'result text' } }])),
    ]
    expect(events.map(e => e.type)).toEqual(['turn/start', 'step/start', 'tool/call', 'tool/result'])
    const result = events.find(e => e.type === 'tool/result')?.data
    expect(result?.message.content[0]?.content).toEqual([{ type: 'text', text: 'result text' }])
    expect((result as { message: { content: [{ isError?: boolean }] } }).message.content[0]?.isError).toBe(false)
    expect((events.find(e => e.type === 'tool/result') as { surfaceOp: string }).surfaceOp).toBe('append')
  })

  it('marks failed tool results as errors', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(toolCall('tc-1', 'search', {})),
      ...translator.update(toolResult('tc-1', 'failed', [{ type: 'content', content: { type: 'text', text: 'boom' } }])),
    ]
    const result = events.find(e => e.type === 'tool/result')?.data
    expect((result as { message: { content: [{ isError?: boolean }] } }).message.content[0]?.isError).toBe(true)
  })

  it('drops progress-only tool_call_update statuses', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(toolCall('tc-1', 'search', {})),
      ...translator.update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' }),
    ]
    expect(events.map(e => e.type)).toEqual(['turn/start', 'step/start', 'tool/call'])
  })

  it('translates unmatched completed updates (no prior tool_call)', () => {
    const translator = new AcpUpdateTranslator()
    const events = translator.update(toolResult('tc-1', 'completed', [{ type: 'content', content: { type: 'text', text: 'orphan' } }]))
    expect(events.map(e => e.type)).toEqual(['turn/start', 'step/start', 'tool/result'])
  })
})

describe('AcpUpdateTranslator plans and dropped updates', () => {
  it('folds a plan into a todo/write snapshot without priority', () => {
    const translator = new AcpUpdateTranslator()
    const events = translator.update({
      sessionUpdate: 'plan',
      entries: [
        { content: 'task one', status: 'in_progress', priority: 'high' },
        { content: 'task two', status: 'pending', priority: 'low' },
      ],
    })
    expect(events).toEqual([{
      type: 'todo/write',
      data: {
        todos: [
          { content: 'task one', status: 'in_progress' },
          { content: 'task two', status: 'pending' },
        ],
      },
    }])
  })

  it('drops usage_update', () => {
    const translator = new AcpUpdateTranslator()
    expect(translator.update({ sessionUpdate: 'usage_update', used: 10, size: 100 })).toEqual([])
  })

  it('drops available_commands_update', () => {
    const translator = new AcpUpdateTranslator()
    expect(translator.update({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toEqual([])
  })

  it('drops current_mode_update', () => {
    const translator = new AcpUpdateTranslator()
    expect(translator.update({ sessionUpdate: 'current_mode_update', currentModeId: 'x' })).toEqual([])
  })

  it('drops session_info_update', () => {
    const translator = new AcpUpdateTranslator()
    expect(translator.update({ sessionUpdate: 'session_info_update' })).toEqual([])
  })
})

describe('AcpUpdateTranslator turn boundaries', () => {
  it('closes a live turn with assistant/message, step/end and turn/end', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(agentChunk('hi')),
      ...translator.endTurn('end_turn'),
    ]
    expect(events.map(e => e.type)).toEqual([
      'turn/start', 'step/start', 'assistant/chunk', 'assistant/chunk', 'assistant/message', 'step/end', 'turn/end',
    ])
    const message = events.find(e => e.type === 'assistant/message')?.data.message
    expect(message?.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(message?.source).toMatchObject({ kind: 'model', provider: 'member', model: 'member' })
    const end = events.find(e => e.type === 'turn/end')?.data
    expect(end?.reason).toEqual({ kind: 'completed' })
  })

  it('records a user-only tail turn with no step bracket', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(userChunk('hello')),
      ...translator.finish(),
    ]
    expect(events.map(e => e.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
  })

  it('closes the current turn on the next user chunk and opens the next turn on finish', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(userChunk('first')),
      ...translator.update(agentChunk('answer')),
      ...translator.update(userChunk('second')),
      ...translator.finish(),
    ]
    expect(events.map(e => e.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/chunk', 'assistant/chunk',
      'assistant/message', 'step/end', 'turn/end', 'turn/start', 'user/message', 'turn/end',
    ])
  })

  it('maps cancelled to aborted user', () => {
    const translator = new AcpUpdateTranslator()
    translator.update(userChunk('hi'))
    const events = translator.endTurn('cancelled')
    expect(events.find(e => e.type === 'turn/end')?.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('maps max_tokens to max-tokens', () => {
    const translator = new AcpUpdateTranslator()
    translator.update(userChunk('hi'))
    const events = translator.endTurn('max_tokens')
    expect(events.find(e => e.type === 'turn/end')?.data.reason).toEqual({ kind: 'max-tokens' })
  })

  it('assembles text and reasoning blocks into assistant/message in block order', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(thoughtChunk('thinking')),
      ...translator.update(agentChunk('answer')),
      ...translator.endTurn('end_turn'),
    ]
    expect(events.map(e => e.type)).toEqual([
      'turn/start', 'step/start', 'assistant/chunk', 'assistant/chunk', 'assistant/chunk',
      'assistant/chunk', 'assistant/message', 'step/end', 'turn/end',
    ])
    const message = events.find(e => e.type === 'assistant/message')?.data.message
    expect(message?.content).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('emits assistant/message with empty content for a tool-only step', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.update(toolCall('tc-1', 'search', {})),
      ...translator.update(toolResult('tc-1', 'completed', [{ type: 'content', content: { type: 'text', text: 'result' } }])),
      ...translator.endTurn('end_turn'),
    ]
    expect(events.map(e => e.type)).toEqual([
      'turn/start', 'step/start', 'tool/call', 'tool/result', 'assistant/message', 'step/end', 'turn/end',
    ])
    const message = events.find(e => e.type === 'assistant/message')?.data.message
    expect(message?.content).toEqual([])
  })
})

describe('AcpUpdateTranslator deduplicates echoed user messages', () => {
  it('drops an echoed user message identical to the minted turn text', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.startTurn('hello world'),
      ...translator.update(userChunk('hello world')),
      ...translator.update(agentChunk('answer')),
      ...translator.endTurn('end_turn'),
    ]
    expect(events.map(e => e.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'turn/start', 'step/start', 'assistant/chunk', 'assistant/chunk', 'assistant/message', 'step/end', 'turn/end',
    ])
    const userMessages = events.filter(e => e.type === 'user/message')
    expect(userMessages).toHaveLength(1)
    expect((userMessages[0] as { data: { content: [{ text: string }] } }).data.content[0].text).toBe('hello world')
  })

  it('keeps an echoed user message when the text differs from the minted turn', () => {
    const translator = new AcpUpdateTranslator()
    const events = [
      ...translator.startTurn('hello world'),
      ...translator.update(userChunk('different prompt')),
      ...translator.update(agentChunk('answer')),
      ...translator.endTurn('end_turn'),
    ]
    const userMessages = events.filter(e => e.type === 'user/message')
    expect(userMessages).toHaveLength(2)
  })
})

function userChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }
}

function agentChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

function thoughtChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
}

function toolCall(toolCallId: string, title: string, rawInput: unknown): SessionUpdate {
  return { sessionUpdate: 'tool_call', toolCallId, title, rawInput }
}

function toolResult(toolCallId: string, status: 'completed' | 'failed', content: unknown[]): SessionUpdate {
  return { sessionUpdate: 'tool_call_update', toolCallId, status, content } as SessionUpdate
}
