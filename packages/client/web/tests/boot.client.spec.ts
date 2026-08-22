// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, DshWindow,
  WebBootEntry,
} from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry, type BootSeams } from '../src/boot.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const win = globalThis as DshWindow
const moduleFace = modulesClient as unknown as Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  document.body.innerHTML = ''
  sessionStorage.clear()
})

/** Install the stable facade shape that the Host injects before AppWebEntry runs. */
function installFacade(
  create?: (options: ClientModuleCreateOptions) => modulesClient.ClientModuleSystem,
): ClientModuleLoaderTarget {
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: create ?? (options => modulesClient.createClientModuleSystem(target, {
      id: MODULES_ID,
      exports: moduleFace,
    }, options)),
  }
  win.__ModuleLoader__ = target
  return target
}

async function expectBootFailure(setup: () => void, message: string): Promise<void> {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = document.createElement('div')
  document.body.append(container)
  setup()
  const entry = new AppWebEntry(container)
  await entry.run()
  expect(container.textContent).toContain(message)
  expect(error).toHaveBeenCalledOnce()
  await entry.dispose()
}

describe('bootstrap failure rendering', () => {
  it('renders a missing bootstrap facade', async () => {
    await expectBootFailure(
      () => { delete win.__ModuleLoader__ },
      'window.__ModuleLoader__ bootstrap facade is missing',
    )
  })

  it('renders a create failure owned by the facade', async () => {
    await expectBootFailure(() => {
      installFacade(() => { throw new Error('facade create failed') })
    }, 'facade create failed')
  })

  it('renders a malformed boot manifest', async () => {
    await expectBootFailure(() => {
      installFacade()
      delete win.__DSH_BOOT__
    }, 'window.__DSH_BOOT__ is missing or not an object')
  })

  it('renders a module-system construction failure', async () => {
    await expectBootFailure(() => {
      installFacade()
      const duplicate = { id: 'duplicate', url: '/duplicate/client.js', rev: '1' }
      win.__DSH_BOOT__ = { rev: 'graph', entries: [duplicate, duplicate] }
    }, 'duplicate graph entry "duplicate"')
  })
})

describe('plugin activation', () => {
  it('allows a modules-dependent row to be created before the modules row', async () => {
    const events: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'consumer', url: '/consumer.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = { rev: 'graph', entries }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/consumer.js', {
        id: 'consumer',
        factory: () => ({
          inject: ['modules'],
          apply: (ctx: Context) => {
            expect(ctx.modules).toBeDefined()
            events.push('consumer')
          },
        }),
      }],
      ['/renderer.js', {
        id: 'renderer',
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                events.push('mount')
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        const registration = registrations.get(url)
        if (registration === undefined) throw new Error(`missing fixture registration ${url}`)
        target.load(registration)
      },
    })

    await entry.run()

    expect(target.mode).toBe('live')
    expect(events).toEqual(['consumer', 'mount'])
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })
})

describe('boot-failure recovery', () => {
  /** Boot that fails after the module system exists (missing manifest graph). */
  async function runFailedBoot(seams?: BootSeams): Promise<AppWebEntry> {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    installFacade()
    win.__DSH_BOOT__ = { rev: 'graph', entries: [{ id: 'duplicate', url: '/duplicate.js', rev: '1' }, { id: 'duplicate', url: '/duplicate.js', rev: '1' }] }
    const entry = new AppWebEntry(container, seams)
    await entry.run()
    expect(container.textContent).toContain('Failed to load plugins')
    expect(error).toHaveBeenCalledOnce()
    return entry
  }

  it('reloads the page after consecutive healthy index probes', async () => {
    vi.useFakeTimers()
    try {
      const reload = vi.fn()
      const fetchMock = vi.fn(async () => ({ ok: true }) as Response)
      vi.stubGlobal('fetch', fetchMock)
      sessionStorage.clear()
      const entry = await runFailedBoot({ reloadPage: reload })

      await vi.advanceTimersByTimeAsync(2 * 3_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(reload).toHaveBeenCalledOnce()
      expect(JSON.parse(sessionStorage.getItem('dsh-boot-recovery-reloads') ?? '{}').reloads).toHaveLength(1)

      await entry.dispose()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('keeps polling while the index is unreachable and reloads once it recovers', async () => {
    vi.useFakeTimers()
    try {
      const reload = vi.fn()
      let healthy = false
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: healthy }) as Response))
      sessionStorage.clear()
      const entry = await runFailedBoot({ reloadPage: reload })

      await vi.advanceTimersByTimeAsync(6 * 3_000)
      expect(reload).not.toHaveBeenCalled()

      healthy = true
      await vi.advanceTimersByTimeAsync(2 * 3_000)
      expect(reload).toHaveBeenCalledOnce()

      await entry.dispose()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('stops polling once the reload budget is exhausted', async () => {
    vi.useFakeTimers()
    try {
      const reload = vi.fn()
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response))
      sessionStorage.setItem('dsh-boot-recovery-reloads', JSON.stringify({
        reloads: [Date.now(), Date.now(), Date.now()],
      }))
      const entry = await runFailedBoot({ reloadPage: reload })

      await vi.advanceTimersByTimeAsync(5 * 3_000)
      expect(reload).not.toHaveBeenCalled()

      await entry.dispose()
    } finally {
      vi.unstubAllGlobals()
      sessionStorage.clear()
      vi.useRealTimers()
    }
  })
})
