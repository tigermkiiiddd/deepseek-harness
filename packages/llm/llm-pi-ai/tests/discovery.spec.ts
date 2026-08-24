import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { userAgent } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { CATALOG_CACHE_FORMAT, catalogFingerprint } from '../src/catalog-cache.ts'
import { catalogModels } from '../src/catalog.ts'
import { discoverModels } from '../src/discovery.ts'

const servers: Server[] = []
/** Credential variables a test set, cleared so the next one starts unset. */
const touchedEnv: string[] = []
/** Temp cache directories a test created, removed so no case leaks its store. */
const tempDirs: string[] = []

afterEach(async () => {
  // A no-op when the test never stubbed `fetch`; only 'probe key format'
  // below installs one.
  vi.unstubAllGlobals()
  for (const name of touchedEnv.splice(0)) Reflect.deleteProperty(process.env, name)
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A throwaway cache directory so no test writes into the real harness home. */
async function tempCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-pi-ai-cache-'))
  tempDirs.push(dir)
  return dir
}

/** A dormant mount whose catalog cache lives in a test-owned directory. */
async function harnessWithCache(cacheDir: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { catalogCacheDir: cacheDir })
  return ctx
}

/** A store a test plants ahead of time, shaped like one refreshCatalog wrote. */
async function plantCache(cacheDir: string, provider: string, models: Array<{ id: string; api?: string }>): Promise<string> {
  const path = join(cacheDir, `${provider}.json`)
  const file = {
    format: CATALOG_CACHE_FORMAT,
    fingerprint: catalogFingerprint(catalogModels(provider)),
    fetchedAt: new Date().toISOString(),
    endpoints: ['https://planted.example/models'],
    models,
  }
  await writeFile(path, JSON.stringify(file), 'utf8')
  return path
}

async function readCacheFile(cacheDir: string, provider: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(cacheDir, `${provider}.json`), 'utf8')) as Record<string, unknown>
}

interface ListingServer {
  url: string
  paths: string[]
  headers: IncomingMessage['headers'][]
}

/**
 * A stand-in provider that answers one scripted `GET /models`. `chunks` writes
 * without a declared length, which is how a real streamed reply arrives.
 */
