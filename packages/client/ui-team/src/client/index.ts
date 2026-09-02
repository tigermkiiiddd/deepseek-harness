/**
 * Team view, browser half: the frame-wide global visualization lane
 * (`shell.topbar`) showing every agent (the main instance plus each member)
 * as nodes with live status. Member sessions are first-class sessions in the
 * main conversation UI; clicking a member node opens that member's current
 * topic through the regular session-selection path (`ctx.sessions.open`).
 * All data crosses the formal host API (`api.team.*`) and the forwarded
 * `team/status` Remote events; the member processes own their sessions. The
 * push bridge folds host status events into the controller's store — nothing
 * polls.
 *
 * @module @deepseek-ai/dsh-client-ui-team/client
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote face (ctx.remote.$on key set) through
// the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-layout SlotMap merge ('shell.topbar').
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MemberStatus } from '@deepseek-ai/dsh-team/types'
import { TeamTopbar } from './TeamTopbar.tsx'
import { createTeamFacade } from './team-facade.ts'
import { TeamController } from './team-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'connection', 'remote', 'sessions']

/**
 * Mount the global team lane and the status push bridge that keeps it live.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const controller = new TeamController(createTeamFacade(api.team), ctx.sessions)

  // The push bridge: forwarded host team status events fold into the
  // controller's store. The subscription is an effect of this fiber and
  // disposes with it.
  ctx.effect(() => {
    const dispose = ctx.remote.$on('team/status', (memberId: string, status: MemberStatus, error?: string) => {
      controller.onStatus(memberId, status, error)
    })
    return dispose
  }, 'ui-team: status bridge')

  const teamFace = {
    hooks: { teamLive: controller.store },
    loadMembers: () => { controller.loadMembers() },
    openMember: (memberId: string | undefined) => { controller.openMember(memberId) },
    start: (memberId: string) => { controller.start(memberId) },
    stop: (memberId: string) => { controller.stop(memberId) },
    restart: (memberId: string) => { controller.restart(memberId) },
    addMember: (config: import('@deepseek-ai/dsh-client-connection/client').TeamAddMemberRequest) => controller.addMember(config),
    removeMember: (memberId: string) => controller.removeMember(memberId),
  }

  ctx.slots.inject('shell.topbar', () => ctx.slots.register({
    name: 'shell.topbar',
    inject: () => teamFace,
  }, TeamTopbar))
}
