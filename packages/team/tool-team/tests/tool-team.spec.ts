import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { Fiber } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as team from '@deepseek-ai/dsh-team'
import * as toolTeam from '../src/index.ts'

/**
 * Keyless tool tests: mount the real team service against the scripted mock
 * ACP agent and assert the model-facing member_* tools (sessions, chat, add /
 * remove / start / stop / restart) over real subprocess + ACP stdio.
 */

const mockServer = fileURLToPath(new URL('../../../subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))

interface SetupOptions {
  mockEnv?: Record<string, string>
  memberOverrides?: Record<string, unknown>
}

const fibers: Fiber[] = []

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  for (const plugin of [SystemPrompt, LocalSubprocessRuntime, ToolRuntime]) {
    const fiber = ctx.plugin(plugin)
    fibers.push(fiber)
    await fiber
  }
  await ctx.plugin(team, {
    members: [{
      id: 'architect',
      title: '架构师',
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      env: options.mockEnv ?? {},
      autostart: false,
      ...options.memberOverrides,
    }],
  })
  const teamFiber = ctx.plugin(toolTeam)
  fibers.push(teamFiber)
  await teamFiber
  return ctx
}

afterEach(async () => {
  const pending = fibers.splice(0)
  await Promise.allSettled(pending.reverse().map(fiber => fiber.dispose()))
})

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
    const ctx = await setup({ mockEnv: { MOCK_SESSION_ID: 'topic-design', MOCK_EXTRA_SESSIONS: 'topic-review' } })
    await (ctx.get('team') as team.TeamService).start('architect')
    const result = await execute(ctx, 'member_sessions', {})
    const output = text(result)
    expect(output).toContain('架构师')
    expect(output).toContain('topic-design')
    expect(output).toContain('topic-review')
  })

  it('reports a stopped member as not running', async () => {
    const ctx = await setup()
    const output = text(await execute(ctx, 'member_sessions', {}))
    expect(output).toContain('not running')
    expect(output).toContain('member_start')
  })
})

describe('member_chat', () => {
  it('starts a new topic and returns the member reply', async () => {
    const ctx = await setup({ mockEnv: { MOCK_SESSION_ID: 'fresh-topic', MOCK_TEXT: 'design reply' } })
    await (ctx.get('team') as team.TeamService).start('architect')
    const result = await execute(ctx, 'member_chat', { member_id: 'architect', text: 'design the system', new_topic: true })
    expect(text(result)).toContain('design reply')
  })

  it('requires either topic or new_topic', async () => {
    const ctx = await setup()
    const result = await execute(ctx, 'member_chat', { member_id: 'architect', text: 'hi' })
    expect(text(result)).toMatch(/pass a topic id from member_sessions, or set new_topic/)
  })
})

describe('member_add', () => {
  it('adds a runtime member and reports its connection status', async () => {
    const ctx = await setup()
    const result = await execute(ctx, 'member_add', {
      member_id: 'writer',
      title: 'Writer',
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
    })
    const output = text(result)
    expect(output).toContain('writer')
    expect(output).toContain('joined the team')
    // The new member is now visible to member_sessions.
    const listed = text(await execute(ctx, 'member_sessions', {}))
    expect(listed).toContain('Writer')
  })

  it('rejects a duplicate id with the service error', async () => {
    const ctx = await setup()
    const result = await execute(ctx, 'member_add', { member_id: 'architect', command: 'x' })
    expect(text(result)).toMatch(/duplicate member id/)
  })

  it('accepts env and autostart and keeps a stopped member offline', async () => {
    const ctx = await setup()
    const result = await execute(ctx, 'member_add', {
      member_id: 'writer',
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      env: { MOCK_SESSION_ID: 'topic-write', MOCK_TEXT: 'writer reply' },
      autostart: false,
    })
    expect(text(result)).toContain('offline')
    const member = (ctx.get('team') as team.TeamService).list().find(candidate => candidate.id === 'writer')
    expect(member?.status).toBe('offline')
  })
})

describe('member_remove', () => {
  it('removes a runtime member from the team', async () => {
    const ctx = await setup()
    await execute(ctx, 'member_add', {
      member_id: 'writer',
      title: 'Writer',
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
    })
    const result = await execute(ctx, 'member_remove', { member_id: 'writer' })
    expect(text(result)).toContain('was removed')
    const listed = text(await execute(ctx, 'member_sessions', {}))
    expect(listed).not.toContain('Writer')
  })
})

describe('member lifecycle tools', () => {
  it('member_start connects a stopped member (idle, ready for turns)', async () => {
    const ctx = await setup()
    const output = text(await execute(ctx, 'member_start', { member_id: 'architect' }))
    expect(output).toContain('idle')
    const member = (ctx.get('team') as team.TeamService).list().find(candidate => candidate.id === 'architect')
    expect(member?.status).toBe('idle')
  })

  it('member_stop returns a member to offline', async () => {
    const ctx = await setup()
    await execute(ctx, 'member_start', { member_id: 'architect' })
    const output = text(await execute(ctx, 'member_stop', { member_id: 'architect' }))
    expect(output).toContain('stopped')
    const member = (ctx.get('team') as team.TeamService).list().find(candidate => candidate.id === 'architect')
    expect(member?.status).toBe('offline')
  })

  it('member_restart reconnects and sessions survive', async () => {
    const ctx = await setup({ mockEnv: { MOCK_SESSION_ID: 'topic-design' } })
    await execute(ctx, 'member_start', { member_id: 'architect' })
    const output = text(await execute(ctx, 'member_restart', { member_id: 'architect' }))
    expect(output).toContain('restarted')
    expect(output).toContain('idle')
    const sessions = text(await execute(ctx, 'member_sessions', { member_id: 'architect' }))
    expect(sessions).toContain('topic-design')
  })

  it('member_chat cancellation aborts the member turn', async () => {
    const ctx = await setup({ mockEnv: { MOCK_SESSION_ID: 'topic-design', MOCK_HANG: '1' } })
    await (ctx.get('team') as team.TeamService).start('architect')
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: CallId(`call-${++callCounter}`),
      name: 'member_chat',
      arguments: { member_id: 'architect', topic: 'topic-design', text: 'hang' },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    controller.abort()
    // The tool registry surfaces the aborted call as an error result; the
    // important fact is that the member's turn was cancelled through the ACP
    // wire (covered by the team service's cancel test) rather than leaked.
    const result = await pending
    expect(text(result)).toMatch(/aborted/)
  })
})
