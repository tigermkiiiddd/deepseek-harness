import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Fiber } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as team from '../src/index.ts'
import type { TeamService } from '../src/index.ts'
import type { MemberConfig, MemberStatus } from '../src/types.ts'

/**
 * Keyless integration tests for the team service: each spawns a REAL subprocess
 * — the scripted mock ACP agent (subagent-acp's tests/mock-acp-server.ts) — and
 * drives it over real ACP JSON-RPC stdio. Covers the explicit lifecycle, the
 * status/update/turn-end event stream, environment inheritance, permission
 * routing, and the durable roster. No model, no key.
 */

const mockServer = fileURLToPath(new URL('../../../subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))

/** A configured mock member; autostart off so tests drive the lifecycle explicitly. */
function mockMember(overrides: Partial<MemberConfig> & { env?: Record<string, string> } = {}): MemberConfig {
  return {
    id: 'architect',
    title: '架构师',
    description: 'system design',
    command: process.execPath,
    args: [mockServer],
    cwd: process.cwd(),
    env: {},
    permission: 'reject',
    autostart: false,
    ...overrides,
  }
}

interface SetupOptions {
  members?: MemberConfig[]
  /** When set, mount the real json storage backend under this directory. */
  storageRoot?: string
}

interface Harness {
  ctx: Context
  fibers: Fiber[]
  service: TeamService
  statusEvents: [string, MemberStatus, string | undefined][]
  updateEvents: [string, string, unknown][]
  turnEndEvents: [string, string, string, string, string | undefined][]
  permissionEvents: [string, unknown][]
}

const harnesses: Harness[] = []

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const mount = async (plugin: unknown, config?: unknown): Promise<void> => {
    const fiber = ctx.plugin(plugin as never, config as never)
    fibers.push(fiber)
    await fiber
  }
  await mount(LocalSubprocessRuntime)
  if (options.storageRoot !== undefined) {
    await mount(Storage)
    ctx.storage.backend.register('json', new JsonStorageBackend(options.storageRoot))
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
  }
  await mount(team, { members: options.members ?? [mockMember()] })
  const service = ctx.get('team') as TeamService
  const statusEvents: [string, MemberStatus, string | undefined][] = []
  const updateEvents: [string, string, unknown][] = []
  const turnEndEvents: [string, string, string, string, string | undefined][] = []
  const permissionEvents: [string, unknown][] = []
  ctx.on('team/status', (memberId, status, error) => { statusEvents.push([memberId, status, error]) })
  ctx.on('team/member-update', (memberId, sessionId, update) => { updateEvents.push([memberId, sessionId, update]) })
  ctx.on('team/turn-end', (memberId, sessionId, promptId, stopReason, error) => {
    turnEndEvents.push([memberId, sessionId, promptId, stopReason, error])
  })
  ctx.on('team/permission-requested', (request) => { permissionEvents.push([request.requestId, request]) })
  const harness: Harness = { ctx, fibers, service, statusEvents, updateEvents, turnEndEvents, permissionEvents }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  // Stop every mounted context (reverse mount order) so no mock member
  // process leaks between tests.
  const pending = harnesses.splice(0)
  await Promise.allSettled(pending.map(async (harness) => {
    for (const fiber of [...harness.fibers].reverse()) await fiber.dispose()
  }))
})

/** Resolve once the member's snapshot (or a status event) reaches `status`. */
async function waitForStatus(harness: Harness, memberId: string, status: MemberStatus, timeoutMs = 15_000): Promise<void> {
  const already = harness.service.list().find(member => member.id === memberId)?.status
  if (already === status) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`timed out waiting for member "${memberId}" to reach ${status}`))
    }, timeoutMs)
    const listener = (id: string, current: MemberStatus): void => {
      if (id !== memberId || current !== status) return
      clearTimeout(timer)
      dispose()
      resolve()
    }
    const dispose = harness.ctx.on('team/status', listener)
  })
}

/** Resolve with the next turn-end event for one member/session. */
async function nextTurnEnd(harness: Harness, memberId: string, sessionId: string, timeoutMs = 15_000): Promise<string> {
  const settled = harness.turnEndEvents.find(event => event[0] === memberId && event[1] === sessionId)
  if (settled !== undefined) return settled[3]
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`timed out waiting for a turn-end on ${memberId}/${sessionId}`))
    }, timeoutMs)
    const listener = (id: string, session: string, _promptId: string, stopReason: string): void => {
      if (id !== memberId || session !== sessionId) return
      clearTimeout(timer)
      dispose()
      resolve(stopReason)
    }
    const dispose = harness.ctx.on('team/turn-end', listener)
  })
}