async function listingServer(behavior: {
  status?: number
  body?: string
  chunks?: string[]
  holdOpenMs?: number
}): Promise<ListingServer> {
  const paths: string[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    headers.push(request.headers)
    if (behavior.chunks !== undefined) {
      // No declared length: the ceiling has to hold on what is read.
      response.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' })
      for (const chunk of behavior.chunks) response.write(chunk)
      if (behavior.holdOpenMs === undefined) { response.end(); return }
      // Left open so a caller's cancellation lands while the body is still
      // being read rather than after it completed.
      setTimeout(() => { response.end() }, behavior.holdOpenMs)
      return
    }
    const body = behavior.body ?? '{}'
    response.writeHead(behavior.status ?? 200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, headers }
}

/** A bare dormant mount: discovery is offered whether or not a route exists. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {})
  return ctx
}

describe('catalog-route model discovery', () => {
  it('answers from the installed registry, with capacities and no network call', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'from-the-endpoint' }] }) })
    const ctx = await harness()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek', baseURL: server.url })

    // pi-ai's own registry is the authority for its own providers, and it
    // carries what a listing endpoint would not disclose.
    expect(models.map(model => model.id).sort())
      .toEqual(getBuiltinModels('deepseek').map(model => model.id).sort())
    expect(models.every(model => (model.contextWindow ?? 0) > 0 && (model.maxTokens ?? 0) > 0)).toBe(true)
    expect(server.paths).toEqual([])
  })

  it('needs no endpoint for a route the catalog describes', async () => {
    const ctx = await harness()
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek' })).resolves.not.toHaveLength(0)
  })

  it('says where a route the catalog does not describe must get its models', async () => {
    const ctx = await harness()
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway' }))
      .rejects.toThrow(/ships no usable endpoint for provider "acme-gateway".*set a baseURL/s)
    // A form that cleared the field says the same thing as one that never had it.
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: '' }))
      .rejects.toThrow(/set a baseURL/)
    // The seam refuses a request naming neither, so the module's own guard for
    // that shape is only reachable by calling it directly.
    await expect(discoverModels({})).rejects.toThrow(/set a baseURL/)
  })
})

describe('catalog cache refresh (preferEndpoint)', () => {
  it('stores the endpoint listing and answers from it with installed metadata', async () => {
    const installed = getBuiltinModels('deepseek')
    const knownId = installed[0]?.id ?? 'known'
    // The resolved base is a real host, so the fetch is stubbed: the point
    // under test is which URL the resolution chose and what lands in the store.
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      urls.push(String(url))
      return new Response(JSON.stringify({
        data: [
          // An upstream row for a model the cache already describes: the
          // installed entry's capacities answer, not the listing's.
          { id: knownId, context_length: 1 },
          { id: 'upstream-new-one' },
          { id: 'upstream-new-two', display_name: 'Upstream New Two' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const cacheDir = await tempCacheDir()
    const ctx = await harnessWithCache(cacheDir)

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek', preferEndpoint: true })

    // The endpoint is the current truth: its listing, in its order.
    expect(urls).toEqual(['https://api.deepseek.com/models'])
    expect(models.map(model => model.id)).toEqual([knownId, 'upstream-new-one', 'upstream-new-two'])
    const known = models.find(model => model.id === knownId)
    expect(known).toMatchObject({ contextWindow: installed[0]?.contextWindow, maxTokens: installed[0]?.maxTokens })
    // deepseek's catalog agrees on one protocol, so every row carries it.
    expect(models.every(model => model.api === 'openai-completions')).toBe(true)

    const file = await readCacheFile(cacheDir, 'deepseek')
    expect(file['format']).toBe(CATALOG_CACHE_FORMAT)
    expect(file['fingerprint']).toBe(catalogFingerprint(catalogModels('deepseek')))
    expect(file['endpoints']).toEqual(['https://api.deepseek.com/models'])
    expect(file['models']).toEqual([
      { id: knownId, api: 'openai-completions' },
      { id: 'upstream-new-one', api: 'openai-completions' },
      { id: 'upstream-new-two', api: 'openai-completions', name: 'Upstream New Two' },
    ])
  })

  it('tags an upstream addition with its family protocol on a multi-protocol route', async () => {
    const installed = getBuiltinModels('opencode-go')
    if (installed.length === 0) throw new Error('the installed catalog ships no opencode-go models')
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ data: [{ id: 'upstream-new' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const cacheDir = await tempCacheDir()
    const ctx = await harnessWithCache(cacheDir)

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'opencode-go', preferEndpoint: true })

    // Only the listable family is asked, on its own /v1 base.
    expect(urls).toEqual(['https://opencode.ai/zen/go/v1/models'])
    const added = models.find(model => model.id === 'upstream-new')
    expect(added?.api).toBe('openai-completions')
    const file = await readCacheFile(cacheDir, 'opencode-go')
    expect(file['models']).toEqual([{ id: 'upstream-new', api: 'openai-completions' }])
  })

  it('refuses an empty listing and keeps the previous store', async () => {
    const cacheDir = await tempCacheDir()
    const path = await plantCache(cacheDir, 'deepseek', [{ id: 'planted-model', api: 'openai-completions' }])
    const before = await readFile(path, 'utf8')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const ctx = await harnessWithCache(cacheDir)

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek', preferEndpoint: true }))
      .rejects.toThrow(/answered with no models; refusing to replace the installed catalog/)

    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('keeps the previous store when the endpoint refuses', async () => {
    const cacheDir = await tempCacheDir()
    const path = await plantCache(cacheDir, 'deepseek', [{ id: 'planted-model', api: 'openai-completions' }])
    const before = await readFile(path, 'utf8')
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }))
    const ctx = await harnessWithCache(cacheDir)

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek', preferEndpoint: true }))
      .rejects.toThrow(/answered 401; check the API key/)

    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('still answers from the installed catalog without the flag', async () => {
    // The default stays network-free: the flag is what opts into upstream.
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ data: [{ id: 'from-the-endpoint' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const cacheDir = await tempCacheDir()
    const ctx = await harnessWithCache(cacheDir)

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek' })

    expect(models.map(model => model.id).sort()).toEqual(getBuiltinModels('deepseek').map(model => model.id).sort())
    expect(urls).toEqual([])
  })

  it('falls through to plain interrogation for a declared route', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'draft-only' }] }) })
    const cacheDir = await tempCacheDir()
    const ctx = await harnessWithCache(cacheDir)

    expect(await ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'acme-gateway',
      baseURL: server.url,
      preferEndpoint: true,
    })).toEqual([{ id: 'draft-only' }])
  })
})

describe('draft-provider model discovery', () => {
  it('reads an OpenAI-compatible listing and keeps the capacities it discloses', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        data: [
          { id: 'acme-large', display_name: 'Acme Large', context_length: 65_536, max_output_tokens: 4096 },
          { id: 'acme-small' },
        ],
      }),
    })
    const ctx = await harness()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { baseURL: `${server.url}/v1`, apiKey: 'probe-key' })

    expect(models).toEqual([
      { id: 'acme-large', name: 'Acme Large', contextWindow: 65_536, maxTokens: 4096 },
      { id: 'acme-small' },
    ])
    expect(server.paths).toEqual(['/v1/models'])
    expect(server.headers[0]?.authorization).toBe('Bearer probe-key')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('keeps a deployment path instead of resolving it away', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = await harness()

    await ctx.llm.discoverModels('llm-pi-ai', { baseURL: `${server.url}/openai/v1/` })

    expect(server.paths).toEqual(['/openai/v1/models'])
  })

  it('offers no credential when the draft names none', async () => {
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = await harness()

    await ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url })

    expect(server.headers[0]?.authorization).toBeUndefined()
  })

  it('authenticates a configured route the draft cannot supply a key for', async () => {
    // What the Models page actually sends after a key is saved: the form holds
    // the redacted descriptor, so the draft names the route and the endpoint
    // and no credential at all. Interrogating unauthenticated would answer 401
    // and read as a wrong key.
    const server = await listingServer({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    process.env['ACME_GATEWAY_KEY'] = 'stored-key'
    touchedEnv.push('ACME_GATEWAY_KEY')
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_KEY',
          api: 'openai-completions',
          baseURL: server.url,
          models: [{ id: 'acme-large' }],
        },
      },
    })

    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: server.url })
    // A key typed into the form is the one being tested — possibly the
    // replacement for the stored one — so it wins.
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'acme-gateway', baseURL: server.url, apiKey: 'typed' })
    // A route no profile declares yet is the create case: nothing is stored.
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'not-declared-yet', baseURL: server.url })

    expect(server.headers.map(headers => headers.authorization))
      .toEqual(['Bearer stored-key', 'Bearer typed', undefined])
  })

  it('leaves a catalog route\'s credential unresolved, having never reached the network', async () => {
    // The catalog answers before any endpoint is asked, so a route whose
    // profile names a credential that is not set must still answer rather than
    // failing over a key the interrogation never needed.
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    Reflect.deleteProperty(process.env, 'ABSENT_FOR_DISCOVERY')
    await ctx.plugin(LlmPiAi, { catalogSyncEnabled: false, providers: { deepseek: { apiKeyEnv: 'ABSENT_FOR_DISCOVERY' } } })

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek' })).resolves.not.toHaveLength(0)
  })

  it('drops unusable rows rather than failing the whole listing', async () => {
    const server = await listingServer({
      body: JSON.stringify({
        data: [
          { id: 'good' },
          { id: '' },
          { name: 'no id at all' },
          null,
          { id: 'good' },
          { id: 'zero-capacity', context_length: 0, max_tokens: -1 },
        ],
      }),
    })
    const ctx = await harness()

    expect(await ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url }))
      .toEqual([{ id: 'good' }, { id: 'zero-capacity' }])
  })

  it('points at the credential for a rejected one, and only then', async () => {
    const ctx = await harness()

    for (const status of [401, 403]) {
      const refused = await listingServer({ status, body: '{"error":"nope"}' })
      await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: refused.url, apiKey: 'wrong' }))
        .rejects.toThrow(new RegExp(`answered ${status}; check the API key`))
    }

    // A server fault is not a credential problem, so it must not send the user
    // off to re-check a key that is fine.
    const broken = await listingServer({ status: 500, body: '{"error":"boom"}' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: broken.url, apiKey: 'fine' }))
      .rejects.toThrow(/answered 500$/)
  })

  it('reports a reply that is not a model listing', async () => {
    const server = await listingServer({ body: '{"models":[]}' })
    const ctx = await harness()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: server.url }))
      .rejects.toThrow(/no "data" array; enter this provider's models by hand/)

    const broken = await listingServer({ body: 'not json at all' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: broken.url }))
      .rejects.toThrow(/did not answer with JSON/)
  })

  it('refuses an oversized reply, whether its length is declared or streamed', async () => {
    const ctx = await harness()
    // Just over the four-megabyte ceiling, as one padded model row.
    const oversized = `{"data":[{"id":"m","pad":"${'x'.repeat(4 * 1024 * 1024)}"}]}`

    const declared = await listingServer({ body: oversized })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: declared.url }))
      .rejects.toThrow(/answered with more than 4194304 bytes/)

    // A streamed reply declares no length, so the ceiling has to hold on the
    // body the harness actually read.
    const streamed = await listingServer({ chunks: ['{"data":[{"id":"m","pad":"', 'x'.repeat(4 * 1024 * 1024), '"}]}'] })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: streamed.url }))
      .rejects.toThrow(/answered with more than 4194304 bytes/)
  })

  it('reports an unreachable endpoint instead of an empty catalog', async () => {
    const ctx = await harness()
    // Port 9 is the discard service: nothing accepts a connection there.
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: 'http://127.0.0.1:9/v1' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it.each(['anthropic-messages', 'azure-openai-responses', 'openai-codex-responses', 'google-generative-ai'])(
    'says it cannot interrogate %s rather than guessing a shape',
    async (api) => {
      // Azure authenticates with an `api-key` header and an `api-version`
      // query despite its OpenAI lineage, and Codex uses OAuth; guessing at
      // either would report an auth failure as a provider with no models.
      const ctx = await harness()
      await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: 'https://gateway.example/v1', api }))
        .rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
    },
  )

  it('reports cancellation during the body read as an abort, not a raw reason', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const bodyRead = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (signal === undefined || signal === null) throw new Error('expected a discovery signal')
      return new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          bodyRead.resolve(undefined)
          return new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              stream.error(signal.reason)
              resolve()
            }, { once: true })
          })
        },
      }))
    })
    const probe = ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: 'https://slow.example/v1',
      signal: controller.signal,
    })
    await bodyRead.promise
    controller.abort('test cancellation')

    await expect(probe).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('honors caller cancellation', async () => {
    const ctx = await harness()
    const aborted = AbortSignal.abort('test cancellation')
    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      baseURL: 'http://127.0.0.1:9/v1',
      signal: aborted,
    })).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('is offered for the namespace, and refuses one it does not serve', async () => {
    const ctx = await harness()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).resolves.not.toHaveLength(0)
    await expect(ctx.llm.discoverModels('llm-deepseek', { baseURL: 'https://api.deepseek.com' }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { baseURL: '' }))
      .rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
  })

  it('withdraws the offer when the plugin unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmPiAi, {})
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).resolves.not.toHaveLength(0)

    await fiber.dispose()

    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
  })
})

describe('probe key format', () => {
  it('reports an illegal probe key as a credential fault, not an unreachable endpoint', async () => {
    await expect(discoverModels({
      baseURL: 'https://acme.test',
      api: 'openai-completions',
      apiKey: 'sk-\u{1F600}',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('reports a blank probe key as a credential fault too', async () => {
    // The Models page omits `apiKey` entirely for a cleared field rather than
    // sending '', so this pins the contract for every other caller: a supplied
    // key is judged, and only an absent one probes unauthenticated. '' means
    // "I have a key" and is answered as the empty key it is.
    await expect(discoverModels({
      baseURL: 'https://acme.test',
      api: 'openai-completions',
      apiKey: '',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('leaves a probe with no key unauthenticated', async () => {
    // The file's other cases capture headers through a real local HTTP server
    // (`listingServer`); this one has no route or stored key to resolve, so
    // the smallest real double is a `fetch` stub, scoped to this test and
    // unstubbed by the shared `afterEach` above.
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await discoverModels({ baseURL: 'https://acme.test', api: 'openai-completions' })

    const headers = new Headers(requests[0]?.headers)
    expect(headers.has('authorization')).toBe(false)
  })
})
