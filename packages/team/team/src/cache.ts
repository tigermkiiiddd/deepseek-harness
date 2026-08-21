/**
 * Durable per-member cache for member sessions and their conversation history.
 * The team service persists this through the same `team` storage domain as the
 * roster. A cache record is plain JSON: no secrets are stored; updates are the
 * raw ACP `session/update` payloads the member already showed us.
 *
 * The cache is write-batched within one event-loop tick so a burst of live
 * updates produces one durable put, not one per chunk.
 *
 * @module @deepseek-ai/dsh-team/cache
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { CachedTopic, MemberCacheRecord } from './spec.ts'
import type { MemberSession } from './types.ts'

export type { CachedTopic, MemberCacheRecord } from './spec.ts'

/** Storage backend for one member cache record. */
export interface MemberCacheStorage {
  /** Read the persisted record, or undefined when the medium has none. */
  get(): MemberCacheRecord | undefined
  /** Persist the full record. */
  put(record: MemberCacheRecord): Promise<void>
}

/**
 * In-memory member cache with optional durable backing. All mutations update
 * memory synchronously and schedule one batched flush to storage.
 */
export class MemberCache {
  private record: MemberCacheRecord
  private storage: MemberCacheStorage | undefined
  private flushPending = false
  private flushPromise: Promise<void> | undefined

  constructor() {
    this.record = { topics: {} }
  }

  /**
   * Bind (or rebind) the durable storage and load any existing record.
   * @param storage - the per-member persistence slice; later binds merge under in-memory state.
   */
  setStorage(storage: MemberCacheStorage): void {
    this.storage = storage
    const loaded = storage.get()
    if (loaded === undefined) return
    // Merge storage over the in-memory state: a mutation that raced ahead of
    // the domain opening wins, because the in-memory state is always at least
    // as fresh as the medium.
    this.record = {
      ...this.record.sessions === undefined && loaded.sessions !== undefined
        ? { sessions: loaded.sessions }
        : {},
      topics: {
        ...loaded.topics,
        ...this.record.topics,
      },
    }
  }

  /**
   * Read the cached session list, or undefined when never cached.
   * @returns the last live topic listing, exactly as the member reported it.
   */
  getSessions(): MemberSession[] | undefined {
    return this.record.sessions
  }

  /**
   * Replace the cached session list and flush.
   * @param sessions - the member's full topic list from the latest live listing.
   */
  async setSessions(sessions: MemberSession[]): Promise<void> {
    this.record = { ...this.record, sessions }
    return this.scheduleFlush()
  }

  /**
   * Read one topic's cached updates, or undefined when never cached.
   * @param sessionId - the member's topic id.
   * @returns the cached topic record (raw updates plus replay marker).
   */
  getTopic(sessionId: string): CachedTopic | undefined {
    return this.record.topics[sessionId]
  }

  /**
   * Start a replay: wipe the topic's cached updates so the replay replaces
   * them authoritatively. Live updates for this topic still append after.
   * @param sessionId - the member's topic id being replayed.
   */
  startReplay(sessionId: string): void {
    this.record.topics[sessionId] = { updates: [], replayed: false }
    void this.scheduleFlush()
  }

  /**
   * Append one live or replay update to a topic's cache.
   * @param sessionId - the member's topic id.
   * @param update - the raw ACP `session/update` payload as received.
   */
  async appendUpdate(sessionId: string, update: SessionUpdate): Promise<void> {
    const topic = this.record.topics[sessionId]
    if (topic === undefined) {
      this.record.topics[sessionId] = { updates: [update], replayed: false }
    } else {
      topic.updates.push(update)
    }
    return this.scheduleFlush()
  }

  /**
   * Mark a topic's cache as replay-authoritative.
   * @param sessionId - the member's topic id whose replay just completed.
   */
  async finishReplay(sessionId: string): Promise<void> {
    const topic = this.record.topics[sessionId]
    if (topic !== undefined) topic.replayed = true
    return this.scheduleFlush()
  }

  private scheduleFlush(): Promise<void> {
    if (this.storage === undefined) return Promise.resolve()
    if (this.flushPending) return this.flushPromise as Promise<void>
    const storage = this.storage
    this.flushPending = true
    this.flushPromise = Promise.resolve().then(async () => {
      this.flushPending = false
      await storage.put(this.record)
    })
    return this.flushPromise
  }
}
