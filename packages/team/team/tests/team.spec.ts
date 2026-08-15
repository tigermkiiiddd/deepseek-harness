import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as team from '../src/index.ts'

/**
 * Keyless integration tests for the team service: each spawns a REAL subprocess
 * — the scripted mock ACP agent (subagent-acp's tests/mock-acp-server.ts) — and
 * drives it over real ACP JSON-RPC stdio. Covers member listing, the member's
 * own session topics (list/load/new), chat turns, and process teardown.
 * No model, no key.
 */

const mockServer = fileURLToPath(new URL('../../../subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))

interface MockEnv {
  [key: string]: string
}

interface TestTeamService {
  list(): { id: string; title: string; status: string }[]
  listSessions(memberId: string, cwd?: string): Promise<{ sessionId: string; cwd: string }[]>
  loadSession(memberId: string, sessionId: string, cwd: string): Promise<void>
  readHistory(memberId: string, sessionId: string): Promise<{ role: 'user' | 'assistant'; text: string }[]>
  newSession(memberId: string, cwd: string): Promise<string>
  chat(memberId: string, sessionId: string, text: string, signal?: AbortSignal): Promise<{ text: string; stopReason: string }>
  close(memberId: string): Promise<void>
  disposeAll(): Promise<void>
}

async function setup(mockEnv: MockEnv = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(team, {
    members: [{
      id: 'architect',
      title: '架构师',
      description: 'system design',
      command: process.execPath,
      args: [mockServer],
      cwd: process.cwd(),
      env: mockEnv,
      permission: 'reject',
    }],
  })
  const service = ctx.get('team') as unknown as TestTeamService
  return { ctx, service }
}

describe('team member registry', () => {
  it('lists configured members with their connection status', async () => {
    const { service } = await setup()
    const members = service.list()
    expect(members).toEqual([
      { id: 'architect', title: '架构师', description: 'system design', status: 'closed' },
    ])
    await service.disposeAll()
  })

  it('rejects an unknown member id', async () => {
    const { service } = await setup()
    await expect(service.listSessions('nobody')).rejects.toThrow(/unknown member "nobody"/)
    await service.disposeAll()
  })
})

describe('member sessions (owned by the member process)', () => {
  it('lists the member\'s own conversation topics', async () => {
    const { service } = await setup({ MOCK_SESSION_ID: 'topic-design', MOCK_EXTRA_SESSIONS: 'topic-review' })
    const sessions = await service.listSessions('architect')
    expect(sessions.map(s => s.sessionId).sort()).toEqual(['topic-design', 'topic-review'])
    await service.disposeAll()
  })

  it('opens a new topic on the member', async () => {
    const { service } = await setup({ MOCK_SESSION_ID: 'fresh-topic' })
    const sessionId = await service.newSession('architect', process.cwd())
    expect(sessionId).toBe('fresh-topic')
    await service.disposeAll()
  })

  it('loads a known topic and rejects an unknown one', async () => {
    const { service } = await setup({ MOCK_SESSION_ID: 'topic-design', MOCK_EXTRA_SESSIONS: 'topic-review' })
    await expect(service.loadSession('architect', 'topic-review', process.cwd())).resolves.toBeUndefined()
    await expect(service.loadSession('architect', 'missing-topic', process.cwd()))
      .rejects.toThrow(/unknown session/)
    await service.disposeAll()
  })

  it('reads a topic\'s replayed history from the member', async () => {
    const { service } = await setup({ MOCK_SESSION_ID: 'topic-design', MOCK_HISTORY: '1' })
    const history = await service.readHistory('architect', 'topic-design')
    expect(history).toEqual([
      { role: 'user', text: 'earlier question' },
      { role: 'assistant', text: 'earlier answer' },
    ])
    await service.disposeAll()
  })
})

describe('member chat', () => {
  it('drives one turn and returns the committed text with its stop reason', async () => {
    const { service } = await setup({ MOCK_SESSION_ID: 'topic-design', MOCK_TEXT: 'design reply' })
    const result = await service.chat('architect', 'topic-design', 'design the system')
    expect(result.text).toBe('design reply')
    expect(result.stopReason).toBe('end_turn')
    await service.disposeAll()
  })

  it('respawns the member after close and still lists its persisted topics', async () => {
    const { service } = await setup({ MOCK_SESSION_ID: 'topic-design', MOCK_EXTRA_SESSIONS: 'topic-review' })
    await service.listSessions('architect')
    await service.close('architect')

    // The member's sessions live in the member, not in this process: after a
    // respawn they are listable again and chat continues to work.
    const sessions = await service.listSessions('architect')
    expect(sessions.map(s => s.sessionId).sort()).toEqual(['topic-design', 'topic-review'])
    await service.disposeAll()
  })
})
