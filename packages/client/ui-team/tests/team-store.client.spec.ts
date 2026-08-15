/** Team panel store: the shared open/closed state for the sidebar action and the overlay. */
import { describe, expect, it } from 'vitest'
import { createTeamPanelStore } from '../src/client/team-store.ts'

describe('createTeamPanelStore', () => {
  it('starts closed and toggles open and back', () => {
    const instance = createTeamPanelStore().create()
    expect(instance.getSnapshot()).toEqual({ open: false })
    instance.actions.toggle()
    expect(instance.getSnapshot()).toEqual({ open: true })
    instance.actions.toggle()
    expect(instance.getSnapshot()).toEqual({ open: false })
  })

  it('seeds a fresh closed state per instance', () => {
    const a = createTeamPanelStore().create()
    const b = createTeamPanelStore().create()
    a.actions.toggle()
    expect(a.getSnapshot()).toEqual({ open: true })
    expect(b.getSnapshot()).toEqual({ open: false })
  })
})
