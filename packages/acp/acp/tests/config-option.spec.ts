import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

/**
 * Model-selector coverage: the bridge advertises `setSessionConfigOption`,
 * returns the `"model"` selector on session creation, rewrites the agent's
 * selection on set, and validates the value against the provider catalog.
 */

describe('ACP model selector', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('advertises the setSessionConfigOption capability', async () => {
    harness = await makeBridgeHarness()
    const { agentCapabilities } = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    // The pinned SDK's SessionListCapabilities predates this experimental flag,
    // so the capability is read through a cast for the assertion.
    const list = agentCapabilities?.sessionCapabilities?.list as {
      setSessionConfigOption?: unknown
    } | undefined
    expect(list?.setSessionConfigOption).toEqual({})
  })

  it('returns the full multi-route model selector on newSession', async () => {
    harness = await makeBridgeHarness()
    const { configOptions } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(configOptions).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'mock/mock',
        options: [
          { value: 'mock/mock', name: 'Mock' },
          { value: 'mock-alt/alt-model', name: 'Alt Model' },
        ],
      },
    ])
  })

  it('rewrites the selector currentValue on set and returns the updated options', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('ok')] })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const updated = await harness.client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: 'mock/mock',
    })
    expect(updated.configOptions).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'mock/mock',
        options: [
          { value: 'mock/mock', name: 'Mock' },
          { value: 'mock-alt/alt-model', name: 'Alt Model' },
        ],
      },
    ])

    // The next prompt's request carries the selected provider/model pair.
    await harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })
    const request = harness.adapter.requests[0]
    expect(request).toBeDefined()
    expect(request!.provider).toBe('mock')
    expect(request!.model).toBe('mock')
  })

  it('switches provider routes through the composite value', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('ok')] })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const updated = await harness.client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: 'mock-alt/alt-model',
    })
    expect(updated.configOptions[0]?.currentValue).toBe('mock-alt/alt-model')

    await harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })
    const request = harness.adapter.requests[0]
    expect(request).toBeDefined()
    expect(request!.provider).toBe('mock-alt')
    expect(request!.model).toBe('alt-model')
  })

  it('keeps the switched selection across a dsh/session/rerun', async () => {
    harness = await makeBridgeHarness({
      script: [textResponse('ok'), textResponse('after rerun')],
      persistence: { headers: [], eventsBySession: {} },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: 'mock-alt/alt-model',
    })
    await harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })

    // Rerun the completed turn, then send the follow-up: the rebuilt agent
    // keeps the switched route instead of re-seeding the default mock/mock.
    const lastSeq = harness.ctx.sessions
      .get(SessionId(sessionId))!.events.at(-1)!.seq
    const result = await harness.client.extMethod('dsh/session/rerun', {
      sessionId,
      at: lastSeq,
    }) as { accepted: boolean }
    expect(result.accepted).toBe(true)

    await harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'again' }],
    })
    const request = harness.adapter.requests[1]
    expect(request).toBeDefined()
    expect(request!.provider).toBe('mock-alt')
    expect(request!.model).toBe('alt-model')
  })

  it('rejects a value not in the provider catalog', async () => {
    harness = await makeBridgeHarness()
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: 'not-a-model',
    })).rejects.toThrow(/unknown model/)
  })

  it('rejects a config option the bridge does not support', async () => {
    harness = await makeBridgeHarness()
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.setSessionConfigOption({
      sessionId,
      configId: 'mode',
      value: 'mock',
    })).rejects.toThrow(/unsupported config option/)
  })

  it('rejects an empty value', async () => {
    harness = await makeBridgeHarness()
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: '',
    })).rejects.toThrow(/non-empty string/)
  })

  it('rejects an unknown session', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(harness.client.setSessionConfigOption({
      sessionId: SessionId('missing'),
      configId: 'model',
      value: 'mock',
    })).rejects.toThrow(/unknown session/)
  })
})
