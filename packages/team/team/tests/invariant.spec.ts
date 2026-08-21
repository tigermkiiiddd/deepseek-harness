import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as TeamInvariant from '../src/invariant.ts'
import type { MemberStatus } from '../src/types.ts'

/** Boot the invariant service plus the companion over a stubbed team service knowing exactly `members`. */
async function setup(members: { id: string; status: MemberStatus; lastError?: string }[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  ctx.provide('team', { list: () => members })
  await ctx.plugin(TeamInvariant)
  return ctx
}

describe('team status/snapshot invariant', () => {
  it('accepts a status event that matches the roster snapshot', async () => {
    const ctx = await setup([{ id: 'architect', status: 'running' }])
    expect(() => { ctx.emit('team/status', 'architect', 'running') }).not.toThrow()
  })

  it('fails a status event that contradicts the snapshot', async () => {
    const ctx = await setup([{ id: 'architect', status: 'running' }])
    expect(() => { ctx.emit('team/status', 'architect', 'failed', 'boom') })
      .toThrow(/announced failed but the roster snapshot reports running/)
  })

  it('ignores events for a member that was removed after its last event', async () => {
    const ctx = await setup([])
    expect(() => { ctx.emit('team/status', 'architect', 'idle') }).not.toThrow()
  })

  it('does not fail without a team service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(TeamInvariant)
    expect(() => { ctx.emit('team/status', 'architect', 'idle') }).not.toThrow()
  })
})
