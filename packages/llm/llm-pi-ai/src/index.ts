/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. Profile facts resolve per request
 * over the optional `llm-pi-ai` user-settings section and the optional
 * credential seam, so a changed key, endpoint, model, or knob reaches the next
 * request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       # Catalog route: everything but the credential comes from pi-ai.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # Catalog route with the catalog narrowed and one capacity corrected.
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # Hand-declared route: pi-ai ships nothing under this key.
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # Reasoning dialect for a URL pi-ai cannot recognize.
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = selectable level, value = wire spelling; only off may
 *             # leave the value empty (supported, send nothing).
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */
import type {} from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { Api, Model } from '@earendil-works/pi-ai'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { catalogModels, catalogProvider, catalogProviderIds } from './catalog.ts'
import { CATALOG_CACHE_FORMAT, catalogFingerprint, writeCatalogCache } from './catalog-cache.ts'
import type { CatalogCacheModel } from './catalog-cache.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels, fetchCatalogListing, isListableProtocol } from './discovery.ts'
import type { CatalogSyncEndpoint, StoredModelDiscoveryProfile } from './discovery.ts'
import { registerPiAiFlows } from './login.ts'
import { providerDefaultsOf } from './provider-data.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type {
  Options,
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export { recordKeyFor } from './auth.ts'
export { supportedProtocols } from './provider.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

const NS = 'llm-pi-ai'

/**
 * The default catalog cache root: `$DSH_HOME/llm-pi-ai/catalog-cache`, falling
 * back to `~/.dsh` when the environment does not name a home. `config.ts`
 * treats the directory as a serving concern, so this resolution happens in the
 * adapter, not the validator.
 * @param home - the harness home directory (`$DSH_HOME`), when one is named.
 */
