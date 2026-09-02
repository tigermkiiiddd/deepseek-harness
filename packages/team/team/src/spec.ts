/**
 * The team roster domain declaration: the durable shape of one runtime-added
 * member, validated at the storage boundary. The roster is the ONLY thing the
 * harness persists about a team — member sessions live in the member
 * processes. The deployment `Config.members` stays authoritative: a persisted
 * record whose id also appears in config is ignored at load.
 *
 * @module @deepseek-ai/dsh-team/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemberSession } from './types.ts'

/** Durable shape of one roster member (a full `MemberConfig`, defaults resolved). */
export const teamRosterRecord = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  kind: z.literal('dsh').optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  permission: z.union([z.literal('allow'), z.literal('reject')]).optional(),
  autostart: z.boolean().optional(),
  preset: z.string().optional(),
})

/** One stored roster record, inferred from {@link teamRosterRecord}. */
export type TeamRosterRecord = z.infer<typeof teamRosterRecord>

/** One cached session entry, mirroring {@link MemberSession} with optional wire passthroughs. */
const cachedMemberSession = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  updatedAt: z.string().optional(),
})

/** One cached topic: raw updates plus whether the cache came from a replay. */
const cachedTopic = z.object({
  updates: z.array(z.unknown()),
  replayed: z.boolean().default(false),
})

/** One cached topic, runtime type. */
export interface CachedTopic {
  updates: unknown[]
  replayed: boolean
}

/** One member's offline cache record. */
export interface MemberCacheRecord {
  sessions?: MemberSession[] | undefined
  topics: Record<string, CachedTopic>
}

/** Durable shape of one member's offline cache record. */
export const memberCacheRecord = z.object({
  sessions: z.array(cachedMemberSession).optional(),
  topics: z.record(z.string(), cachedTopic).default({}),
})

/**
 * The team roster domain: one `roster` table keyed by member id, plus a `cache`
 * table holding offline copies of each member's session list and topic update
 * streams. The service opens it through `ctx.storageDomain` when that seam
 * exists (the web surface always mounts it); a deployment without storage keeps
 * a memory-only cache.
 */
export const teamRosterDomainSpec = defineDomain({
  name: 'team',
  version: 2,
  tables: {
    roster: domainTable<string, TeamRosterRecord>(teamRosterRecord),
    cache: domainTable<string, MemberCacheRecord>(memberCacheRecord),
  },
})
