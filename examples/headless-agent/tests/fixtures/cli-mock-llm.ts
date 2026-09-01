import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

function* toolCall(id: string, name: string, args: unknown): Iterable<StreamChunk> {
  const callId = CallId(id)
  const argumentsJson = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } }
  yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Keyless headless-agent adapter: recover from one lazy-bridge misroute, then call an end tool. */
class CliMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (process.env.DSH_CLI_MOCK_FAILURE === '1') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'CLI mock provider failed' } } }
      return
    }
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      yield* toolCall('cli-lazy-misroute', 'tool_call', {
        name: 'tool_describe',
        arguments: { name: 'snapshot_echo' },
      })
      return
    }
    if (toolResult.toolCallId === 'cli-lazy-misroute') {
      yield* toolCall('cli-lazy-describe', 'tool_describe', { name: 'snapshot_echo' })
      return
    }
    if (toolResult.toolCallId === 'cli-lazy-describe') {
      yield* toolCall('cli-lazy-call', 'tool_call', {
        name: 'snapshot_echo',
        arguments: { value: 'CLI_TOOL_ROUND_TRIP' },
      })
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const value = JSON.parse(toolText) as unknown
    const reply = `CLI tool round trip complete: ${typeof value === 'string' ? value : '(invalid echo result)'}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'cli-mock-llm'
export const inject = ['llm', 'tools']

/** Register the keyless `cli-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new CliMockAdapter())
  ctx.tools.register(defineTool({
    name: 'snapshot_echo',
    description: 'Echo one string through the keyless product snapshot.',
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: args => Promise.resolve(args.value),
  }))
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 ? { ...config, reasoningEffort: OFF } : config
  })
}
