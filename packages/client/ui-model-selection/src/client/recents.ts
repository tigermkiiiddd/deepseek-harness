/**
 * Deployment-local recent model selections behind the selection menu's
 * quick-switch section. Browser UI state with localStorage persistence: the
 * Host owns no recent-selections fact, and a menu affordance that must
 * survive reloads but never gates routing belongs to the browser.
 * @module ui-model-selection/recents
 */

import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'

/** Recent selections kept and shown; older ones age out of the section. */
export const MODEL_RECENT_LIMIT = 5

const STORAGE_KEY = 'dsh.modelRecents'

/** One stored recent pick, provider route and model id only. */
export interface ModelRecent {
  provider: string
  model: string
}

/** The browser storage, or undefined outside a browser (node test/boot lanes). */
function storage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

/** The stored recency-ordered picks; unreadable or malformed state reads as none. */
function read(): ModelRecent[] {
  const store = storage()
  if (store === undefined) return []
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is ModelRecent =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as ModelRecent).provider === 'string' && (entry as ModelRecent).provider.length > 0
      && typeof (entry as ModelRecent).model === 'string' && (entry as ModelRecent).model.length > 0)
  } catch (error) {
    // A broken record must not take the menu down: it reads as no recents.
    console.error('model recents rehydration failed:', error)
    return []
  }
}

function write(entries: readonly ModelRecent[]): void {
  const store = storage()
  if (store === undefined) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch (error) {
    // Quota or private mode disables the section's persistence, not the menu.
    console.error('model recents persistence failed:', error)
  }
}

/**
 * Record one accepted selection as the most recent, deduplicating earlier
 * occurrences of the same provider/model pair and aging out entries beyond
 * {@link MODEL_RECENT_LIMIT}. The reasoning effort is not part of a recent:
 * section rows re-select a model, which restores its provider default effort.
 * @param selection - the selection the Host accepted.
 */
export function recordModelRecent(selection: ModelSelection): void {
  const rest = read().filter(entry => entry.provider !== selection.provider || entry.model !== selection.model)
  write([{ provider: selection.provider, model: selection.model }, ...rest].slice(0, MODEL_RECENT_LIMIT))
}

/**
 * The current recent selections, most recent first.
 * @returns up to {@link MODEL_RECENT_LIMIT} provider/model pairs.
 */
export function modelRecents(): readonly ModelRecent[] {
  return read()
}
