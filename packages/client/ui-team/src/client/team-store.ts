/**
 * Team panel visibility store: one shared handle for the sidebar action and
 * the overlay entry. The store carries only the open/closed state; member
 * data stays in the panel's local state, fed by the team facade.
 */

import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { StoreHandle } from '@deepseek-ai/dsh-client-ui-slots'

/** Panel visibility, shared by the sidebar action and the overlay entry. */
export interface TeamPanelState {
  open: boolean
}

/**
 * Create the team-panel store handle. Constructed in apply world so one
 * handle instance is shared by the two registrations (one scope, two seats).
 * @returns the shared store handle.
 */
export function createTeamPanelStore(): StoreHandle<TeamPanelState, { toggle(draft: TeamPanelState): void }> {
  return defineStore({
    init: () => ({ open: false }),
    actions: {
      toggle(draft) {
        draft.open = !draft.open
      },
    },
  })
}