/** Resolve with the next permission-requested event for one member. */
async function nextPermission(harness: Harness, memberId: string, timeoutMs = 15_000): Promise<import('../src/types.ts').TeamPermissionRequest> {
  const settled = harness.permissionEvents.map(event => event[1] as import('../src/types.ts').TeamPermissionRequest)
    .find(request => request.memberId === memberId)
  if (settled !== undefined) return settled
  return await new Promise<import('../src/types.ts').TeamPermissionRequest>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`timed out waiting for a permission request from "${memberId}"`))
    }, timeoutMs)
    const listener = (request: import('../src/types.ts').TeamPermissionRequest): void => {
      if (request.memberId !== memberId) return
      clearTimeout(timer)
      dispose()
      resolve(request)
    }
    const dispose = harness.ctx.on('team/permission-requested', listener)
  })
}

/** Wait until the mock agent has signalled it reached a state (via a marker file). */
async function waitForMarker(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (!existsSync(file)) throw new Error(`timed out waiting for marker ${file}`)
}

describe('member lifecycle', () => {
  it('starts offline and reports idle once the handshake completes', async () => {
    const harness = await setup()
    expect(harness.service.list()).toEqual([expect.objectContaining({ id: 'architect', status: 'offline' })])
    await harness.service.start('architect')
    expect(harness.service.list()[0]?.status).toBe('idle')
    // Connecting is internal-only: the single event is the idle migration.
    expect(harness.statusEvents).toEqual([
      ['architect', 'idle', undefined],
    ])
  })

  it('autostarts configured members at load', async () => {
    const harness = await setup({ members: [mockMember({ autostart: true })] })
    await waitForStatus(harness, 'architect', 'idle')
    expect(harness.service.list()[0]?.status).toBe('idle')
  })

  it('reports running while a prompt turn is in flight and idle after it settles', async () => {
    const ready = join(tmpdir(), `team-status-ready-${Math.random().toString(36).slice(2)}`)
    const harness = await setup({
      members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_HANG: '1', MOCK_READY_FILE: ready } })],
    })
    await harness.service.start('architect')
    expect(harness.service.list()[0]?.status).toBe('idle')
    await harness.service.prompt('architect', 'topic-design', 'hang')
    expect(harness.service.list()[0]?.status).toBe('running')
    await waitForMarker(ready)
    await harness.service.cancel('architect', 'topic-design')
    await expect(nextTurnEnd(harness, 'architect', 'topic-design')).resolves.toBe('cancelled')
    expect(harness.service.list()[0]?.status).toBe('idle')
    expect(harness.statusEvents).toEqual([
      ['architect', 'idle', undefined],
      ['architect', 'running', undefined],
      ['architect', 'idle', undefined],
    ])
  })

  it('fails loud on a spawn failure and keeps the error on the snapshot', async () => {
    const harness = await setup({ members: [mockMember({ command: 'no-such-team-member-binary-xyz' })] })
    await expect(harness.service.start('architect')).rejects.toThrow()
    const member = harness.service.list()[0]
    expect(member?.status).toBe('failed')
    expect(member?.lastError).toBeTruthy()
  })

  it('rejects operations on a member that is not running', async () => {
    const harness = await setup()
    await expect(harness.service.listSessions('architect')).rejects.toThrow(/not running/)
    await expect(harness.service.newSession('architect')).rejects.toThrow(/not running/)
  })

  it('stop returns to offline; cached sessions survive and refresh on restart', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design' } })] })
    await harness.service.start('architect')
    await expect(harness.service.listSessions('architect')).resolves.toEqual([{ sessionId: 'topic-design', cwd: process.cwd() }])
    await harness.service.stop('architect')
    expect(harness.service.list()[0]?.status).toBe('offline')
    // The cache populated by the live listSessions is served while the member is offline.
    await expect(harness.service.listSessions('architect')).resolves.toEqual([{ sessionId: 'topic-design', cwd: process.cwd() }])
    await harness.service.restart('architect')
    // A restarted member refreshes the cache from the live process.
    await expect(harness.service.listSessions('architect')).resolves.toEqual([{ sessionId: 'topic-design', cwd: process.cwd() }])
  })

  it('disposeAll stops every member', async () => {
    const harness = await setup()
    await harness.service.start('architect')
    await harness.service.disposeAll()
    expect(harness.service.list()[0]?.status).toBe('offline')
  })

  it('marks an unexpected process death offline', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_CRASH_ON_PROMPT: '1', MOCK_SESSION_ID: 'topic-design' } })] })
    await harness.service.start('architect')
    // The mock exits hard when prompted; the loss handler must settle the turn
    // and move the member to offline.
    const prompt = harness.service.prompt('architect', 'topic-design', 'crash me')
    await expect(prompt).resolves.toMatchObject({ promptId: expect.stringMatching(/^team-architect-/) as unknown })
    await waitForStatus(harness, 'architect', 'offline')
    expect(harness.turnEndEvents.some(event => event[3] === 'cancelled')).toBe(true)
  })

  it('fails a member-rejected turn through team/turn-end without an unhandled rejection', async () => {
    const harness = await setup({
      members: [mockMember({ env: { MOCK_REJECT_PROMPT: '1', MOCK_SESSION_ID: 'topic-design' } })],
    })
    await harness.service.start('architect')
    const { promptId } = await harness.service.prompt('architect', 'topic-design', 'refuse me')
    // The member answered with a protocol error: the turn fails (no stop
    // reason), and the failure reaches streaming consumers via turn-end.
    const deadline = Date.now() + 15_000
    let event = harness.turnEndEvents.find(entry => entry[2] === promptId)
    while (event === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      event = harness.turnEndEvents.find(entry => entry[2] === promptId)
    }
    expect(event?.[4]).toContain('Internal error')
    // The member process is untouched: still connected, back to idle.
    expect(harness.service.list().find(member => member.id === 'architect')?.status).toBe('idle')
  })
})

