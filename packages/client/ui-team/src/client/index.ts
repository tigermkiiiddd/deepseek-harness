/**
 * Team view, browser half: a sidebar action that opens the team panel — the
 * member roster, each member's own conversation topics, and chat with a
 * member on a chosen topic. All data crosses the formal host API
 * (`api.team.*`, served by the host API-proxy); the member processes own
 * their sessions and history.
 *
 * @module @deepseek-ai/dsh-client-ui-team/client
 */

import type {
  ConnectionHandle, IApiClient, RpcResponse,
  TeamChatResultView, TeamHistoryEntryView, TeamMemberView, TeamSessionView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime, PropsStore, StoreHandle } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-sidebar SlotMap merge ('sidebar.footer.action') and
// the ui-layout merge ('shell.overlay') into the register type graph.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import * as React from 'react'

/** Panel visibility, shared by the sidebar action and the overlay entry. */
interface TeamPanelState {
  open: boolean
}

/**
 * Create the team-panel store handle. Constructed in apply world so one
 * handle instance is shared by the two registrations (one scope, two seats).
 */
function createTeamPanelStore(): StoreHandle<TeamPanelState, { toggle(draft: TeamPanelState): void }> {
  return defineStore({
    init: () => ({ open: false }),
    actions: {
      toggle(draft) {
        draft.open = !draft.open
      },
    },
  })
}

type TeamPanelStore = ReturnType<typeof createTeamPanelStore>

/** The team operations the panel drives, each unwrapped from the host API. */
interface TeamFacade {
  /** List configured members. */
  list(): Promise<TeamMemberView[]>
  /** List a member's own conversation topics. */
  sessions(memberId: string): Promise<TeamSessionView[]>
  /** Replay one topic's history. */
  history(memberId: string, sessionId: string): Promise<TeamHistoryEntryView[]>
  /** Start a fresh topic on a member and return its id. */
  newSession(memberId: string): Promise<string>
  /** Send one turn and return the member's settled reply. */
  chat(memberId: string, sessionId: string, text: string): Promise<TeamChatResultView>
}

/**
 * Unwrap a team unary response, throwing on the error branch.
 * @param call - a pending team domain response.
 * @returns the ok-branch value.
 */
