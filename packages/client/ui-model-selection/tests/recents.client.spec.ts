// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODEL_RECENT_LIMIT, modelRecents, recordModelRecent } from '../src/client/recents.ts'

/** The recency store: dedupe by provider/model pair, most recent first, capped, localStorage-backed. */

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('model recents', () => {
  it('records selections most recent first and deduplicates a re-picked pair', () => {
    recordModelRecent({ provider: 'a', model: 'one' })
    recordModelRecent({ provider: 'b', model: 'two' })

    expect(modelRecents()).toEqual([
      { provider: 'b', model: 'two' },
      { provider: 'a', model: 'one' },
    ])

    // Re-picking the oldest entry moves it to the front instead of duplicating.
    recordModelRecent({ provider: 'a', model: 'one' })
    expect(modelRecents()).toEqual([
      { provider: 'a', model: 'one' },
      { provider: 'b', model: 'two' },
    ])
  })

  it('caps the section at the limit, aging the oldest picks out', () => {
    for (let index = 0; index <= MODEL_RECENT_LIMIT; index++) {
      recordModelRecent({ provider: 'p', model: `m${String(index)}` })
    }
    const picks = modelRecents()
    expect(picks).toHaveLength(MODEL_RECENT_LIMIT)
    expect(picks[0]).toEqual({ provider: 'p', model: `m${String(MODEL_RECENT_LIMIT)}` })
    expect(picks.some(entry => entry.model === 'm0')).toBe(false)
  })

  it('survives a reload through localStorage', () => {
    recordModelRecent({ provider: 'a', model: 'one' })
    expect(modelRecents()).toEqual([{ provider: 'a', model: 'one' }])
  })

  it('reads malformed stored state as no recents instead of throwing', () => {
    localStorage.setItem('dsh.modelRecents', 'not json')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(modelRecents()).toEqual([])

    localStorage.setItem('dsh.modelRecents', JSON.stringify({ provider: 'a' }))
    expect(modelRecents()).toEqual([])

    // Entries missing a field are dropped; the sound siblings stay.
    localStorage.setItem('dsh.modelRecents', JSON.stringify([
      { provider: 'a' },
      { model: 'one' },
      { provider: '', model: 'two' },
      { provider: 'ok', model: 'three' },
    ]))
    expect(modelRecents()).toEqual([{ provider: 'ok', model: 'three' }])
  })

  it('keeps the menu working when storage refuses writes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => recordModelRecent({ provider: 'a', model: 'one' })).not.toThrow()
    expect(modelRecents()).toEqual([])
  })
})
