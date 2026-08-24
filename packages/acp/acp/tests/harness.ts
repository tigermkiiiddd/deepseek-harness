/** In-memory ACP transport fixture over the real agent factory and loop. */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import AttachmentStore, { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { type GenerateOptions, LlmAdapter, CallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as AcpPlugin from '../src/index.ts'
import type { AcpConfig } from '../src/index.ts'

/** Scripted adapter for protocol tests. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: (StreamChunk[] | 'hang')[],
    private readonly imageCapable: boolean,
    private readonly contextWindow: number | undefined,
  ) {
    super()
  }

  override providerInfo(provider: string) {
    if (provider !== 'mock' && provider !== 'mock-alt') throw new Error(`MockAdapter: unknown provider ${provider}`)
    return { id: provider, name: provider === 'mock' ? 'Mock' : 'Alt Model' }
  }

  override listModels(provider: string) {
    if (provider === 'mock') {
      return Promise.resolve([{
        provider: 'mock',
        id: 'mock',
        name: 'Mock',
        inputModalities: this.imageCapable ? ['text', 'image'] as const : ['text'] as const,
      }])
    }
    if (provider === 'mock-alt') {
      return Promise.resolve([{
        provider: 'mock-alt',
        id: 'alt-model',
        name: 'Alt Model',
        inputModalities: this.imageCapable ? ['text', 'image'] as const : ['text'] as const,
      }])
    }
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(this.contextWindow === undefined ? {} : { context: { contextWindow: this.contextWindow } }),
      inputModalities: this.imageCapable ? ['text', 'image'] : ['text'],
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1024,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** In-memory durable store for ACP wire-order and lifecycle tests. */
class MemoryAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  readonly saved: SaveImageAttachment[] = []
  readonly objects = new Map<string, StoredImageAttachment>()
  beforeValidate: (() => Promise<void>) | undefined
  beforeRead: (() => Promise<void>) | undefined

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.beforeValidate?.()
    if (input.data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    const digest = createHash('sha256').update(input.data).digest('hex')
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${digest}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    this.objects.set(ref.attachmentId, { ref, data: Uint8Array.from(input.data) })
    return Promise.resolve(ref)
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    await this.beforeRead?.()
    const stored = this.objects.get(ref.attachmentId)
    if (stored === undefined) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    return { ref: stored.ref, data: Uint8Array.from(stored.data) }
  }
}

/** Scripted text response ending in a clean stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted reasoning + tool-call response that hands one call to the loop. */
export function reasoningToolCallResponse(
  reasoning: string,
  rawCallId: string,
  name: string,
  args: object,
): StreamChunk[] {
  const callId = CallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: reasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Scripted response ending at the output-token ceiling. */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Scripted response that fails after publishing an uncommitted partial chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } },
  ]
}

export type CapturedUpdate = SessionNotification['update']

export interface BridgeHarness {
  ctx: Context
  client: ClientSideConnection
  adapter: MockAdapter
  attachments: MemoryAttachmentStore | undefined
  updates: CapturedUpdate[]
  sessionUpdates: { sessionId: string; update: CapturedUpdate }[]
  permissionRequests: RequestPermissionRequest[]
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  onSessionUpdateError: (() => void) | undefined
  closeClientTransport: () => Promise<void>
  abortClientTransport: () => Promise<void>
  acpFiber: Awaited<ReturnType<Context['plugin']>>
  /** The AgentLoop fiber, so a test can reload the loop out from under the bridge. */
  loopFiber: Awaited<ReturnType<Context['plugin']>>
  dispose: () => Promise<void>
}

type AcpConfigOverrides = { [K in keyof AcpConfig]?: AcpConfig[K] | undefined }

/** Scripted session-persistence seam for list/load coverage. */
export interface PersistenceFixture {
  headers: { id: string; cwd: string }[]
  eventsBySession: Record<string, SessionEvent[]>
}

/** Build the bridge and a connected SDK client over cross-wired byte streams. */
export async function makeBridgeHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: AcpConfigOverrides
  persona?: string
  imageCapable?: boolean
  attachments?: boolean
  contextWindow?: number
  persistence?: PersistenceFixture
} = {}): Promise<BridgeHarness> {
  const adapter = new MockAdapter(
    options.script ?? [],
    options.imageCapable === true,
    options.contextWindow,
  )
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: options.persona ?? '' } })
  if (options.attachments !== false) await ctx.plugin(MemoryAttachmentStore)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock', 'mock-alt'], adapter)

  if (options.persistence !== undefined) {
    const fixture = options.persistence
    ctx.provide('sessionPersistence', {
      list: async () => fixture.headers,
      load: async (id: SessionId) => {
        const events = fixture.eventsBySession[String(id)]
        if (events === undefined) throw new Error(`missing session ${String(id)}`)
        return { events }
      },
    })
  }

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgentWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => clientToAgentWriter.write(chunk),
  })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const sessionUpdates: { sessionId: string; update: CapturedUpdate }[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    attachments: ctx.get('attachments') as MemoryAttachmentStore | undefined,
    updates,
    sessionUpdates,
    permissionRequests,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    onSessionUpdateError: undefined,
    client: undefined as unknown as ClientSideConnection,
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    loopFiber,
    closeClientTransport: async () => { await clientToAgentWriter.close() },
    abortClientTransport: async () => { await clientToAgentWriter.abort(new Error('client transport failed')) },
    dispose: async () => { await ctx.fiber.dispose() },
  }

  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      updates.push(params.update)
      sessionUpdates.push({ sessionId: params.sessionId, update: params.update })
      if (harness.onSessionUpdateError !== undefined) return Promise.reject(new Error('client update rejected'))
      return Promise.resolve()
    },
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      permissionRequests.push(params)
      return Promise.resolve(harness.onPermission(params))
    },
  })

  const config = { stream: agentStream, ...options.config } as AcpConfig
  if (!(options.config && 'provider' in options.config)) config.provider = 'mock'
  if (!(options.config && 'model' in options.config)) config.model = 'mock'
  harness.acpFiber = await ctx.plugin({
    name: 'acp-test',
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => { AcpPlugin.apply(inner, config) },
  })
  harness.client = new ClientSideConnection(makeClient, clientStream)
  return harness
}
