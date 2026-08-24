import { describe, expect, it } from 'vitest'
import { resolveMemberSpec } from '../src/resolve.ts'

/**
 * Keyless unit tests for the resolved spawn spec. No model, no key.
 */

describe('resolveMemberSpec()', () => {
  it('gives a kind:dsh member its own DSH_HOME and no DSH_MAIN_HOME', () => {
    const spec = resolveMemberSpec({ id: 'm1', kind: 'dsh' })
    expect(spec.env.DSH_HOME).toMatch(/members[\\/]m1$/)
    // The member is self-contained: it must not inherit the main home at runtime.
    expect(spec.env.DSH_MAIN_HOME).toBeUndefined()
  })

  it('keeps DSH_MAIN_HOME absent for a custom member', () => {
    const spec = resolveMemberSpec({ id: 'ext', command: 'dsh-acp' })
    expect(spec.env.DSH_HOME).toBeUndefined()
    expect(spec.env.DSH_MAIN_HOME).toBeUndefined()
  })

  it('accepts a preset for a kind:dsh member and refuses it otherwise', () => {
    const composition = '- id: persona\n  name: some-persona-plugin\n'
    expect(() => resolveMemberSpec({ id: 'm1', kind: 'dsh', preset: composition })).not.toThrow()
    expect(() => resolveMemberSpec({ id: 'ext', command: 'dsh-acp', preset: composition }))
      .toThrow(/cannot set preset without kind/)
  })
})