describe('member sessions (owned by the member process)', () => {
  it('lists the member\'s own conversation topics', async () => {
    const harness = await setup({
      members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_EXTRA_SESSIONS: 'topic-review' } })],
    })
    await harness.service.start('architect')
    const sessions = await harness.service.listSessions('architect')
    expect(sessions.map(session => session.sessionId).sort()).toEqual(['topic-design', 'topic-review'])
  })

  it('filters topics by the member workspace and honors an explicit filter', async () => {
    const harness = await setup({
      members: [mockMember({
        env: { MOCK_SESSION_ID: 'topic-design', MOCK_SESSION_CWD: '/elsewhere' },
      })],
    })
    await harness.service.start('architect')
    // Default filter = the member's configured cwd (process.cwd()), which does
    // not match the store's workspace, so nothing comes back — proving the
    // filter reaches the member instead of listing its whole global store.
    await expect(harness.service.listSessions('architect')).resolves.toEqual([])
    await expect(harness.service.listSessions('architect', '/elsewhere')).resolves.toEqual([
      { sessionId: 'topic-design', cwd: '/elsewhere' },
    ])
  })

  it('opens a new topic on the member', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'fresh-topic' } })] })
    await harness.service.start('architect')
    await expect(harness.service.newSession('architect')).resolves.toBe('fresh-topic')
  })

  it('loads a known topic and rejects an unknown one', async () => {
    const harness = await setup({
      members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_EXTRA_SESSIONS: 'topic-review' } })],
    })
    await harness.service.start('architect')
    await expect(harness.service.loadSession('architect', 'topic-review')).resolves.toBeUndefined()
    await expect(harness.service.loadSession('architect', 'missing-topic')).rejects.toThrow(/unknown session/)
  })

  describe('session config options', () => {
    it('reads the cached model selector when the member advertises config options', async () => {
      const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-model', MOCK_CONFIG_OPTIONS: '1' } })] })
      await harness.service.start('architect')
      const sessionId = await harness.service.newSession('architect')
      const snapshot = await harness.service.getConfig('architect', sessionId)
      expect(snapshot.model).toBeDefined()
      expect(snapshot.model?.currentValue).toBe('mock-model-1')
      expect(snapshot.model?.options.map(option => option.value)).toEqual(['mock-model-1', 'mock-model-2'])
    })

    it('sets the model and returns the updated snapshot', async () => {
      const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-model', MOCK_CONFIG_OPTIONS: '1' } })] })
      await harness.service.start('architect')
      const sessionId = await harness.service.newSession('architect')
      const snapshot = await harness.service.setConfig('architect', sessionId, 'model', 'mock-model-2')
      expect(snapshot.model?.currentValue).toBe('mock-model-2')
    })

    it('rejects config reads when the member does not advertise config options', async () => {
      const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-model' } })] })
      await harness.service.start('architect')
      const sessionId = await harness.service.newSession('architect')
      await expect(harness.service.getConfig('architect', sessionId)).rejects.toThrow(/no session config/)
    })
  })

  describe('provider configuration', () => {
    it('lists providers when the member advertises the capability', async () => {
      const harness = await setup({ members: [mockMember({ env: { MOCK_PROVIDERS: '1' } })] })
      await harness.service.start('architect')
      const providers = await harness.service.listProviders('architect')
      expect(providers.map(provider => provider.id)).toContain('mock-provider')
      expect(providers[0]!.current).toEqual({ apiType: 'openai', baseUrl: 'https://mock.example/v1' })
    })

    it('rejects provider listing when the capability is not advertised', async () => {
      const harness = await setup({ members: [mockMember()] })
      await harness.service.start('architect')
      await expect(harness.service.listProviders('architect')).rejects.toThrow(/does not support provider configuration/)
    })

    it('sets a provider when the capability is advertised', async () => {
      const harness = await setup({ members: [mockMember({ env: { MOCK_PROVIDERS: '1' } })] })
      await harness.service.start('architect')
      await expect(harness.service.setProvider('architect', {
        id: 'mock-provider',
        apiType: 'openai',
        baseUrl: 'https://example.com/v1',
        headers: undefined,
      })).resolves.toBeUndefined()
    })

    it('rejects provider set when the capability is not advertised', async () => {
      const harness = await setup({ members: [mockMember()] })
      await harness.service.start('architect')
      await expect(harness.service.setProvider('architect', {
        id: 'mock-provider',
        apiType: 'openai',
        baseUrl: 'https://example.com/v1',
        headers: { Authorization: 'Bearer x' },
      })).rejects.toThrow(/does not support provider configuration/)
    })
  })

  it('reads a topic\'s replayed history from the member', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_HISTORY: '1' } })] })
    await harness.service.start('architect')
    await expect(harness.service.readHistory('architect', 'topic-design')).resolves.toEqual([
      { role: 'user', text: 'earlier question' },
      { role: 'assistant', text: 'earlier answer' },
    ])
  })

  it('reads full-fidelity replayed history as tool/call + tool/result events', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_HISTORY_RICH: '1' } })] })
    await harness.service.start('architect')
    const events = await harness.service.readHistoryEvents('architect', 'topic-design')
    const call = events.find(e => e.type === 'tool/call')
    const result = events.find(e => e.type === 'tool/result')
    expect(events.map(e => e.type)).toContain('tool/call')
    expect(events.map(e => e.type)).toContain('tool/result')
    expect(call?.data).toMatchObject({ callId: 'rich-call', name: 'rich_tool', arguments: '{"query":"value"}' })
    expect((result as { surfaceOp: string }).surfaceOp).toBe('append')
    expect((result?.data as { message: { content: [{ content: { type: string; text: string }[] }] } }).message.content[0].content)
      .toEqual([{ type: 'text', text: 'tool output' }])
  })

  it('retains capabilities from the initialize handshake', async () => {
    const harness = await setup()
    await harness.service.start('architect')
    const capabilities = harness.service.list()[0]?.capabilities
    expect(capabilities?.loadSession).toBe(true)
    expect(capabilities?.sessionCapabilities?.list).toEqual({})
  })
})

