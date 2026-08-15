import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as team from '@deepseek-ai/dsh-team'
import * as toolTeam from '../src/index.ts'

/**
 * Keyless tool tests: mount the real team service against the scripted mock
 * ACP agent and assert the model-facing member_sessions / member_chat tools
 * over real subprocess + ACP stdio.
 */

const mockServer = fileURLToPath(new URL('../../../subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))

async function setup(mockEnv: Record<string, string> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(team, {
    members: [{
      id: 'architect',
      title: '架构师',
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      env: mockEnv,
    }],
  })
  await ctx.plugin(toolTeam)
  return ctx
}

let callCounter = 0
function execute(ctx: Context, name: string, args: unknown): Promise<{ content: { type: string; text?: string }[] }> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('member_sessions', () => {
  it('lists members and their topics', async () => {
    const ctx = await setup({ MOCK_SESSION_ID: 'topic-design', MOCK_EXTRA_SESSIONS: 'topic-review' })
    const result = await execute(ctx, 'member_sessions', {})
    const output = text(result)
    expect(output).toContain('架构师')
    expect(output).toContain('topic-design')
    expect(output).toContain('topic-review')
  })
})

describe('member_chat', () => {
  it('starts a new topic and returns the member reply', async () => {
    const ctx = await setup({ MOCK_SESSION_ID: 'fresh-topic', MOCK_TEXT: 'design reply' })
    const result = await execute(ctx, 'member_chat', { member_id: 'architect', text: 'design the system', new_topic: true })
    expect(text(result)).toContain('design reply')
  })

  it('requires either topic or new_topic', async () => {
    const ctx = await setup()
    const result = await execute(ctx, 'member_chat', { member_id: 'architect', text: 'hi' })
    expect(text(result)).toMatch(/pass a topic id from member_sessions, or set new_topic/)
  })
})