export function defaultCatalogCacheDir(home?: string | undefined): string {
  return join(home ?? join(homedir(), '.dsh'), 'llm-pi-ai', 'catalog-cache')
}

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` rides along because the registry hands it to every selector
    // through `providerInfo()`: a rename that did not re-register would leave
    // the old label showing until some unrelated fact happened to change.
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The configurable-provider directory: every installed catalog route, plus
 * every route the current profiles declare. A hand-declared route has no
 * catalog entry, so without this union it would have no settings address and
 * configuration surfaces could neither show nor edit it. A catalog route also
 * carries its catalog endpoint and native authentication, which a settings
 * editor shows while the profile leaves the endpoint or the credential
 * reference unset.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  settingsNs: string,
): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (provider: string, displayName: string, error?: string): void => {
    const installed = catalogProvider(provider)
    entries.set(provider, {
      provider,
      displayName,
      settingsNs,
      settingsPath: ['providers', provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: installed === undefined,
      ...installed === undefined ? {} : providerDefaultsOf(installed),
      ...error === undefined ? {} : { error },
    })
  }
  for (const provider of catalogProviderIds()) declare(provider, provider)
  for (const [provider, profile] of profiles) declare(provider, profile.displayName, profile.catalogError)
  return [...entries.values()]
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  // The sync is opt-in (`catalogSyncEnabled` in the section — the settings
  // source same as the routes). Without it the route serves the frozen
  // snapshot, no provider endpoint is reached, and no cache file is read.
  // The flag and the directory are plain (non-volatile) configuration, so a
  // change reloads the plugin and these apply-time reads are always current.
  const cacheDir = (): string | undefined => {
    if (config.catalogSyncEnabled !== true) return undefined
    return config.catalogCacheDir ?? defaultCatalogCacheDir(launchEnvironmentOf(ctx).get('DSH_HOME')?.value)
  }
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's identity — which is also what makes the adapter's own snapshot
   * stable across operations that observe no change.
   *
   * Catalog diagnostics stay in the snapshot beside serviceable models, so
   * stored configuration remains visible after an installed catalog changes.
   * Scalar configuration errors still reject resolution.
   */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = config.providers.get()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(structuredClone(raw) as import('./config.ts').Options['providers'], 'deferred', cacheDir())
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as import('./config.ts').Options,
      { providers: structuredClone(config.providers.get()) } as import('./config.ts').Options,
    )
    return raw
  })

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  // One store and one ambient context for the whole plugin instance: both read
  // through `ctx` per call, so they stay correct across the collection rebuilds
  // a configuration change causes, and a sign-in survives one.
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }

  /**
   * The sync inputs one catalog route needs: its resolved profile, its frozen
   * snapshot, and the listable endpoints that snapshot names. `undefined` for a
   * route that does not take a cache — no profile, or a profile whose `models`
   * list (or per-model overrides) is the deployment's own answer, which the
   * cache must not override.
   */
  const catalogSyncInputs = (
    provider: string | undefined,
  ): {
    profile: ResolvedPiAiProviderProfile
    installed: ReadonlyMap<string, Model<Api>>
    endpoints: readonly CatalogSyncEndpoint[]
  } | undefined => {
    if (provider === undefined || cacheDir() === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    // The raw source carries `models`/`modelOverrides`; the schema
    // materializes `[]`/`{}` for the absent case, and resolution reads an
    // empty one as "no answer here" too — so the cache applies unless the
    // deployment actually spoke.
    const rawProfile = config.providers.get()?.[provider]
    if ((rawProfile?.models?.length ?? 0) > 0 || Object.keys(rawProfile?.modelOverrides ?? {}).length > 0) return undefined
    // Installed providers only: a hand-declared route already answers its
    // endpoint on every request, and the cache serves the frozen snapshot,
    // which is what this layer exists to displace.
    const installed = catalogModels(provider)
    if (installed.size === 0) return undefined
    // The route's effective endpoint, not the frozen catalog's: a profile may
    // point a catalog route at a proxy or self-hosted replica, and the sync
    // must ask the endpoint the route actually serves.
    const endpoints: CatalogSyncEndpoint[] = []
    for (const model of installed.values()) {
      const api = rawProfile?.api ?? model.api
      const baseURL = rawProfile?.baseURL ?? model.baseUrl
      if (api === undefined || baseURL === undefined || !isListableProtocol(api)) continue
      if (endpoints.some(endpoint => endpoint.api === api && endpoint.baseURL === baseURL)) continue
      endpoints.push({ api, baseURL })
    }
    if (endpoints.length === 0) return undefined
    return { profile, installed, endpoints }
  }

  /**
   * Interrogate one route's endpoints, store the union in the catalog cache,
   * and answer the merged listing. `undefined` means no endpoint answered a
   * usable listing. A credential miss is downgraded to unauthenticated here:
   * the catalog is fetched for the surface, and the route's own requests still
   * fail loud exactly where they always did.
   */
  const fetchCatalog = async (
    provider: string,
    dir: string,
    inputs: { profile: ResolvedPiAiProviderProfile; installed: ReadonlyMap<string, Model<Api>>; endpoints: readonly CatalogSyncEndpoint[] },
    signal?: AbortSignal,
  ): Promise<readonly CatalogCacheModel[] | undefined> => {
    const listed = await fetchCatalogListing({
      provider,
      endpoints: inputs.endpoints,
      fingerprint: catalogFingerprint(inputs.installed),
      headers: inputs.profile.headers,
      resolveApiKey: async () => {
        try {
          return await resolveApiKey(provider, inputs.profile)
        } catch {
          return undefined
        }
      },
      signal,
      onEndpointFailure: (url, reason) => {
        ctx.logger.warn(`llm-pi-ai: catalog sync for "${provider}" could not read ${url}: ${reason}`)
      },
    })
    if (listed === undefined) return undefined
    await writeCatalogCache(dir, provider, {
      format: CATALOG_CACHE_FORMAT,
      fingerprint: catalogFingerprint(inputs.installed),
      fetchedAt: new Date().toISOString(),
      endpoints: listed.endpoints,
      models: listed.models,
    })
    // The serve path memoizes profiles against the raw section; a cache that
    // just landed must be visible to the next operation without a settings
    // edit, so drop the memo rather than waiting for one.
    lastRaw = undefined
    memoized = undefined
    return listed.models
  }

  /**
   * One route's lasting answer to "which models can this provider serve?" —
   * the forced check at every startup (here: once per route until the process
   * ends, when the route first appears). Fire-and-forget by design: a route
   * stays serviceable whether the sync answers or not, so the failure surface
   * is a diagnostic, never a failed mount.
   */
  const syncedRoutes = new Set<string>()
  const syncCatalogRoute = (provider: string): void => {
    if (syncedRoutes.has(provider)) return
    syncedRoutes.add(provider)
    const dir = cacheDir()
    if (dir === undefined) return
    const inputs = catalogSyncInputs(provider)
    if (inputs === undefined) return
    void (async () => {
      try {
        const models = await fetchCatalog(provider, dir, inputs)
        if (models === undefined) {
          ctx.logger.warn(`llm-pi-ai: startup catalog sync for "${provider}" received no usable listing; keeping the previous catalog`)
        }
      } catch (error) {
        // Fetch can also reject with a generic failure (bad proxy, TLS); the
        // previous catalog keeps serving either way.
        ctx.logger.warn(
          `llm-pi-ai: startup catalog sync for "${provider}" failed; keeping the previous catalog:`,
          error instanceof Error ? error.message : String(error),
        )
      }
    })()
  }

  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
  // Independent of the route set: signing in is what makes a route worth
  // adding, so the flows are offered before any profile names their provider.
  // Scoped to the authorization seam rather than injected outright, because a
  // composition without it (headless, ACP) simply has no surface to sign in
  // from, while everything else this plugin does still works.
  ctx.inject(['authorization'], (authorized) => { registerPiAiFlows(authorized, auth) })
  // The full installed catalog is configurable from the moment the plugin
  // mounts — dormant or not — so configuration surfaces can offer every
  // pi-ai provider before any route exists. Hand-declared routes join it as
  // profiles appear, and leave with them.
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(profiles(), settingsNs)
    if (deepEqualJson(entries, directoryFacts)) return
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares (a profile keyed `deepseek-official`) would
    // otherwise leave this plugin's whole directory withdrawn and the Models
    // page empty. The candidate set is validated first, so a collision keeps
    // the previous entries serving and only costs a diagnostic.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()
  /** Host-owned request inputs for discovery of one configured route. */
  const storedDiscoveryProfile = (
    provider: string | undefined,
  ): StoredModelDiscoveryProfile | undefined => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return {
      headers: profile.headers,
      resolveApiKey: () => resolveApiKey(provider, profile),
    }
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet. The draft is the whole request
  // except the stored credential and deployment-owned headers: the curated UI
  // accepts neither, so an already-configured route supplies both inside the
  // Host rather than widening the discovery request. A catalog route's fetch
  // doubles as the cache refresh: it interrogates the route's own endpoints,
  // stores the answer, and surfaces it — the action that shows an upstream
  // addition without waiting for a restart.
  ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    const refresh = catalogSyncInputs(request.provider)
    if (refresh !== undefined) {
      const dir = cacheDir()
      if (dir !== undefined) {
        try {
          const cached = await fetchCatalog(request.provider ?? '', dir, refresh, signal)
          if (cached !== undefined) {
            return cached.map(model => ({
              id: model.id,
              name: model.name ?? model.id,
              ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
              ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
            }))
          }
        } catch (error) {
          // A refused sync surfaces as the fetch failure the surface already
          // renders, rather than silently echoing the stale installed list.
          if (error instanceof LlmError && error.code === 'ABORTED') throw error
          throw new LlmError(`could not refresh the catalog for "${request.provider}": ${error instanceof Error ? error.message : String(error)}`, 'DISCOVERY_FAILED')
        }
      }
    }
    return discoverModels(
      { ...request, ...signal === undefined ? {} : { signal } },
      () => storedDiscoveryProfile(request.provider),
    )
  })
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration, so a change to either must re-register. The swap is
    // atomic (same adapter instance, validated before anything moves): a
    // conflicting route leaves the previous routes serving requests, and
    // `registeredFacts` only advances once the registry actually holds the
    // new set — so returning to a working configuration always re-applies.
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
    // The startup sync hook: a route first appearing (at mount or when a
    // settings section names it) gets its forced endpoint check exactly once.
    // Runs concurrently; the route keeps whatever catalog it already had while
    // the sync is in flight or failing.
    for (const provider of routes) syncCatalogRoute(provider)
  }
  ensureRegistrationFacts()

  ctx.on('loader/volatile-update', () => {
    try { ensureRegistrationFacts(); ensureDirectory() }
    catch (error) {
      ctx.logger.error('llm-pi-ai: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  })
}