describe('prompt turns', () => {
  it('chat drives one turn, returns text + stop reason, and emits updates and turn-end', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_TEXT: 'design reply' } })] })
    await harness.service.start('architect')
    const result = await harness.service.chat('architect', 'topic-design', 'design the system')
    expect(result.text).toBe('design reply')
    expect(result.stopReason).toBe('end_turn')
    expect(harness.updateEvents.some(([memberId, sessionId, update]) =>
      memberId === 'architect' && sessionId === 'topic-design'
      && (update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk')).toBe(true)
    expect(harness.turnEndEvents).toEqual([['architect', 'topic-design', expect.stringMatching(/^team-architect-/), 'end_turn', undefined]])
  })

  it('prompt accepts immediately and the turn settles via a turn-end event', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design' } })] })
    await harness.service.start('architect')
    const { promptId } = await harness.service.prompt('architect', 'topic-design', 'design the system')
    await expect(nextTurnEnd(harness, 'architect', 'topic-design')).resolves.toBe('end_turn')
    expect(harness.turnEndEvents[0]?.[2]).toBe(promptId)
  })

  it('promptContent carries image blocks to the agent and settles via turn-end', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-images', MOCK_ECHO_IMAGES: '1' } })] })
    await harness.service.start('architect')
    const { promptId } = await harness.service.promptContent('architect', 'topic-images', [
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'AQI=', mimeType: 'image/png' },
    ])
    expect(await nextTurnEnd(harness, 'architect', 'topic-images')).toBe('end_turn')
    expect(harness.turnEndEvents[0]?.[2]).toBe(promptId)
    // The agent echoes the block types it received — the image must have crossed the wire.
    const chunkUpdate = harness.updateEvents
      .map(([, , update]) => update)
      .find(update => (update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk')
    expect((chunkUpdate as { content: { text: string } }).content.text).toBe('blocks:text+image')
  })

  it('rejects a blank-text promptContent loud', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-empty' } })] })
    await harness.service.start('architect')
    await expect(harness.service.promptContent('architect', 'topic-empty', [{ type: 'text', text: '   ' }]))
      .rejects.toThrow(/empty prompt/)
  })

  it('rejects a second prompt while one is in flight', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_HANG: '1' } })] })
    await harness.service.start('architect')
    await harness.service.prompt('architect', 'topic-design', 'first')
    await expect(harness.service.prompt('architect', 'topic-design', 'second')).rejects.toThrow(/already in flight/)
    await harness.service.cancel('architect', 'topic-design')
  })

  it('cancel settles the in-flight turn as cancelled', async () => {
    const ready = join(tmpdir(), `team-cancel-ready-${Math.random().toString(36).slice(2)}`)
    const harness = await setup({
      members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_HANG: '1', MOCK_READY_FILE: ready } })],
    })
    await harness.service.start('architect')
    const { promptId } = await harness.service.prompt('architect', 'topic-design', 'hang')
    // Wait until the member is actually waiting on its prompt (its cancel
    // handler is armed), so the cancel cannot race the prompt registration.
    await waitForMarker(ready)
    await harness.service.cancel('architect', 'topic-design')
    await expect(nextTurnEnd(harness, 'architect', 'topic-design')).resolves.toBe('cancelled')
    expect(harness.turnEndEvents[0]?.[2]).toBe(promptId)
  }, 15_000)

  it('chat cancellation via AbortSignal returns early with the partial text', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_HANG: '1' } })] })
    await harness.service.start('architect')
    const controller = new AbortController()
    const chat = harness.service.chat('architect', 'topic-design', 'hang', controller.signal)
    // Give the child a beat to stream its chunk, then abort.
    await new Promise(resolve => setTimeout(resolve, 300))
    controller.abort()
    await expect(chat).resolves.toMatchObject({ stopReason: 'cancelled' })
  })
})

