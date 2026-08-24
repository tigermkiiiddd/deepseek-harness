import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import {
  CATALOG_CACHE_FORMAT,
  cachedCatalogModels,
  catalogFingerprint,
  parseCatalogCache,
  readCatalogCache,
  resetCatalogCacheMemo,
  writeCatalogCache,
} from '../src/catalog-cache.ts'

const homes: string[] = []

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-cache-file-'))
  homes.push(dir)
  return dir
}

afterEach(async () => {
  resetCatalogCacheMemo()
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One installed entry for fingerprinting; `as Model<Api>` keeps the test out of pi-ai's full shape. */
function entry(id: string, api: string = 'openai-completions'): Model<Api> {
  return { id, api } as Model<Api>
}

describe('catalogFingerprint', () => {
  it('is stable across insertion order and changes with the catalog', () => {
    const first = new Map([['a', entry('a')], ['b', entry('b', 'openai-responses')]])
    const reordered = new Map([['b', entry('b', 'openai-responses')], ['a', entry('a')]])
    expect(catalogFingerprint(first)).toBe(catalogFingerprint(reordered))
    // A pi-ai upgrade that moves the list or a protocol invalidates the cache.
    expect(catalogFingerprint(first)).not.toBe(catalogFingerprint(new Map([['a', entry('a')], ['c', entry('c')]])))
    expect(catalogFingerprint(first)).not.toBe(catalogFingerprint(new Map([['a', entry('a', 'openai-responses')], ['b', entry('b', 'openai-responses')]])))
  })
})

describe('parseCatalogCache', () => {
  const valid = (): Record<string, unknown> => ({
    format: CATALOG_CACHE_FORMAT,
    fingerprint: 'f'.repeat(64),
    fetchedAt: '2026-08-24T00:00:00.000Z',
    endpoints: ['https://api.example/models'],
    models: [
      { id: 'a' },
      { id: 'b', api: 'openai-completions', name: 'B' },
    ],
  })

  it('round-trips a valid document, keeping optional fields out when absent', () => {
    const parsed = parseCatalogCache(JSON.stringify(valid()))
    expect(parsed).toEqual({
      format: CATALOG_CACHE_FORMAT,
      fingerprint: 'f'.repeat(64),
      fetchedAt: '2026-08-24T00:00:00.000Z',
      endpoints: ['https://api.example/models'],
      models: [{ id: 'a' }, { id: 'b', api: 'openai-completions', name: 'B' }],
    })
  })

  it('answers absence for every malformed document', () => {
    expect(parseCatalogCache('not json')).toBeUndefined()
    const cases: Record<string, unknown>[] = [
      { ...valid(), format: CATALOG_CACHE_FORMAT + 1 },
      { ...valid(), fingerprint: '' },
      { ...valid(), fetchedAt: 'not a date' },
      { ...valid(), endpoints: 'https://api.example/models' },
      { ...valid(), endpoints: ['ok', 7] },
      { ...valid(), models: [] },
      { ...valid(), models: [{ id: '' }] },
      { ...valid(), models: [{ id: 'a', api: 'carrier-pigeon' }] },
      { ...valid(), models: [{ id: 'a', name: '' }] },
    ]
    for (const file of cases) expect(parseCatalogCache(JSON.stringify(file))).toBeUndefined()
  })
})

describe('serve-path read and memo', () => {
  it('answers absence without a file, the listing after a write, and absence again when it disappears', async () => {
    const dir = await home()
    expect(cachedCatalogModels(dir, 'deepseek')).toBeUndefined()

    await writeCatalogCache(dir, 'deepseek', {
      format: CATALOG_CACHE_FORMAT,
      fingerprint: catalogFingerprint(new Map([['a', entry('a')]])),
      fetchedAt: new Date().toISOString(),
      endpoints: ['https://api.deepseek.com/models'],
      models: [{ id: 'a', api: 'openai-completions' }, { id: 'b' }],
    })

    expect(cachedCatalogModels(dir, 'deepseek')).toEqual([{ id: 'a', api: 'openai-completions' }, { id: 'b' }])

    // A corrupt file is a serve-path absence too: the route falls back to its
    // installed catalog rather than failing resolution.
    await writeFile(join(dir, 'deepseek.json'), '{broken', 'utf8')
    expect(cachedCatalogModels(dir, 'deepseek')).toBeUndefined()
  })

  it('serves the memo for an unchanged file and picks up a rewrite without a restart', async () => {
    const dir = await home()
    const path = join(dir, 'deepseek.json')
    const document = (id: string) => ({
      format: CATALOG_CACHE_FORMAT,
      fingerprint: 'f'.repeat(64),
      fetchedAt: new Date().toISOString(),
      endpoints: ['https://api.deepseek.com/models'],
      models: [{ id }],
    })
    await writeCatalogCache(dir, 'deepseek', document('v1'))
    const firstMtimeMs = statSync(path).mtimeMs

    // A second read of the unchanged file is served from the mtime-keyed memo
    // — the serve path must not re-parse on every resolution.
    expect(cachedCatalogModels(dir, 'deepseek')).toEqual([{ id: 'v1' }])
    expect(cachedCatalogModels(dir, 'deepseek')).toEqual([{ id: 'v1' }])

    // A refresh that lands with a newer mtime is picked up without a restart.
    await writeFile(path, JSON.stringify(document('v2')), 'utf8')
    if (statSync(path).mtimeMs <= firstMtimeMs) {
      // The filesystem's clock granularity swallowed the same-instant rewrite;
      // nudge it so the case still proves a newer file wins.
      utimesSync(path, new Date(firstMtimeMs + 1000), new Date(firstMtimeMs + 1000))
    }
    expect(cachedCatalogModels(dir, 'deepseek')).toEqual([{ id: 'v2' }])
  })
})

describe('writeCatalogCache', () => {
  it('creates the directory, leaves no temporary file behind, and stores a readable document', async () => {
    const dir = join(await home(), 'nested', 'catalog-cache')
    const file = {
      format: CATALOG_CACHE_FORMAT,
      fingerprint: 'f'.repeat(64),
      fetchedAt: new Date().toISOString(),
      endpoints: ['https://api.deepseek.com/models'],
      models: [{ id: 'a' }],
    }
    await writeCatalogCache(dir, 'deepseek', file)

    const names = await readdir(dir)
    expect(names).toEqual(['deepseek.json'])
    expect(parseCatalogCache(await readFile(join(dir, 'deepseek.json'), 'utf8'))).toEqual(file)
  })

  it('reads back through the async freshness path', async () => {
    const dir = await home()
    const file = {
      format: CATALOG_CACHE_FORMAT,
      fingerprint: catalogFingerprint(new Map(getBuiltinModels('deepseek').map(model => [model.id, model]))),
      fetchedAt: new Date().toISOString(),
      endpoints: ['https://api.deepseek.com/models'],
      models: [{ id: 'a' }],
    }
    await writeCatalogCache(dir, 'deepseek', file)

    expect(await readCatalogCache(dir, 'deepseek')).toEqual(file)
    expect(await readCatalogCache(dir, 'no-such-route')).toBeUndefined()
  })
})
