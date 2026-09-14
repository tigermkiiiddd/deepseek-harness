import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  catalogFingerprint,
  CATALOG_CACHE_FORMAT,
  cachedCatalogModels,
  parseCatalogCache,
  readCatalogCache,
  resetCatalogCacheMemo,
  writeCatalogCache,
} from '../src/catalog-cache.ts'

const dirs: string[] = []

async function cacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-cache-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  resetCatalogCacheMemo()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function file(): Parameters<typeof writeCatalogCache>[2] {
  return {
    format: CATALOG_CACHE_FORMAT,
    fingerprint: 'a'.repeat(64),
    fetchedAt: new Date(0).toISOString(),
    endpoints: ['https://gateway.example/v1/models'],
    models: [{ id: 'alpha' }, { id: 'beta', api: 'openai-completions', name: 'Beta' }],
  }
}

describe('catalog cache file format', () => {
  it('parses a minimal document and keeps listed api, name, and capacities optional', () => {
    const parsed = parseCatalogCache(JSON.stringify(file()))
    expect(parsed).toEqual({
      format: 1,
      fingerprint: 'a'.repeat(64),
      fetchedAt: new Date(0).toISOString(),
      endpoints: ['https://gateway.example/v1/models'],
      models: [
        { id: 'alpha' },
        { id: 'beta', api: 'openai-completions', name: 'Beta' },
      ],
    })
  })

  it('keeps capacities when the endpoint disclosed them', () => {
    const doc = file()
    doc.models = [
      { id: 'big', contextWindow: 262144, maxTokens: 8192 },
    ]
    expect(parseCatalogCache(JSON.stringify(doc))?.models).toEqual([{
      id: 'big',
      contextWindow: 262144,
      maxTokens: 8192,
    }])
  })

  it('answers absence for a malformed document instead of crashing', () => {
    expect(parseCatalogCache('{')).toBeUndefined()
    expect(parseCatalogCache('[]')).toBeUndefined()
    expect(parseCatalogCache('null')).toBeUndefined()
    expect(parseCatalogCache(JSON.stringify({ ...file(), models: [] }))).toBeUndefined()
  })

  it('refuses a document with the wrong format or a plumbed model protocol', () => {
    expect(parseCatalogCache(JSON.stringify({ ...file(), format: 2 }))).toBeUndefined()
    expect(parseCatalogCache(JSON.stringify({ ...file(), models: [{ id: 'x', api: 'not-a-protocol' }] }))).toBeUndefined()
  })

  it('refuses non-string ids, empty names, and unusable capacities', () => {
    expect(parseCatalogCache(JSON.stringify({ ...file(), models: [{ id: '' }] }))).toBeUndefined()
    expect(parseCatalogCache(JSON.stringify({ ...file(), models: [{ id: 'x', name: '' }] }))).toBeUndefined()
    expect(parseCatalogCache(JSON.stringify({ ...file(), models: [{ id: 'x', contextWindow: 0 }] }))).toBeUndefined()
    expect(parseCatalogCache(JSON.stringify({ ...file(), models: [{ id: 'x', maxTokens: 12.5 }] }))).toBeUndefined()
  })
})

describe('catalog fingerprint', () => {
  it('is stable and insensitive to insertion order', () => {
    const a = () => new Map([['alpha', { id: 'alpha', api: 'openai-completions' }], ['beta', { id: 'beta', api: 'openai-completions' }]])
    const b = () => new Map([['beta', { id: 'beta', api: 'openai-completions' }], ['alpha', { id: 'alpha', api: 'openai-completions' }]])
    expect(catalogFingerprint(a() as never)).toBe(catalogFingerprint(b() as never))
  })

  it('changes when the installed list changes', () => {
    const a = () => new Map([['alpha', { id: 'alpha', api: 'openai-completions' }]])
    const b = () => new Map([['alpha', { id: 'alpha', api: 'anthropic-messages' }]])
    expect(catalogFingerprint(a() as never)).not.toBe(catalogFingerprint(b() as never))
  })
})

describe('cache serve path', () => {
  it('answers absence for a missing file', async () => {
    const dir = await cacheDir()
    expect(cachedCatalogModels(dir, 'absent')).toBeUndefined()
  })

  it('serves what writeCatalogCache stored, and picks up a rewrite by mtime', async () => {
    const dir = await cacheDir()
    expect(await readCatalogCache(dir, 'deepseek')).toBeUndefined()
    await writeCatalogCache(dir, 'deepseek', file())
    expect(await readCatalogCache(dir, 'deepseek')).toEqual(file())
    expect(cachedCatalogModels(dir, 'deepseek')?.map(model => model.id)).toEqual(['alpha', 'beta'])

    const updated = file()
    updated.models = [{ id: 'gamma' }]
    await writeCatalogCache(dir, 'deepseek', updated)
    expect(cachedCatalogModels(dir, 'deepseek')?.map(model => model.id)).toEqual(['gamma'])
  })

  it('treats a corrupt file as absence and forgets it when it disappears', async () => {
    const dir = await cacheDir()
    const path = join(dir, 'corrupt.json')
    await writeFile(path, '{not json', 'utf8')
    expect(cachedCatalogModels(dir, 'corrupt')).toBeUndefined()

    const missing = join(dir, 'gone.json')
    await writeFile(missing, JSON.stringify(file()), 'utf8')
    expect(cachedCatalogModels(dir, 'gone')).not.toBeUndefined()
    await rm(missing)
    expect(cachedCatalogModels(dir, 'gone')).toBeUndefined()
  })

  it('writes atomically and creates the directory', async () => {
    const dir = await cacheDir()
    const nested = join(dir, 'sub', 'nested')
    const doc = file()
    await writeCatalogCache(nested, 'opencode-go', doc)
    expect(JSON.parse(await readFile(join(nested, 'opencode-go.json'), 'utf8'))).toEqual(doc)
    expect(cachedCatalogModels(nested, 'opencode-go')?.map(model => model.id)).toEqual(['alpha', 'beta'])
  })
})