describe('permission routing', () => {
  it('auto-answers by the allow policy', async () => {
    const harness = await setup({
      members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_PERMISSION: '1' }, permission: 'allow' })],
    })
    await harness.service.start('architect')
    await expect(harness.service.chat('architect', 'topic-design', 'run it'))
      .resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('auto-answers by the reject policy with cancelled', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_PERMISSION: '1' } })] })
    await harness.service.start('architect')
    await expect(harness.service.chat('architect', 'topic-design', 'run it'))
      .resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('routes to subscribers and answers through service.permission', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_PERMISSION: '1' } })] })
    await harness.service.start('architect')
    const seen: import('../src/types.ts').TeamPermissionRequest[] = []
    harness.service.onPermissionRequest((request) => { seen.push(request) })
    const chat = harness.service.chat('architect', 'topic-design', 'run it')
    const request = await nextPermission(harness, 'architect')
    expect(request.sessionId).toBe('topic-design')
    expect(request.toolCall.toolCallId).toBe('mock-call')
    expect(request.options.map(option => option.optionId).sort()).toEqual(['no', 'yes'])
    await harness.service.permission('architect', request.requestId, { outcome: 'selected', optionId: 'yes' })
    await expect(chat).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(seen.map(item => item.requestId)).toContain(request.requestId)
    // An unknown request id is a silent no-op.
    await expect(harness.service.permission('architect', 'unknown-request', { outcome: 'cancelled' })).resolves.toBeUndefined()
  })

  it('contains a throwing subscriber so an answering subscriber still wins', async () => {
    const harness = await setup({ members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_PERMISSION: '1' } })] })
    await harness.service.start('architect')
    harness.service.onPermissionRequest(() => { throw new Error('boom') })
    harness.service.onPermissionRequest(() => ({ outcome: 'selected', optionId: 'yes' }))
    // The throwing handler must neither cancel the request nor preempt the
    // answering handler: the turn completes normally.
    await expect(harness.service.chat('architect', 'topic-design', 'run it'))
      .resolves.toMatchObject({ stopReason: 'end_turn' })
  })
})

