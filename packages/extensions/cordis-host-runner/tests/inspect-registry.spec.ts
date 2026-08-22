import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { HostCordisInspectProviderRegistration } from '../src/index.ts'
import { CordisInspectRegistryService } from '../src/index.ts'

/**
 * The inspect registry's Host registration lifecycle: one provider per id,
 * where a newer registration replaces an older one instead of rejecting it.
 *
 * The registrant is a preset row, and a preset's standing mount is
 * generational — an edited composition file mounts a new generation while the
 * superseded one keeps its registration until whole-tree teardown — so
 * replacement is the supported path, and the superseded disposer must stay
 * inert so the old generation's teardown cannot unregister its successor.
 */

/** Minimal provider answering every method with a fixed value. */
function provider(id: string, marker: string): HostCordisInspectProviderRegistration {
  return {
    manifest: { id, description: `${marker} description`, methods: [] },
    async query() {
      return { marker } as unknown as Awaited<ReturnType<HostCordisInspectProviderRegistration['query']>>
    },
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

async function registry(): Promise<CordisInspectRegistryService> {
  const ctx = new Context()
  contexts.push(ctx)
  return new CordisInspectRegistryService(ctx)
}

describe('Host inspect registration', () => {
  it('lists a registered provider until its disposer runs', async () => {
    const cordisInspect = await registry()
    const dispose = cordisInspect.register(provider('Service', 'first'))
    expect(cordisInspect.list().map(view => view.id)).toEqual(['Service'])
    dispose()
    expect(cordisInspect.list()).toEqual([])
  })

  it('replaces an earlier provider under the same id and keeps the superseded disposer inert', async () => {
    const cordisInspect = await registry()
    const first = cordisInspect.register(provider('Service', 'first'))
    const second = cordisInspect.register(provider('Service', 'second'))
    expect(cordisInspect.list().map(view => view.id)).toEqual(['Service'])

    // The superseded generation's teardown must not unregister its successor.
    first()
    expect(cordisInspect.list().map(view => view.id)).toEqual(['Service'])

    second()
    expect(cordisInspect.list()).toEqual([])
  })
})