async function unwrap<T>(call: Promise<RpcResponse<T>>): Promise<T> {
  const response = await call
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

/** Build the panel facade over the wire face. */
function createTeamFacade(team: IApiClient['team']): TeamFacade {
  return {
    list: () => unwrap(team.list({})),
    sessions: memberId => unwrap(team.sessions({ memberId })),
    history: (memberId, sessionId) => unwrap(team.history({ memberId, sessionId })),
    newSession: async memberId => (await unwrap(team.newSession({ memberId }))).sessionId,
    chat: (memberId, sessionId, text) => unwrap(team.chat({ memberId, sessionId, text })),
  }
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: 16,
  top: 16,
  bottom: 16,
  width: 420,
  maxWidth: 'calc(100vw - 32px)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--dsw-bg, #1e1e2e)',
  border: '1px solid var(--dsw-border, #3a3a4a)',
  borderRadius: 12,
  padding: 12,
  gap: 8,
  zIndex: 1000,
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  overflow: 'hidden',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderRadius: 6,
  cursor: 'pointer',
}

const msgStyle = (role: 'user' | 'assistant'): React.CSSProperties => ({
  alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
  maxWidth: '80%',
  padding: '6px 10px',
  borderRadius: 8,
  background: role === 'user' ? 'var(--dsw-accent, #4c6ef5)' : 'var(--dsw-bg2, #2a2a3a)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
})

type TeamActionProps = PropsRuntime<'sidebar.footer.action'> & PropsStore<TeamPanelStore>

/** Sidebar action: the team toggle (icon in rail mode, label when wide). */
function TeamAction(props: TeamActionProps): React.ReactElement {
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

/** The inject face the panel entry receives: the team facade from apply's closure. */
interface TeamPanelInjected {
  team: TeamFacade
}

type TeamPanelProps = PropsRuntime<'shell.overlay'> & PropsStore<TeamPanelStore> & TeamPanelInjected

/** The team panel: roster → topics → history → composer. */
function TeamPanel(props: TeamPanelProps): React.ReactElement | null {
  const open = props.useStore(state => state.open)
  const team = props.team
  const [members, setMembers] = React.useState<TeamMemberView[]>([])
  const [selectedMember, setSelectedMember] = React.useState<string | undefined>(undefined)
  const [sessions, setSessions] = React.useState<TeamSessionView[]>([])
  const [selectedSession, setSelectedSession] = React.useState<string | undefined>(undefined)
  const [history, setHistory] = React.useState<TeamHistoryEntryView[]>([])
  const [input, setInput] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)

  React.useEffect(() => {
    if (!open) return
    void team.list().then(setMembers).catch((err: unknown) => { setError(String(err)) })
  }, [open, team])

  if (!open) return null

  const selectMember = (memberId: string): void => {
    setSelectedMember(memberId)
    setSelectedSession(undefined)
    setHistory([])
    void team.sessions(memberId).then(setSessions).catch((err: unknown) => { setError(String(err)) })
  }

  const selectSession = (sessionId: string): void => {
    if (selectedMember === undefined) return
    setSelectedSession(sessionId)
    void team.history(selectedMember, sessionId).then(setHistory).catch((err: unknown) => { setError(String(err)) })
  }

  const newTopic = (): void => {
    if (selectedMember === undefined) return
    setBusy(true)
    void team.newSession(selectedMember).then((sessionId) => {
      setSelectedSession(sessionId)
      setHistory([])
      setSessions(prev => [...prev, { sessionId, cwd: '' }])
      setBusy(false)
    }).catch((err: unknown) => {
      setError(String(err))
      setBusy(false)
    })
  }

  const send = (): void => {
    const text = input.trim()
    if (text === '' || selectedMember === undefined || selectedSession === undefined || busy) return
    setBusy(true)
    setError(undefined)
    setInput('')
    void team.chat(selectedMember, selectedSession, text).then((reply) => {
      setHistory(prev => [...prev, { role: 'user', text }, { role: 'assistant', text: reply.text }])
      setBusy(false)
    }).catch((err: unknown) => {
      setError(String(err))
      setBusy(false)
    })
  }

  return React.createElement(
    'div',
    { style: panelStyle },
    React.createElement('h3', { style: { margin: 0 } }, '👥 团队'),
    error === undefined
      ? null
      : React.createElement('div', { style: { color: '#e03131', fontSize: 12 } }, error),
    // Roster
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', maxHeight: 160 } },
      members.map(member => React.createElement(
        'div',
        {
          key: member.id,
          style: { ...rowStyle, background: member.id === selectedMember ? 'var(--dsw-bg2, #2a2a3a)' : undefined },
          onClick: () => { selectMember(member.id) },
        },
        React.createElement('span', null, member.title),
        React.createElement('span', { style: { fontSize: 11, color: '#868e96' } },
          `${member.status}${member.description === undefined ? '' : ` · ${member.description}`}`),
      )),
    ),
    // Topics
    selectedMember === undefined
      ? null
      : React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', maxHeight: 120 } },
        sessions.map(session => React.createElement(
          'div',
          {
            key: session.sessionId,
            style: { ...rowStyle, background: session.sessionId === selectedSession ? 'var(--dsw-bg2, #2a2a3a)' : undefined },
            onClick: () => { selectSession(session.sessionId) },
          },
          React.createElement('span', { style: { fontSize: 13 } }, '🗂 '),
          React.createElement('span', { style: { fontSize: 13 } }, session.sessionId),
        )),
        React.createElement(
          'button',
          { onClick: () => { newTopic() }, disabled: busy, style: { alignSelf: 'flex-start', fontSize: 12 } },
          '＋ 新话题',
        ),
      ),
    // History
    selectedSession === undefined
      ? React.createElement('div', { style: { color: '#868e96', fontSize: 13, textAlign: 'center' } },
        '选择一个成员和话题开始对话')
      : React.createElement(
        'div',
        { style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 } },
        history.map((entry, index) => React.createElement(
          'div',
          { key: index, style: msgStyle(entry.role) },
          entry.text,
        )),
      ),
    // Composer
    selectedSession === undefined
      ? null
      : React.createElement(
        'div',
        { style: { display: 'flex', gap: 6 } },
        React.createElement('input', {
          value: input,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setInput(event.target.value) },
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === 'Enter') send()
          },
          placeholder: busy ? '成员思考中…' : '给成员发消息',
          disabled: busy,
          style: { flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-border, #3a3a4a)', background: 'var(--dsw-bg2, #2a2a3a)', color: 'inherit' },
        }),
        React.createElement('button', { onClick: () => { send() }, disabled: busy }, '发送'),
      ),
  )
}

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