describe('environment inheritance', () => {
  it('forwards the full parent environment including credential-shaped entries', async () => {
    const previous = process.env.TEAM_MOCK_SECRET_KEY
    process.env.TEAM_MOCK_SECRET_KEY = 's3cret-value'
    try {
      const harness = await setup({
        members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_ECHO_ENV: 'TEAM_MOCK_SECRET_KEY' } })],
      })
      await harness.service.start('architect')
      // The scrub strips KEY-shaped names from every other spawner; the member
      // opt-in must still deliver the credential.
      await expect(harness.service.chat('architect', 'topic-design', 'echo')).resolves.toMatchObject({ text: 's3cret-value' })
    } finally {
      if (previous === undefined) delete process.env.TEAM_MOCK_SECRET_KEY
      else process.env.TEAM_MOCK_SECRET_KEY = previous
    }
  })

  it('lets config.env override an inherited entry', async () => {
    const previous = process.env.TEAM_MOCK_OVERRIDE
    process.env.TEAM_MOCK_OVERRIDE = 'parent'
    try {
      const harness = await setup({
        members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_ECHO_ENV: 'TEAM_MOCK_OVERRIDE', TEAM_MOCK_OVERRIDE: 'child' } })],
      })
      await harness.service.start('architect')
      await expect(harness.service.chat('architect', 'topic-design', 'echo')).resolves.toMatchObject({ text: 'child' })
    } finally {
      if (previous === undefined) delete process.env.TEAM_MOCK_OVERRIDE
      else process.env.TEAM_MOCK_OVERRIDE = previous
    }
  })

  it('strips the harness-managed DSH_* namespace from the inherited environment', async () => {
    const previous = process.env.DSH_TEAM_TEST_SENTINEL
    process.env.DSH_TEAM_TEST_SENTINEL = 'harness-internal'
    try {
      const harness = await setup({
        members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_ECHO_ENV: 'DSH_TEAM_TEST_SENTINEL' } })],
      })
      await harness.service.start('architect')
      // DSH_* keys configure THIS harness instance; the member must not see them.
      await expect(harness.service.chat('architect', 'topic-design', 'echo'))
        .resolves.toMatchObject({ text: '<DSH_TEAM_TEST_SENTINEL unset>' })
    } finally {
      if (previous === undefined) delete process.env.DSH_TEAM_TEST_SENTINEL
      else process.env.DSH_TEAM_TEST_SENTINEL = previous
    }
  })
})

describe('dsh member resolution', () => {
  it('resolves kind: dsh to the current installation with a self-contained per-member home', () => {
    const spec = team.resolveMemberSpec({ id: 'helper', kind: 'dsh' })
    expect(spec.command).toBe(process.execPath)
    expect(spec.args).toEqual(expect.arrayContaining([process.argv[1], '--profile', 'acp']))
    expect(spec.args.at(-2)).toBe('--profile')
    expect(spec.args.at(-1)).toBe('acp')
    expect(spec.env.DSH_HOME).toMatch(/[\\/]members[\\/]helper$/)
    // The member is self-contained: no DSH_MAIN_HOME, so it reads only its home.
    expect(spec.env.DSH_MAIN_HOME).toBeUndefined()
  })

  it('filters Node inspect flags from the relaunch argv', () => {
    const previous = process.execArgv
    Object.defineProperty(process, 'execArgv', { value: ['--import', 'tsx', '--inspect=9229', '--inspect-port', '9230', '--run'], configurable: true })
    try {
      const spec = team.resolveMemberSpec({ id: 'helper', kind: 'dsh' })
      expect(spec.args).not.toContain('--inspect=9229')
      expect(spec.args).not.toContain('--inspect-port')
      expect(spec.args).not.toContain('9230')
      expect(spec.args).toContain('--run')
      expect(spec.args).toContain('--import')
    } finally {
      Object.defineProperty(process, 'execArgv', { value: previous, configurable: true })
    }
  })

  it('throws when kind: dsh and command are both set', () => {
    expect(() => team.resolveMemberSpec({ id: 'helper', kind: 'dsh', command: 'node' }))
      .toThrow(/cannot set both kind:'dsh' and command/)
  })

  it('throws when kind: dsh and args are both set', () => {
    expect(() => team.resolveMemberSpec({ id: 'helper', kind: 'dsh', args: ['x'] }))
      .toThrow(/cannot set args with kind:'dsh'/)
  })

  it('throws when neither kind nor command is set', () => {
    expect(() => team.resolveMemberSpec({ id: 'helper' }))
      .toThrow(/requires command or kind:'dsh'/)
  })
})

