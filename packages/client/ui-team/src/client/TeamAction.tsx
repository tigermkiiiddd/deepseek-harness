/**
 * Sidebar foot action: toggles the team panel. Renders the icon in rail mode
 * and adds the label when the sidebar is wide.
 */

import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-sidebar SlotMap merge ('sidebar.footer.action').
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import * as React from 'react'
import type { createTeamPanelStore } from './team-store.ts'

type TeamPanelStore = ReturnType<typeof createTeamPanelStore>

/** Composed props of the sidebar foot action entry. */
export type TeamActionProps = PropsRuntime<'sidebar.footer.action'> & PropsStore<TeamPanelStore>

/** The team toggle button rendered at the sidebar foot. */
export function TeamAction(props: TeamActionProps): React.ReactElement {
  const open = props.useStore(state => state.open)
  return React.createElement(
    'button',
    {
      type: 'button',
      onClick: () => { props.actions.toggle() },
      style: { background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 6 },
      title: '团队',
    },
    open ? '✕' : '👥',
    props.wide ? ' 团队' : null,
  )
}
