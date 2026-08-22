/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type {
  BootManifest, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BootPage } from './boot-page.ts'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS } from './loader-status.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'> & {
  /**
   * Page reload invoked by boot-failure recovery (jsdom tests replace it);
   * defaults to `location.reload()`.
   */
  reloadPage?: () => void
}

/** Recovery poll cadence and consecutive healthy probes required before reload. */
const RECOVERY_POLL_MS = 3_000
const RECOVERY_HEALTHY_PROBES = 2
/** Reload budget per rolling window: a persistently failing boot must stop
 * reloading and leave the failure report visible for diagnosis. */
const RECOVERY_RELOAD_BUDGET = 3
const RECOVERY_BUDGET_WINDOW_MS = 10 * 60_000
const RECOVERY_BUDGET_KEY = 'dsh-boot-recovery-reloads'

/** Count past reloads inside the rolling window (0 when storage is unavailable). */
function recoveryReloadCount(now: number): number {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(RECOVERY_BUDGET_KEY)
  } catch {
    // Locked storage (privacy mode): treat as no prior reloads; the page still
    // recovers, only without cross-reload budget memory.
    return 0
  }
  if (raw === null) return 0
  const record = JSON.parse(raw) as { reloads: number[] }
  return record.reloads.filter(at => now - at < RECOVERY_BUDGET_WINDOW_MS).length
}

/** Record one reload in the rolling budget window. */
function recordRecoveryReload(now: number): void {
  try {
    const raw = sessionStorage.getItem(RECOVERY_BUDGET_KEY)
    const reloads = [...(raw === null ? [] : (JSON.parse(raw) as { reloads: number[] }).reloads), now]
    sessionStorage.setItem(
      RECOVERY_BUDGET_KEY,
      JSON.stringify({ reloads: reloads.filter(at => now - at < RECOVERY_BUDGET_WINDOW_MS).slice(-RECOVERY_RELOAD_BUDGET) }),
    )
  } catch {
    // Locked storage: budget memory is best-effort only.
  }
}

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest
  private disposed = false

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport and reload replacements.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Plugin failures remain visible on the boot page.
   * @returns Resolves after application mount or failure rendering.
   */
  async run(): Promise<void> {
    try {
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...this.seams,
      })
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      await this.runPluginBoot(ctx, prefetching)
      await this.mountApp(ctx)
    } catch (reason) {
      console.error(reason)
      this.page.fail(reason instanceof Error ? reason.message : String(reason))
      this.scheduleRecoveryReload()
    }
  }

  /**
   * Reload the page once the origin serves a healthy index again. A boot that
   * failed against a dead or mid-restart host leaves a wedged page — the
   * connection layer resumes, but plugin boot never re-runs, so the tab stays
   * on the failure report until a manual refresh. Recovery polls the index
   * (no-store) and reloads after consecutive healthy probes; the rolling
   * sessionStorage budget stops a persistently failing boot from reloading
   * forever. No-op when the budget is exhausted or after {@link dispose}.
   */
  private scheduleRecoveryReload(): void {
    const reload = this.seams?.reloadPage ?? (() => { location.reload() })
    if (recoveryReloadCount(Date.now()) >= RECOVERY_RELOAD_BUDGET) return
    let healthy = 0
    const poll = (): void => {
      if (this.disposed) return
      void fetch(location.href, { cache: 'no-store' })
        .then((response) => {
          healthy = response.ok ? healthy + 1 : 0
        })
        .catch(() => {
          healthy = 0
        })
        .finally(() => {
          if (this.disposed) return
          if (healthy >= RECOVERY_HEALTHY_PROBES) {
            recordRecoveryReload(Date.now())
            reload()
            return
          }
          if (recoveryReloadCount(Date.now()) < RECOVERY_RELOAD_BUDGET) {
            setTimeout(poll, RECOVERY_POLL_MS)
          }
        })
    }
    setTimeout(poll, RECOVERY_POLL_MS)
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    this.disposed = true
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
  }

  /** Mount through a dependency fiber so replacing uiRenderer remounts the application. */
  private async mountApp(ctx: Context): Promise<void> {
    const mounted = ctx.inject(['uiRenderer'], (scope) => {
      scope.effect(() => scope.uiRenderer.mount(this.container), 'web boot: application mount')
    })
    await mounted
  }

  /** Prefetch stage-one bundles; their import path owns any eventual failure. */
  private async prefetchImmediateTier(): Promise<void> {
    // A transport carrying loadBundle owns the bundle bytes; HTTP prefetch
    // against its static deployment answers nothing. A transport without
    // loadBundle leaves bundles on HTTP, prefetch included.
    const transport = (globalThis as {
      __DSH_TRANSPORT__?: { loadBundle?: unknown }
    }).__DSH_TRANSPORT__
    if (transport?.loadBundle !== undefined) return
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }

  /** Mount the Loader, create all graph entries, await quiescence, and audit activation. */
  private async runPluginBoot(ctx: Context, prefetching: Promise<void>): Promise<void> {
    await ctx.plugin(Loader)
    const loader = ctx.loader
    loader.internal = this.modules as never

    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    const rows = this.manifest.plugins.map(row => row.id)
    this.page.setTotal(rows.length)
    await prefetching
    await Promise.all(rows.map(async (name) => {
      this.page.setState(name, 'loading')
      const id = await loader.create({ name })
      if (loader.resolve(id).fiber === undefined) this.page.setState(name, 'failed')
    }))

    await loader.await()
    this.assertEntriesActive(ctx)
  }

  /** Reject entries that failed import/apply or still wait on missing services. */
  private assertEntriesActive(ctx: Context): void {
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      const name = entry.options.name
      if (entry.fiber === undefined) {
        failures.push(`${name}: import failed (see console for the import error)`)
        continue
      }
      const state = STATE_LABELS[entry.fiber.state]
      if (state === 'active') continue
      if (state === 'pending') {
        const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }
}
