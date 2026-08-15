/**
 * Team view, browser half: a sidebar action that opens the team panel — the
 * member roster, each member's own conversation topics, and chat with a
 * member on a chosen topic. All data crosses the formal host API
 * (`api.team.*`, served by the host API-proxy); the member processes own
 * their sessions and history.
 *
 * @module @deepseek-ai/dsh-client-ui-team/client
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-sidebar SlotMap merge ('sidebar.footer.action') and
// the ui-layout merge ('shell.overlay') into the register type graph.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { TeamAction } from './TeamAction.tsx'
import { TeamPanel } from './TeamPanel.tsx'
import { createTeamFacade } from './team-facade.ts'
import { createTeamPanelStore } from './team-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'connection']

/**
 * Mount the sidebar action and the team panel.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const teamStore = createTeamPanelStore()
  const team = createTeamFacade(api.team)

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'team-panel-action',
    store: teamStore,
  }, TeamAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'team-panel',
    store: teamStore,
    inject: () => ({ team }),
  }, TeamPanel))
}