describe('offline cache', () => {
  it('serves cached sessions and history when the member is offline', async () => {
    const harness = await setup({
      storageRoot: await mkdtemp(join(tmpdir(), 'dsh-team-cache-')),
      members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_HISTORY_RICH: '1' } })],
    })
    await harness.service.start('architect')
    // Populate the cache with a live list and replay.
    await expect(harness.service.listSessions('architect')).resolves.toEqual([
      { sessionId: 'topic-design', cwd: process.cwd() },
    ])
    await harness.service.readHistoryEvents('architect', 'topic-design')
    await harness.service.stop('architect')

    // Offline: listSessions returns the cached list.
    await expect(harness.service.listSessions('architect')).resolves.toEqual([
      { sessionId: 'topic-design', cwd: process.cwd() },
    ])
    // Offline: readHistoryEvents folds the cached updates through the translator.
    const events = await harness.service.readHistoryEvents('architect', 'topic-design')
    expect(events.map(e => e.type)).toContain('tool/call')
    expect(events.map(e => e.type)).toContain('tool/result')
    // Offline: an unknown topic fails loud instead of returning empty.
    await expect(harness.service.readHistoryEvents('architect', 'unknown-topic')).rejects.toThrow(/no cached history/)
  })

  it('round-trips the cache through a storage-backed restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-cache-'))
    try {
      const first = await setup({
        storageRoot: root,
        members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_HISTORY: '1' } })],
      })
      await first.service.start('architect')
      await first.service.listSessions('architect')
      await first.service.readHistoryEvents('architect', 'topic-design')
      await first.service.stop('architect')
      // Confirm the cache is in storage while the first context is still alive.
      await expect(first.service.listSessions('architect')).resolves.toEqual([
        { sessionId: 'topic-design', cwd: process.cwd() },
      ])
      for (const fiber of [...first.fibers].reverse()) await fiber.dispose()
      harnesses.splice(harnesses.indexOf(first), 1)

      // A fresh service on the same storage root sees the cached sessions
      // before the member is started.
      const second = await setup({ storageRoot: root })
      await expect(second.service.listSessions('architect')).resolves.toEqual([
        { sessionId: 'topic-design', cwd: process.cwd() },
      ])
      const events = await second.service.readHistoryEvents('architect', 'topic-design')
      expect(events.map(e => e.type)).toContain('user/message')
      expect(events.map(e => e.type)).toContain('assistant/message')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('session metadata passthrough', () => {
  it('passes title and updatedAt from the wire through listSessions and the cache', async () => {
    const harness = await setup({
      members: [mockMember({
        env: {
          MOCK_SESSION_ID: 'topic-design',
          MOCK_SESSION_TITLE: 'Design Review',
          MOCK_SESSION_UPDATED_AT: '2026-08-16T10:00:00.000Z',
        },
      })],
    })
    await harness.service.start('architect')
    const live = await harness.service.listSessions('architect')
    expect(live[0]).toMatchObject({
      sessionId: 'topic-design',
      title: 'Design Review',
      updatedAt: '2026-08-16T10:00:00.000Z',
    })
    await harness.service.stop('architect')
    const cached = await harness.service.listSessions('architect')
    expect(cached[0]).toMatchObject({
      sessionId: 'topic-design',
      title: 'Design Review',
      updatedAt: '2026-08-16T10:00:00.000Z',
    })
  })
})

