/**
 * Team view state and controller: the live member roster and the verbs that
 * drive the lane. `currentAgentId === undefined` means the main instance is
 * selected; a member id means that member's current topic is opened as a
 * first-class session through the regular conversation session list.
 * Remote status events arrive over the host push channel and are folded here;
 * the component only reads the snapshot and calls the controller's verbs.
 */

import type { SessionId, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { memberSessionOwner, MEMBER_SESSION_PREFIX } from '@deepseek-ai/dsh-host-apiproxy/src/team-sessions.ts'
import type { TeamMemberView } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamFacade } from './team-facade.ts'

/** The current agent whose session the main conversation UI shows. */
export interface TeamViewState {
  /** Member id when a member session is open; undefined = main instance. */
  currentAgentId: string | undefined
  /** The roster (baseline from team.list, then upserted by status events). */
  members: TeamMemberView[]
  /** The last operation's error, for views. */
  error: string | undefined
}

const INITIAL: TeamViewState = {
  currentAgentId: undefined,
  members: [],
  error: undefined,
}

/**
 * The team view controller: one live snapshot store plus the verbs that
 * mutate it. Constructed in apply world; the store rides the inject `hooks`
 * compartment (bound as `useTeamLive`), and the verbs are the inject face the
 * topbar calls. One instance per plugin fiber.
 */
export class TeamController {
  /** Live snapshot store holding the current team view state. */
  readonly store: SnapshotStore<TeamViewState> = createSnapshotStore(INITIAL)

  private readonly disposeSessionSync: () => void

  constructor(
    private readonly team: TeamFacade,
    private readonly sessions: ISessions,
  ) {
    this.disposeSessionSync = this.sessions.list.subscribe(() => { this.syncCurrentAgentFromSession() })
    this.syncCurrentAgentFromSession()
  }

  /** Stop following the sessions selection; safe to call more than once. */
  dispose(): void {
    this.disposeSessionSync()
  }

  /** Reload the roster from the host (reconnect/refresh baseline). */
  loadMembers(): void {
    void this.team.list().then((members) => {
      this.store.update((draft) => {
        draft.members = members
        draft.error = undefined
      })
    }).catch((error: unknown) => { this.setError(error) })
  }

  /**
   * Open one member's current topic as a first-class session in the main
   * conversation UI, or return to the main instance view.
   * @param memberId - member to open, or undefined to return to the main instance.
   */
  openMember(memberId: string | undefined): void {
    if (memberId === undefined) {
      this.store.update((draft) => { draft.currentAgentId = undefined })
      this.sessions.clear()
      return
    }
    if (this.store.getSnapshot().currentAgentId === memberId) return
    this.store.update((draft) => {
      draft.currentAgentId = memberId
      draft.error = undefined
    })
    void this.team.sessions(memberId).then(async (sessions) => {
      const now = this.store.getSnapshot()
      if (now.currentAgentId !== memberId) return
      const topicId = sessions.length === 0
        ? await this.team.newSession(memberId)
        : sessions[sessions.length - 1]?.sessionId
      if (topicId === undefined) return
      if (this.store.getSnapshot().currentAgentId !== memberId) return
      this.openMemberTopic(memberId, topicId)
    }).catch((error: unknown) => { this.setError(error) })
  }

  /**
   * Open one member topic as the current session. The topic can be newer than
   * this client's list baseline (created after the page loaded), and a select
   * that misses it re-baselines the list once and retries before surfacing
   * the failure.
   * @param memberId - the member owning the topic.
   * @param topicId - the topic id inside the member's own session store.
   */
  private openMemberTopic(memberId: string, topicId: string): void {
    const sessionId = memberSessionId(memberId, topicId)
    try {
      this.sessions.open(sessionId)
    } catch {
      void this.sessions.refresh().then(() => { this.sessions.open(sessionId) })
        .catch((error: unknown) => { this.setError(error) })
    }
  }

  /**
   * Keep the topbar selection in sync with the session list: a member session
   * lights that member's node, and any other selection clears it. This is a
   * no-op when the change was produced by {@link openMember}, so the two paths
   * do not loop.
   */
  private syncCurrentAgentFromSession(): void {
    const sessionId = this.sessions.list.getSnapshot().current
    const owner = sessionId === undefined ? undefined : memberSessionOwner(sessionId)
    const current = this.store.getSnapshot().currentAgentId
    if (owner === current) return
    this.store.update((draft) => { draft.currentAgentId = owner })
  }

  /**
   * Start one member's process.
   * @param memberId - member whose process should start.
   */
  start(memberId: string): void {
    void this.team.start(memberId).catch((error: unknown) => { this.setError(error) })
  }

  /**
   * Stop one member's process.
   * @param memberId - member whose process should stop.
   */
  stop(memberId: string): void {
    void this.team.stop(memberId).catch((error: unknown) => { this.setError(error) })
  }

  /**
   * Stop then start one member.
   * @param memberId - member to restart.
   */
  restart(memberId: string): void {
    void this.team.restart(memberId).catch((error: unknown) => { this.setError(error) })
  }

  /**
   * Add a member at runtime; the roster updates through status events.
   * @param config - member spawn and persistence configuration.
   */
  addMember(config: Parameters<TeamFacade['addMember']>[0]): Promise<void> {
    return this.team.addMember(config).then(() => { this.loadMembers() })
      .catch((error: unknown) => { this.setError(error); throw error })
  }

  /**
   * Remove one member; if it is the selected member, switch back to the main instance.
   * @param memberId - member to remove from the roster.
   */
  removeMember(memberId: string): Promise<void> {
    return this.team.removeMember(memberId).then(() => {
      this.store.update((draft) => {
        draft.members = draft.members.filter(member => member.id !== memberId)
        if (draft.currentAgentId === memberId) {
          draft.currentAgentId = undefined
        }
      })
    }).catch((error: unknown) => { this.setError(error); throw error })
  }

  /**
   * One status migration pushed by the host.
   * @param memberId - member whose status changed.
   * @param status - new public status: idle, running, offline, or failed.
   * @param error - optional last start or runtime error.
   */
  onStatus(memberId: string, status: string, error?: string): void {
    this.store.update((draft) => {
      const index = draft.members.findIndex(member => member.id === memberId)
      if (index < 0) return
      const current = draft.members[index] as TeamMemberView
      draft.members = [
        ...draft.members.slice(0, index),
        { ...current, status, ...error === undefined ? {} : { lastError: error } },
        ...draft.members.slice(index + 1),
      ]
    })
  }

  private setError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.store.update((draft) => { draft.error = message })
  }
}

/** Compose the first-class session id the host bridge uses for member topics. */
function memberSessionId(memberId: string, topicId: string): SessionId {
  return `${MEMBER_SESSION_PREFIX}${memberId}:${topicId}` as SessionId
}
