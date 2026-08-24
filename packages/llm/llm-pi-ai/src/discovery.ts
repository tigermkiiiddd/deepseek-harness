/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's refresh and fetch actions.
 *
 * A route the installed pi-ai catalog ships is answered **from that catalog**,
 * with no network call at all: pi-ai's registry is the authoritative list for
 * its own providers, and it carries the capacities a listing endpoint would
 * not disclose. Only a route the catalog does not describe — a gateway, a
 * self-hosted server — is interrogated over the wire.
 *
 * {@link refreshCatalog} is the other half of that: the installed catalog is
 * a version cache, and upstream keeps adding models it has not caught up with.
 * A refresh asks every listable protocol family on the route for its current
 * listing, tags each model with the protocol of the listing that named it,
 * and stores the union in the route's local cache file — which resolution
 * then serves in place of the frozen snapshot. The write is all-or-nothing:
 * a refused or empty endpoint keeps the previous cache, so a partial answer
 * can never retire models the route was serving. `settings.yaml` stays
 * untouched; the route remains an installed provider.
 *
 * Only OpenAI-compatible protocols are interrogated. Their listing is the one
 * shape a gateway, a self-hosted server, and the official endpoints all agree
 * on, which is the case this action exists for; every other protocol reports
 * that it cannot be interrogated so the surface falls back to hand-entry
 * rather than guessing a response shape.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { CATALOG_CACHE_FORMAT } from './catalog-cache.ts'
import type { CatalogCacheFile, CatalogCacheModel } from './catalog-cache.ts'
import { catalogFingerprint, writeCatalogCache } from './catalog-cache.ts'
import { catalogModels, catalogProvider, siblingBaseUrl } from './catalog.ts'

/**
 * Protocols whose model listing this module can read: the two that speak
 * OpenAI's `GET /models` shape with bearer auth. Azure is absent despite its
 * OpenAI lineage — it authenticates with an `api-key` header and requires an
 * `api-version` query — and Codex authenticates through OAuth; guessing at
 * either would report an authentication failure as a provider with no models.
 * pi-ai's remaining protocols are absent for the same reason.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
])

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments instead of losing
 * them to `URL` resolution.
 */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one OpenAI-compatible listing reply. Entries without a usable id are
 * skipped rather than failing the whole interrogation: a single malformed row
 * should not deny the user the rest of a working endpoint's catalog.
 */
