/**
 * The frame-wide global visualization lane (ui-layout's `shell.topbar`): one
 * node per agent — the main instance first, then every member — with links
 * between them. Node color carries the live status pushed by the host
 * (`team/status` events folded into the shared store; nothing polls); clicking
 * a member node opens that member's current topic as a first-class session
 * through the regular conversation session list (`ctx.sessions.open`). The
 * lane also hosts the member management controls: a "new member" form (full
 * member config: command, args, cwd, env, permission policy, autostart) and
 * per-node remove/start/stop/restart.
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-layout SlotMap merge ('shell.topbar').
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import * as React from 'react'
import type { SessionListState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamViewState } from './team-store.ts'
import css from './TeamTopbar.module.css'

/** The inject face the topbar receives (hooks + drive verbs). */
export interface TeamViewInjected {
  /** Live team snapshot bound by the renderer as `useTeamLive`. */
  hooks: { teamLive: SnapshotStore<TeamViewState> }
  loadMembers(): void
  openMember(memberId: string | undefined): void
  start(memberId: string): void
  stop(memberId: string): void
  restart(memberId: string): void
  addMember(config: import('@deepseek-ai/dsh-client-connection/client').TeamAddMemberRequest): Promise<void>
  removeMember(memberId: string): Promise<void>
}

/** Composed props of the topbar entry. */
export type TeamTopbarProps = PropsRuntime<'shell.topbar'> & InjectFace<TeamViewInjected>

/** Node geometry: one horizontal lane, circles with links between them. */
const NODE_R = 9
const LINK_Y = 22
const GAP = 88
const PAD = 20

/** Map a member status to its lane class (idle/running/offline/failed). */
function statusClass(status: string): string {
  switch (status) {
    case 'running': return 'running'
    case 'failed': return 'failed'
    case 'offline': return 'offline'
    default: return 'idle'
  }
}

/** One agent node in the lane. */
interface AgentNode {
  id: string | undefined
  title: string
  status: string
}

/** The "new member" form fields (id and command are required). */
interface MemberFormState {
  id: string
  title: string
  description: string
  command: string
  args: string
  cwd: string
  env: string
  permission: '' | 'allow' | 'reject'
  autostart: boolean
}

const EMPTY_FORM: MemberFormState = {
  id: '', title: '', description: '', command: '', args: '', cwd: '', env: '', permission: '', autostart: true,
}

