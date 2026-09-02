/** Generated-Remote owner for the browser-facing Team management operations. */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamService } from './index.ts'
import type { MemberConfigInput, MemberSnapshot, TeamMemberRow, TeamSessionRow } from './types.ts'

function memberRow(member: MemberSnapshot): TeamMemberRow {
  return {
    id: member.id,
    title: member.title,
    description: member.description ?? null,
    kind: member.kind ?? null,
    status: member.status,
    autostart: member.autostart,
    lastError: member.lastError ?? null,
    model: member.model ?? null,
  }
}

/** Host service backing the generated `ctx.remote.team` namespace. */
export class TeamRemoteService extends TypertRemoteService {
  static inject = ['team']

  private readonly team: TeamService

  /** @param ctx - Host context carrying the Team process service. */
  constructor(ctx: Context) {
    super(ctx, 'teamRemote', { namespace: 'team' })
    this.team = ctx.team
  }

  /** @returns the current member roster. */
  @Remote('list')
  list(): TeamMemberRow[] {
    return this.team.list().map(memberRow)
  }

  /** @param memberId - member process to start. */
  @Remote('start')
  async start(memberId: string): Promise<void> {
    await this.team.start(memberId)
  }

  /** @param memberId - member process to stop. */
  @Remote('stop')
  async stop(memberId: string): Promise<void> {
    await this.team.stop(memberId)
  }

  /** @param memberId - member process to restart. */
  @Remote('restart')
  async restart(memberId: string): Promise<void> {
    await this.team.restart(memberId)
  }

  /**
   * @param memberId - member whose topics are listed.
   * @returns the member's browser-selectable topics.
   */
  @Remote('sessions')
  async sessions(memberId: string): Promise<TeamSessionRow[]> {
    const sessions = await this.team.listSessions(memberId)
    return sessions.map(({ sessionId, cwd }) => ({ sessionId, cwd }))
  }

  /**
   * @param memberId - member that owns the new topic.
   * @returns the created topic id.
   */
  @Remote('newSession')
  async newSession(memberId: string): Promise<string> {
    return await this.team.newSession(memberId)
  }

  /**
   * @param config - member process configuration.
   * @returns the joined member row.
   */
  @Remote('addMember')
  async addMember(config: MemberConfigInput): Promise<TeamMemberRow> {
    return memberRow(await this.team.addMember(config))
  }

  /** @param memberId - member to stop and remove. */
  @Remote('removeMember')
  async removeMember(memberId: string): Promise<void> {
    await this.team.removeMember(memberId)
  }
}

export default TeamRemoteService