function readListing(body: unknown): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = label(entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name)
    const contextWindow = capacity(entry?.context_window, entry?.context_length)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedApiKey - the credential the named route already stored, asked
 *   for only when the draft carries none and only on the path that reaches the
 *   network. A configuration surface never holds a stored secret — it edits a
 *   redacted descriptor — so without this an already-configured route would be
 *   interrogated unauthenticated and answer 401.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedApiKey?: () => Promise<string | undefined>,
): Promise<readonly LlmDiscoveredModel[]> {
  const installed = request.provider === undefined ? undefined : catalogModels(request.provider)
  // A catalog route already has its answer, and a better one: the installed
  // entries carry context windows and output caps no listing endpoint reports.
  // Refreshing that cache is `refreshCatalog`, not this read.
  if (installed !== undefined && installed.size > 0) {
    return [...installed.values()].map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      api: model.api,
    }))
  }
  const baseURL = request.baseURL
  if (baseURL === undefined || baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no usable endpoint for provider "${request.provider ?? ''}"; set a baseURL, or enter`
      + " this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // A draft that has not chosen a protocol yet is asked as OpenAI Chat
  // Completions: it is the shape a gateway is overwhelmingly likely to speak,
  // and the alternative — refusing until the field is filled — would withhold
  // the action from the case it exists for. The cost is a misdirected message
  // when the endpoint speaks something else (an Anthropic gateway answers 401,
  // which reads as a credential problem), and hand-entry remains the way out.
  const api = request.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(baseURL)
  // A key typed into the form wins: it is the one the user is testing, and it
  // may be the replacement for exactly the stored key that is failing. The
  // stored one is only asked for here, past the catalog short-circuit and the
  // protocol check, so a route answered from the registry costs no credential
  // lookup — and no diagnostic about a credential it never needed.
  // A probe carrying no key stays unauthenticated, which is how a route that
  // relies on the provider's own ambient discovery is meant to be asked.
  const supplied = request.apiKey ?? await storedApiKey?.()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  return fetchListing(url, apiKey, request.signal)
}

/**
 * Interrogate one listing endpoint and return its models in endpoint order.
 * @param url - the full listing URL.
 * @param apiKey - bearer credential, or `undefined` for an unauthenticated ask.
 * @param signal - caller cancellation.
 * @returns the advertised models.
 */
async function fetchListing(
  url: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<LlmDiscoveredModel[]> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    if (signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // Cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}

/** Options for {@link refreshCatalog}. */
export interface CatalogRefreshOptions {
  /** Cache directory the refreshed listing is written to. */
  dir: string
  /** Bearer credential for the interrogation; `undefined` asks unauthenticated. */
  apiKey?: string | undefined
  /** Caller cancellation. */
  signal?: AbortSignal
}

/**
 * Refresh one catalog route's local cache from its own endpoints. Every
 * listable protocol family on the route is asked on that family's base, and
 * the union of their listings — each model tagged with the protocol of the
 * listing that named it — replaces the frozen snapshot in the cache file.
 * The write is all-or-nothing: a refused, unreachable, or empty endpoint keeps
 * the previous cache so a partial answer can never retire models the route was
 * serving. A model the route cannot resolve (no base for its protocol) is
 * dropped from the store rather than written to fail resolution later.
 * @param provider - the catalog route to refresh.
 * @param options - cache directory, credential, and cancellation.
 * @returns the document that was written.
 */
export async function refreshCatalog(provider: string, options: CatalogRefreshOptions): Promise<CatalogCacheFile> {
  const installed = catalogModels(provider)
  if (installed.size === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${provider}"; there is nothing to refresh`,
      'DISCOVERY_FAILED',
    )
  }
  const basesByApi = new Map<string, string[]>()
  for (const model of installed.values()) {
    if (!LISTABLE_PROTOCOLS.has(model.api)) continue
    if (typeof model.baseUrl !== 'string' || model.baseUrl.length === 0) continue
    const list = basesByApi.get(model.api) ?? []
    if (!list.includes(model.baseUrl)) list.push(model.baseUrl)
    basesByApi.set(model.api, list)
  }
  // One listing per protocol family, on that family's own base: the OpenAI-
  // compatible one sits under /v1 when the catalog carries it, and a family
  // asked on another family's base would report the wrong catalog or nothing.
  // A family only reaches this list with at least one base, so the filter
  // cannot drop an endpoint; it exists for the type, which cannot see that.
  const endpoints = [...basesByApi.entries()]
    .map(([api, bases]) => ({ api, baseURL: bases.find(base => base.endsWith('/v1')) ?? bases[0] }))
    .filter((endpoint): endpoint is { api: string; baseURL: string } => endpoint.baseURL !== undefined)
  // Two families may share one base (opencode-go serves completions and
  // responses from /zen/go/v1); the listing answers both, so it is asked once
  // and its models carry the first family's protocol.
  const unique = new Map<string, { api: string; baseURL: string }>()
  for (const endpoint of endpoints) {
    const key = endpoint.baseURL.replace(/\/+$/, '')
    if (!unique.has(key)) unique.set(key, endpoint)
  }
  if (unique.size === 0) {
    throw new LlmError(
      `pi-ai ships no usable endpoint for provider "${provider}"; set a baseURL, or enter this provider's`
      + ' models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const apiKey = options.apiKey === undefined ? undefined : usableProbeKey(options.apiKey)
  const seen = new Set<string>()
  const collected: CatalogCacheModel[] = []
  const sources: string[] = []
  for (const endpoint of unique.values()) {
    const url = listingUrl(endpoint.baseURL)
    sources.push(url)
    for (const entry of await fetchListing(url, apiKey, options.signal)) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      collected.push({ id: entry.id, api: endpoint.api, ...entry.name === undefined ? {} : { name: entry.name } })
    }
  }
  if (collected.length === 0) {
    throw new LlmError(
      `${sources.join(', ')} answered with no models; refusing to replace the installed catalog with an`
      + ' empty listing',
      'DISCOVERY_FAILED',
    )
  }
  // A model the route cannot resolve would fail every request that names it,
  // so it is dropped from the store rather than written to break resolution.
  const providerBaseUrl = catalogProvider(provider)?.baseUrl
  const models = collected.filter((entry) => {
    const base = installed.get(entry.id)
    if (base !== undefined && typeof base.baseUrl === 'string' && base.baseUrl.length > 0) return true
    if (providerBaseUrl !== undefined && providerBaseUrl.length > 0) return true
    return entry.api !== undefined && siblingBaseUrl(installed, entry.api) !== undefined
  })
  if (models.length === 0) {
    throw new LlmError(
      `none of the models ${sources.join(', ')} reported can be served on provider "${provider}";`
      + ' the installed catalog keeps serving',
      'DISCOVERY_FAILED',
    )
  }
  const file: CatalogCacheFile = {
    format: CATALOG_CACHE_FORMAT,
    fingerprint: catalogFingerprint(installed),
    fetchedAt: new Date().toISOString(),
    endpoints: sources,
    models,
  }
  await writeCatalogCache(options.dir, provider, file)
  return file
}

/**
 * The refreshed cache as a discovery reply: cached ids keep the installed
 * entry's metadata (a listing rarely discloses capacities), and upstream
 * additions carry whatever the listing disclosed plus their family's protocol.
 * @param file - the cache document a refresh just wrote.
 * @param installed - the route's installed catalog entries, indexed by id.
 * @returns the discovered models in cache order.
 */
export function discoveredFromCache(
  file: CatalogCacheFile,
  installed: ReadonlyMap<string, Model<Api>>,
): LlmDiscoveredModel[] {
  return file.models.map((entry) => {
    const base = installed.get(entry.id)
    const api = entry.api ?? base?.api
    return {
      id: entry.id,
      ...entry.name === undefined ? {} : { name: entry.name },
      ...base?.contextWindow === undefined ? {} : { contextWindow: base.contextWindow },
      ...base?.maxTokens === undefined ? {} : { maxTokens: base.maxTokens },
      ...api === undefined ? {} : { api },
    }
  })
}
