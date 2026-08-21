/**
 * Pure translation from harness session events to the full-fidelity ACP wire.
 *
 * These mappings run only for connections that negotiated
 * `InitializeRequest._meta.fullFidelity === true`; the automation wire in
 * `index.ts` is unchanged for every other client. Each function maps exactly
 * the data its harness event carries — where the event lacks an ACP field
 * (tool `kind`, plan entry `priority` beyond the required neutral value), the
 * ACP type's optionality is used instead of inventing data.
 * @module @deepseek-ai/dsh-acp/fidelity
 */

import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEventMap, TodoItem } from '@deepseek-ai/dsh-session'

/**
 * Decode the model-produced raw arguments JSON for `rawInput`.
 * @param argumentsJson - the raw JSON string exactly as the model produced it.
 * @returns the parsed arguments, or the raw string verbatim when it is not
 * valid JSON (a truncated stream still identifies the call).
 */
function parseRawInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown
  } catch {
    return argumentsJson
  }
}

/**
 * Map a committed reasoning block to a thought chunk.
 * @param text - committed reasoning text (never empty).
 * @returns an `agent_thought_chunk` update carrying the text.
 */
export function thoughtToChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
}

/**
 * Map a `tool/call` event to the tool call's opening update. The event carries
 * no render category, so ACP's optional `kind` stays unset.
 * @param call - the logged tool invocation: identity, name, and raw arguments.
 * @returns a `tool_call` update with status `in_progress`.
 */
export function toolCallToUpdate(call: SessionEventMap['tool/call']): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: call.callId,
    title: call.name,
    status: 'in_progress',
    rawInput: parseRawInput(call.arguments),
  }
}

/**
 * Map a `tool/result` event to the tool call's closing update. Text result
 * blocks become ACP content entries; every block (text or not) stays available
 * verbatim as `rawOutput`.
 * @param result - the logged result message plus its optional failure identity.
 * @returns a `tool_call_update` update with status `completed` or `failed`.
 */
export function toolResultToUpdate(result: SessionEventMap['tool/result']): SessionUpdate {
  const block = result.message.content[0]
  const content: ToolCallContent[] = []
  for (const item of block.content) {
    switch (item.type) {
      case 'text':
        content.push({ type: 'content', content: { type: 'text', text: item.text } })
        break
      // ContentBlock is merge-extensible; non-text blocks reach the client
      // through rawOutput instead.
      default:
        break
    }
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: block.toolCallId,
    status: block.isError === true || result.error !== undefined ? 'failed' : 'completed',
    ...content.length > 0 ? { content } : {},
    rawOutput: block.content,
  }
}

/**
 * Map a `todo/write` whole-list snapshot to a plan update. Harness todos carry
 * no priority, but ACP requires one per entry, so every entry reports the
 * neutral `medium`.
 * @param todos - the latest whole-list snapshot (last write wins).
 * @returns a `plan` update replacing the client's whole plan.
 */
export function todosToPlan(todos: readonly TodoItem[]): SessionUpdate {
  return {
    sessionUpdate: 'plan',
    entries: todos.map(todo => ({ content: todo.content, status: todo.status, priority: 'medium' })),
  }
}

/**
 * Map one step's token accounting to a context-window usage update. `used` is
 * the post-call context occupancy: prompt tokens (uncached input plus both
 * cache buckets) plus the emitted output.
 * @param usage - the step's disjoint token counts.
 * @param contextWindow - the route's advertised context window in tokens.
 * @returns a `usage_update` update.
 */
export function usageToUpdate(usage: TokenUsage, contextWindow: number): SessionUpdate {
  const used = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return { sessionUpdate: 'usage_update', used, size: contextWindow }
}
