/**
 * Local catalog cache for pi-ai routes: the persisted copy of what a route's
 * own endpoints reported, kept current by sync and served in place of the
 * frozen pi-ai snapshot.
 *
 * The installed catalog is compiled into the pi-ai npm package and cannot move
 * under us; this file is the layer that can. A sync interrogates the route's
 * listable endpoints, refuses to store an empty or unusable answer, and writes
 * the reply here. Resolution then serves this list instead of the snapshot —
 * upstream additions appear, upstream retirements disappear — while a missing
 * or unreadable file falls back to the snapshot, which is what keeps a route
 * serviceable offline. The route stays an installed provider throughout:
 * nothing lands in `settings.yaml`, so no surface marks it customized.
 *
 * @module dsh-llm-pi-ai/catalog-cache
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import { supportedProtocols } from './provider.ts'

/** On-disk format of one cache file; a reader that does not know it treats the file as absent. */
export const CATALOG_CACHE_FORMAT = 1

/** One model a route's endpoint reported; `api` is the protocol of the listing that named it. */
export interface CatalogCacheModel {
  /** Model id the endpoint accepts. */
  id: string
  /** Wire protocol of the listing endpoint that reported the model. */
  api?: string
  /** Human-readable name when the listing disclosed one. */
  name?: string
}

/** The durable form of one provider's cached catalog. */
export interface CatalogCacheFile {
  format: typeof CATALOG_CACHE_FORMAT
  /** Digest of the frozen catalog at fetch time; a mismatch means pi-ai itself moved, so the cache is stale by construction. */
  fingerprint: string
  /** ISO timestamp of the successful sync that wrote the file. */
  fetchedAt: string
  /** Listing URLs consulted, for diagnostics. */
  endpoints: string[]
  models: CatalogCacheModel[]
}

/**
 * The "pi-ai version" of one route's frozen catalog: a digest over its
 * (id, api) pairs, so a pi-ai upgrade that changes the list invalidates every
 * cache cut against the older one.
 * @param installed - the route's installed catalog entries, indexed by id.
 * @returns the hex sha256 fingerprint.
 */
export function catalogFingerprint(installed: ReadonlyMap<string, Model<Api>>): string {
  const pairs = [...installed.values()]
    .map(model => [model.id, model.api])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex')
}

/**
 * Parse and validate one cache file at the durable boundary. The file is ours,
 * but it crosses a process and a restart, so an unreadable or malformed
 * document answers absence rather than a crash: the route falls back to its
 * installed catalog.
 * @param text - the file content.
 * @returns the validated document, or `undefined` when any field is unusable.
 */
export function parseCatalogCache(text: string): CatalogCacheFile | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const file = body as Record<string, unknown>
  if (file['format'] !== CATALOG_CACHE_FORMAT) return undefined
  if (typeof file['fingerprint'] !== 'string' || file['fingerprint'].length === 0) return undefined
  if (typeof file['fetchedAt'] !== 'string' || Number.isNaN(Date.parse(file['fetchedAt']))) return undefined
  const rawEndpoints = file['endpoints']
  if (!Array.isArray(rawEndpoints)) return undefined
  const endpoints: string[] = []
  for (const value of rawEndpoints) {
    if (typeof value !== 'string') return undefined
    endpoints.push(value)
  }
  const models = file['models']
  // An empty listing is meaningless (a sync refuses to store one), so a file
  // carrying none answers absence instead of serving a route with no models.
  if (!Array.isArray(models) || models.length === 0) return undefined
  const parsed: CatalogCacheModel[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const row = entry as Record<string, unknown>
    if (typeof row['id'] !== 'string' || row['id'].length === 0) return undefined
    if (row['api'] !== undefined && (typeof row['api'] !== 'string' || !supportedProtocols().includes(row['api']))) {
      return undefined
    }
    if (row['name'] !== undefined && (typeof row['name'] !== 'string' || row['name'].length === 0)) return undefined
    parsed.push({
      id: row['id'],
      ...row['api'] === undefined ? {} : { api: row['api'] },
      ...row['name'] === undefined ? {} : { name: row['name'] },
    })
  }
  return {
    format: CATALOG_CACHE_FORMAT,
    fingerprint: file['fingerprint'],
    fetchedAt: file['fetchedAt'],
    endpoints: [...endpoints],
    models: parsed,
  }
}

/** Serve-path memo keyed by cache directory and provider. */
const memo = new Map<string, { mtimeMs: number; models: readonly CatalogCacheModel[] | undefined }>()

function cachePath(dir: string, provider: string): string {
  return join(dir, `${provider}.json`)
}

function memoKey(dir: string, provider: string): string {
  return `${dir}\0${provider}`
}

/**
 * The cached catalog for the synchronous serve path, read with an mtime-keyed
 * memo so a refresh that lands on disk is picked up by the next resolution
 * without a restart, and a file that disappears or corrupts answers absence.
 * @param dir - the cache directory.
 * @param provider - provider route key.
 * @returns the cached models in listing order, or `undefined` to serve the installed catalog.
 */
export function cachedCatalogModels(dir: string, provider: string): readonly CatalogCacheModel[] | undefined {
  const key = memoKey(dir, provider)
  let stat: Stats
  try {
    stat = statSync(cachePath(dir, provider))
  } catch {
    memo.delete(key)
    return undefined
  }
  const hit = memo.get(key)
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs) return hit.models
  let models: readonly CatalogCacheModel[] | undefined
  try {
    models = parseCatalogCache(readFileSync(cachePath(dir, provider), 'utf8'))?.models
  } catch {
    models = undefined
  }
  memo.set(key, { mtimeMs: stat.mtimeMs, models })
  return models
}

/**
 * Read one cache file for a freshness check (fingerprint and timestamp).
 * @param dir - the cache directory.
 * @param provider - provider route key.
 * @returns the validated document, or `undefined` when absent or unusable.
 */
export async function readCatalogCache(dir: string, provider: string): Promise<CatalogCacheFile | undefined> {
  let text: string
  try {
    text = await readFile(cachePath(dir, provider), 'utf8')
  } catch {
    return undefined
  }
  return parseCatalogCache(text)
}

/**
 * Write one cache file atomically (temporary file plus rename, so a crash
 * never leaves a half-written listing behind) and publish it to the serve-path
 * memo.
 * @param dir - the cache directory, created when missing.
 * @param provider - provider route key.
 * @param file - the validated document to store.
 */
export async function writeCatalogCache(dir: string, provider: string, file: CatalogCacheFile): Promise<void> {
  const path = cachePath(dir, provider)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(file, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
  memo.set(memoKey(dir, provider), { mtimeMs: statSync(path).mtimeMs, models: file.models })
}

/** Drop the serve-path memo; test isolation between cases. */
export function resetCatalogCacheMemo(): void {
  memo.clear()
}