describe('translator integration', () => {
  it('deduplicates an echoed user message identical to the minted turn', async () => {
    const harness = await setup({
      members: [mockMember({ env: { MOCK_SESSION_ID: 'topic-design', MOCK_ECHO_USER: '1', MOCK_TEXT: 'design reply' } })],
    })
    await harness.service.start('architect')
    const { promptId } = await harness.service.prompt('architect', 'topic-design', 'design the system')
    await expect(nextTurnEnd(harness, 'architect', 'topic-design')).resolves.toBe('end_turn')
    // The live update stream included the echo; reading offline exercises the
    // cache + translator path.
    await harness.service.stop('architect')
    const history = await harness.service.readHistoryEvents('architect', 'topic-design')
    const userMessageEvents = history.filter(e => e.type === 'user/message')
    expect(userMessageEvents).toHaveLength(1)
    expect(harness.turnEndEvents.find(event => event[2] === promptId)?.[3]).toBe('end_turn')
  })
})

describe('durable roster', () => {
  it('addMember without args or env resolves the defaults and reaches a real spawn', async () => {
    const harness = await setup()
    // The host API schema makes args/env optional; the service funnel must
    // normalize them instead of letting the spawn crash on a spread of
    // undefined. A bad command then fails as a genuine spawn error.
    const snapshot = await harness.service.addMember({ id: 'bare', command: 'no-such-team-member-binary-xyz' })
    expect(snapshot).toMatchObject({ id: 'bare', autostart: true })
    await waitForStatus(harness, 'bare', 'failed')
    const member = harness.service.list().find(entry => entry.id === 'bare')
    expect(member?.lastError).toBeTruthy()
    expect(member?.lastError ?? '').not.toMatch(/iterable|undefined is not/)
  })

  it('persists an added member and re-raises it after a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-roster-'))
    try {
      const first = await setup({ storageRoot: root })
      await first.service.addMember({
        id: 'writer',
        title: 'Writer',
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
      })
      await waitForStatus(first, 'writer', 'idle')
      for (const fiber of [...first.fibers].reverse()) await fiber.dispose()
      harnesses.splice(harnesses.indexOf(first), 1)

      const second = await setup({ storageRoot: root })
      // The persisted member autostarts with the fresh service.
      await waitForStatus(second, 'writer', 'idle')
      expect(second.service.list().map(member => member.id).sort()).toEqual(['architect', 'writer'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists and re-raises a kind: dsh member', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-roster-'))
    try {
      const first = await setup({ storageRoot: root })
      await first.service.addMember({ id: 'dsh-helper', kind: 'dsh', autostart: false })
      expect(first.service.list().find(member => member.id === 'dsh-helper')?.kind).toBe('dsh')
      for (const fiber of [...first.fibers].reverse()) await fiber.dispose()
      harnesses.splice(harnesses.indexOf(first), 1)

      const second = await setup({ storageRoot: root })
      expect(second.service.list().find(member => member.id === 'dsh-helper')?.kind).toBe('dsh')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removeMember deletes the persisted record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-roster-'))
    try {
      const first = await setup({ storageRoot: root })
      await first.service.addMember({
        id: 'writer',
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
      })
      await waitForStatus(first, 'writer', 'idle')
      await first.service.removeMember('writer')
      for (const fiber of [...first.fibers].reverse()) await fiber.dispose()
      harnesses.splice(harnesses.indexOf(first), 1)

      const second = await setup({ storageRoot: root })
      expect(second.service.list().map(member => member.id)).toEqual(['architect'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps config members authoritative over a persisted duplicate id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-roster-'))
    try {
      const first = await setup({ storageRoot: root })
      await first.service.addMember({
        id: 'writer',
        title: 'Persisted Writer',
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
      })
      await waitForStatus(first, 'writer', 'idle')
      for (const fiber of [...first.fibers].reverse()) await fiber.dispose()
      harnesses.splice(harnesses.indexOf(first), 1)

      // The deployment now declares `writer` in config: config wins, the
      // persisted record is ignored, and no duplicate id is formed.
      const second = await setup({
        storageRoot: root,
        members: [mockMember(), mockMember({ id: 'writer', title: 'Config Writer' })],
      })
      const writers = second.service.list().filter(member => member.id === 'writer')
      expect(writers).toHaveLength(1)
      expect(writers[0]?.title).toBe('Config Writer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