/**
 * Split a command-line args string into an array, respecting double quotes.
 * No escape handling: quotes simply group whitespace-delimited tokens.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuotes = false
  for (const char of input.trim()) {
    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ' ' || char === '\t') {
      if (inQuotes) {
        current += char
      } else if (current !== '') {
        args.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current !== '') args.push(current)
  return args
}

/** The global team view: nodes + links, click to open a member session, plus member management. */
export function TeamTopbar(props: TeamTopbarProps): React.ReactElement {
  const { useTeamLive, useSessions } = props
  const current = useTeamLive(state => state.currentAgentId)
  const members = useTeamLive(state => state.members)
  const sessionRunning = useSessions((state: SessionListState) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.running === true
  })
  const [formOpen, setFormOpen] = React.useState(false)
  const [form, setForm] = React.useState<MemberFormState>(EMPTY_FORM)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)

  // Baseline on mount and whenever the lane remounts (reconnect recovery);
  // live migrations keep the roster current between loads. The controller
  // outlives remounts, so the effect intentionally runs once.
  React.useEffect(() => {
    props.loadMembers()
  }, [])

  const nodes: AgentNode[] = [
    { id: undefined, title: '主实例', status: sessionRunning ? 'running' : 'idle' },
    ...members.map(member => ({ id: member.id, title: member.title, status: member.status })),
  ]
  const width = PAD * 2 + Math.max(0, nodes.length - 1) * GAP

  const setField = (field: keyof MemberFormState, value: string | boolean): void => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const addMember = (): void => {
    if (form.id.trim() === '' || form.command.trim() === '' || busy) return
    setBusy(true)
    setError(undefined)
    const args = form.args.trim() === '' ? [] : splitArgs(form.args.trim())
    const env: Record<string, string> = {}
    for (const line of form.env.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const separator = trimmed.indexOf('=')
      if (separator <= 0) {
        setError(`env 行需要 KEY=VALUE 格式: ${trimmed}`)
        setBusy(false)
        return
      }
      env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1)
    }
    void props.addMember({
      id: form.id.trim(),
      ...form.title.trim() === '' ? {} : { title: form.title.trim() },
      ...form.description.trim() === '' ? {} : { description: form.description.trim() },
      command: form.command.trim(),
      args,
      ...form.cwd.trim() === '' ? {} : { cwd: form.cwd.trim() },
      ...Object.keys(env).length === 0 ? {} : { env },
      ...form.permission === '' ? {} : { permission: form.permission },
      autostart: form.autostart,
    }).then(() => {
      setForm(EMPTY_FORM)
      setFormOpen(false)
      setBusy(false)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    })
  }

  return (
    <div className={css.bar}>
      <svg
        className={css.lane}
        viewBox={`0 0 ${width} 44`}
        width="100%"
        height="100%"
        role="img"
        aria-label="团队全局视图"
      >
        {nodes.slice(0, -1).map((node, index) => (
          <line
            key={`link-${node.id ?? 'self'}`}
            x1={PAD + index * GAP + NODE_R}
            y1={LINK_Y}
            x2={PAD + (index + 1) * GAP - NODE_R}
            y2={LINK_Y}
            className={css.link}
          />
        ))}
        {nodes.map((node, index) => {
          const cx = PAD + index * GAP
          const active = node.id === current
          return (
            <g
              key={node.id ?? 'self'}
              className={css.node}
              onClick={() => { props.openMember(node.id) }}
            >
              {active && <circle cx={cx} cy={LINK_Y} r={NODE_R + 5} className={css.halo} />}
              <circle cx={cx} cy={LINK_Y} r={NODE_R} className={`${css.status} ${css[statusClass(node.status)]}`} />
              <text x={cx + NODE_R + 6} y={LINK_Y + 4} className={css.label}>{node.title}</text>
              {node.id !== undefined && (
                <g
                  className={css.remove}
                  onClick={(event: React.MouseEvent) => {
                    event.stopPropagation()
                    void props.removeMember(node.id as string)
                  }}
                >
                  <text x={cx + NODE_R - 4} y={LINK_Y - 10} className={css.removeMark}>✕</text>
                </g>
              )}
              {/* Transparent hit area: the whole node plus label is clickable. */}
              <circle cx={cx} cy={LINK_Y} r={NODE_R + 14} fill="transparent" />
            </g>
          )
        })}
      </svg>
      {formOpen
        ? (
          <div className={css.form}>
            <div className={css.formGrid}>
              <input placeholder="成员 id（唯一）" value={form.id} onChange={(e) => { setField('id', e.target.value) }} />
              <input placeholder="显示名称（可选）" value={form.title} onChange={(e) => { setField('title', e.target.value) }} />
              <input placeholder="描述（可选）" value={form.description} onChange={(e) => { setField('description', e.target.value) }} />
              <input placeholder="命令（任意 ACP agent，如 dsh-acp-demo）" value={form.command} onChange={(e) => { setField('command', e.target.value) }} />
              <input placeholder="参数（空格分隔，可选）" value={form.args} onChange={(e) => { setField('args', e.target.value) }} />
              <input placeholder="工作目录 cwd（可选）" value={form.cwd} onChange={(e) => { setField('cwd', e.target.value) }} />
              <textarea
                placeholder="env（每行 KEY=VALUE，继承完整父环境）"
                value={form.env}
                onChange={(e) => { setField('env', e.target.value) }}
              />
              <select
                value={form.permission}
                onChange={(e) => { setField('permission', e.target.value) }}
              >
                <option value="">权限策略（默认 reject）</option>
                <option value="allow">allow（自动允许）</option>
                <option value="reject">reject（自动拒绝）</option>
              </select>
              <label className={css.autostart}>
                <input
                  type="checkbox"
                  checked={form.autostart}
                  onChange={(e) => { setField('autostart', e.target.checked) }}
                />
                随主机启动
              </label>
            </div>
            <div className={css.formActions}>
              <button type="button" onClick={() => { addMember() }} disabled={busy}>添加</button>
              <button type="button" onClick={() => { setFormOpen(false) }} disabled={busy}>取消</button>
            </div>
            {error === undefined ? null : <div className={css.formError}>{error}</div>}
          </div>
        )
        : (
          <button
            type="button"
            className={css.addButton}
            title="新建成员"
            onClick={() => { setFormOpen(true) }}
          >
            ＋ 新建成员
          </button>
        )}
    </div>
  )
}
