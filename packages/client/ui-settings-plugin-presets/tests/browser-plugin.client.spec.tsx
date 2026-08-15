// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { PresetPluginsTab } from '../src/client/PresetPluginsTab.tsx'
import type { PresetPluginsTabInjected } from '../src/client/PresetPluginsTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const EMPTY_LIST = { presets: [], authorable: false, hasDocument: false }
const EMPTY_ENTRIES = { agentPreset: 'x', trust: 'system' as const, entries: [] }

type RpcResult<T> = { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }

function ok<T>(value: T): RpcResult<T> {
  return { result: { ok: true, value } }
}

function rpcErr(code: string, message: string): RpcResult<never> {
  return { result: { ok: false, error: { code, message } } }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const list = vi.fn(async (): Promise<RpcResult<typeof EMPTY_LIST>> => ok(EMPTY_LIST))
  const readEntries = vi.fn(async (): Promise<RpcResult<typeof EMPTY_ENTRIES>> => ok(EMPTY_ENTRIES))
  ctx.provide('connection', {
    api: {
      agentPresets: { list, readEntries },
    },
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, readEntries }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugin-presets browser plugin', () => {
  it('declares only the services used by the Settings API contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('registers a localized tab without reading the API eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(PresetPluginsTab)
    expect(entry.options).toMatchObject({ id: 'by-preset', order: 5 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('按预设')
    expect(b.list).not.toHaveBeenCalled()
    expect(b.readEntries).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => PresetPluginsTabInjected)()
    await expect(injected.list()).resolves.toEqual(EMPTY_LIST)
    expect(b.list).toHaveBeenCalledOnce()
    await expect(injected.readEntries('x')).resolves.toEqual(EMPTY_ENTRIES)
    expect(b.readEntries).toHaveBeenCalledOnce()

    b.list.mockResolvedValueOnce(rpcErr('REMOTE_ERROR', 'unavailable'))
    await expect(injected.list()).rejects.toThrow('agentPresets.list failed: REMOTE_ERROR: unavailable')
    b.list.mockResolvedValueOnce(ok(EMPTY_LIST))
    b.readEntries.mockResolvedValueOnce(rpcErr('REMOTE_ERROR', 'unavailable'))
    await expect(injected.readEntries('y')).rejects.toThrow('agentPresets.readEntries failed: REMOTE_ERROR: unavailable')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('By preset')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(PresetPluginsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
