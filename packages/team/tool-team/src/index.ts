/**
 * Model-facing team tools: enumerate the team members and each member's own
 * conversation topics, and chat with a member on a chosen topic (or a new
 * one). The member process owns its sessions; these tools only read and drive
 * them through the ACP wire.
 *
 * @module @deepseek-ai/dsh-tool-team
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamService } from '@deepseek-ai/dsh-team'

export const name = 'tool-team'
export const inject = ['team', 'tools']

/**
 * Mount the member tools.
 * @param ctx - Cordis context carrying the team service and tool registry.
 */
export function apply(ctx: Context): void {
  const team = ctx.get('team') as TeamService

  ctx.tools.register(defineTool({
    name: 'member_sessions',
    description: 'List the team members and each member\'s own conversation topics. Use the returned topic ids with member_chat to continue a topic or start a new one.',
    parameters: {
      member_id: {
        type: 'string',
        description: 'Optional member id; omit to list every member.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: { member_id?: string }) {
      const members = team.list().filter(member => args.member_id === undefined || member.id === args.member_id)
      if (members.length === 0) {
        return `No team members${args.member_id === undefined ? '' : ` matching "${args.member_id}"`} are configured.`
      }
      const lines: string[] = []
      for (const member of members) {
        lines.push(`## ${member.title} (${member.id}) — ${member.status}${member.description === undefined ? '' : ` — ${member.description}`}`)
        try {
          const sessions = await team.listSessions(member.id)
          if (sessions.length === 0) {
            lines.push('  (no topics yet — start one with member_chat and new_topic)')
          } else {
            for (const session of sessions) {
              lines.push(`  - ${session.sessionId}  (${session.cwd})`)
            }
          }
        } catch (error: unknown) {
          lines.push(`  (unavailable: ${error instanceof Error ? error.message : String(error)})`)
        }
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'member_chat',
    description: 'Chat with a team member on one of its topics. Pass an existing topic id from member_sessions to continue that conversation, or set new_topic to start a fresh topic on the member. Returns the member\'s full reply.',
    parameters: {
      member_id: {
        type: 'string',
        required: true,
        description: 'The member to talk to.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Your message to the member.',
      },
      topic: {
        type: 'string',
        description: 'The member\'s topic id to continue (from member_sessions).',
      },
      new_topic: {
        type: 'boolean',
        description: 'Start a new topic on the member instead of continuing one.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: { member_id: string; text: string; topic?: string; new_topic?: boolean }) {
      if (args.new_topic === true && args.topic !== undefined) {
        throw new Error('member_chat: pass either topic or new_topic, not both')
      }
      if (args.new_topic !== true && args.topic === undefined) {
        throw new Error('member_chat: pass a topic id from member_sessions, or set new_topic: true to start a new topic')
      }
      const sessionId = args.new_topic === true
        ? await team.newSession(args.member_id)
        : args.topic as string
      const result = await team.chat(args.member_id, sessionId, args.text)
      if (result.stopReason !== 'end_turn' && result.stopReason !== 'max_tokens') {
        return `Member ${args.member_id} stopped with ${result.stopReason}.\n${result.text}`
      }
      return result.text
    },
  }))
}
