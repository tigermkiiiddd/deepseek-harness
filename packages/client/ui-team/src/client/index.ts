/**
 * Team view browser plugin: mounts the generated Team Remote namespace and
 * registers the member lane in the sidebar footer.
 *
 * @module @deepseek-ai/dsh-client-ui-team/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import teamRemote from '@deepseek-ai/dsh-team/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TeamTopbar } from './TeamTopbar.tsx'
import { createTeamFacade } from './team-facade.ts'
import { TeamController } from './team-store.ts'

/** Services required before this plugin can mount its Team Remote contribution. */
export const inject = ['remote', 'sessions', 'slots']

function registerUi(ctx: ClientContext): void {
  const controller = new TeamController(createTeamFacade(ctx.remote.team), ctx.sessions)
  const teamFace = {
    hooks: { teamLive: controller.store, sessions: ctx.sessions.list },
    loadMembers: () => { controller.loadMembers() },
    openMember: (memberId: string | undefined) => { controller.openMember(memberId) },
    start: (memberId: string) => { controller.start(memberId) },
    stop: (memberId: string) => { controller.stop(memberId) },
    restart: (memberId: string) => { controller.restart(memberId) },
    addMember: (config: Parameters<TeamController['addMember']>[0]) => controller.addMember(config),
    removeMember: (memberId: string) => controller.removeMember(memberId),
  }

  ctx.effect(() => () => { controller.dispose() }, 'client-ui-team: controller')
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'team', inject: () => teamFace }, TeamTopbar))
}

/**
 * Mount the generated Team Remote contribution before the UI fiber requires
 * `remote.team`, then dispose both in reverse order.
 * @param ctx - browser plugin context.
 * @returns disposer for the UI registrations and Remote namespace.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(teamRemote)
  const ui = ctx.inject(['remote.team', 'sessions', 'slots'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
