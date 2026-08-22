/**
 * Model-facing team tools: enumerate the team members and each member's own
 * conversation topics, chat with a member on a chosen topic (or a new one),
 * and manage the roster and member lifecycle (add / remove / start / stop /
 * restart). The member process owns its sessions; these tools only read and
 * drive them through the ACP wire. The tools are a permanent team capability:
 * they resolve the host `team` service and need no preset.
 *
 * @module @deepseek-ai/dsh-tool-team
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamService } from '@deepseek-ai/dsh-team'

export const name = 'tool-team'
export const inject = ['team', 'tools']

/** The model option id the harness targets when setting a member's model. */
const MODEL_CONFIG_ID = 'model'

/**
 * Render a value id with its label when the option set names it, so the model
 * sees `mock-model-1 (Mock Model 1)` rather than a bare id.
 * @param value - the value id to render.
 * @param options - the selectable options to look the label up in.
 * @returns the value id, or the id with its label in parentheses.
 */
function optionLabel(
  value: string,
  options: readonly { readonly value: string; readonly name: string }[],
): string {
  const match = options.find(option => option.value === value)
  return match === undefined ? value : `${value} (${match.name})`
}

/**
 * Validate a headers object: every value must be a string, so no non-string
 * payload reaches the ACP wire.
 * @param headers - the raw headers map from tool arguments.
 * @param tool - the tool name, for the error message.
 * @returns the headers as a string map, or `undefined` when none were given.
 */
function headerRecord(headers: Record<string, unknown>, tool: string): Record<string, string> | undefined {
  if (headers === undefined || Object.keys(headers).length === 0) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      throw new Error(`${tool}: header "${key}" must be a string`)
    }
  }
  return headers as Record<string, string>
}

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
        const capability = member.capabilities?.loadSession === true ? 'loadSession' : 'no loadSession'
        const model = member.model === undefined ? '' : ` — model: ${member.model}`
        lines.push(`## ${member.title} (${member.id}) — ${member.status}${model} — ${capability}${member.description === undefined ? '' : ` — ${member.description}`}`)
        if (member.status === 'offline' || member.status === 'failed') {
          lines.push(`  (${member.status === 'failed' && member.lastError !== undefined ? `failed: ${member.lastError}` : 'not running — use member_start to start it'})`)
          continue
        }
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
    async execute(args: { member_id: string; text: string; topic?: string; new_topic?: boolean }, exec) {
      if (args.new_topic === true && args.topic !== undefined) {
        throw new Error('member_chat: pass either topic or new_topic, not both')
      }
      if (args.new_topic !== true && args.topic === undefined) {
        throw new Error('member_chat: pass a topic id from member_sessions, or set new_topic: true to start a new topic')
      }
      const sessionId = args.new_topic === true
        ? await team.newSession(args.member_id)
        : args.topic as string
      // The tool's cancellation signal drives the member's ACP cancel, so a
      // cancelled tool call stops the member's turn instead of leaking it.
      const result = await team.chat(args.member_id, sessionId, args.text, exec.signal)
      if (result.stopReason !== 'end_turn' && result.stopReason !== 'max_tokens') {
        return `Member ${args.member_id} stopped with ${result.stopReason}.\n${result.text}`
      }
      return result.text
    },
  }))

  ctx.tools.register(defineTool({
    name: 'member_add',
    description: 'Add a new team member at runtime: spawn its ACP agent process, persist it in the team roster, and join it to the team. The member is re-spawned automatically after a host restart (unless autostart is false). Use member_remove to tear it down and forget it.',
    parameters: {
      member_id: {
        type: 'string',
        required: true,
        description: 'Stable member id, unique within the team.',
      },
      title: {
        type: 'string',
        description: 'Display name shown in the team view.',
      },
      description: {
        type: 'string',
        description: 'One-line role or persona description.',
      },
      kind: {
        type: 'string',
        enum: ['dsh'],
        description: 'Member kind: "dsh" relaunches the current harness installation as an ACP server; command and args must be omitted.',
      },
      command: {
        type: 'string',
        description: 'Executable that runs an ACP agent (any ACP server). Required unless kind is "dsh".',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments passed to the member command.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the member process and its sessions; omit to use the harness launch directory.',
      },
      env: {
        type: 'object',
        additionalProperties: true,
        description: 'Extra environment variables layered over the full parent environment (credentials included); every value must be a string.',
      },
      permission: {
        type: 'string',
        enum: ['allow', 'reject'],
        description: 'Auto-answer the member\'s permission prompts with this policy when no GUI subscriber answers them.',
      },
      autostart: {
        type: 'boolean',
        description: 'Start the member now and on every host restart (default true).',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: {
      member_id: string
      title?: string
      description?: string
      kind?: 'dsh'
      command?: string
      args?: string[]
      cwd?: string
      env?: Record<string, unknown>
      permission?: 'allow' | 'reject'
      autostart?: boolean
    }) {
      if (args.env !== undefined) {
        for (const [key, value] of Object.entries(args.env)) {
          if (typeof value !== 'string') {
            throw new Error(`member_add: env value for "${key}" must be a string`)
          }
        }
      }
      const env = args.env as Record<string, string> | undefined
      const snapshot = await team.addMember({
        id: args.member_id,
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...args.kind === 'dsh' ? {} : { command: args.command as string },
        ...args.title === undefined ? {} : { title: args.title },
        ...args.description === undefined ? {} : { description: args.description },
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        ...env === undefined ? {} : { env },
        ...args.permission === undefined ? {} : { permission: args.permission },
        ...args.autostart === undefined ? {} : { autostart: args.autostart },
        args: args.args ?? [],
      })
      return `Member ${snapshot.id} (${snapshot.title}) joined the team; connection status: ${snapshot.status}. Use member_sessions to see its topics and member_chat to talk to it.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'member_remove',
    description: 'Remove a team member: tear down its process, drop it from the roster, and delete its persisted roster record. The member\'s own sessions stay with the member; adding the same id later spawns a fresh process. A member that is also declared in the deployment config reappears at the next restart.',
    parameters: {
      member_id: {
        type: 'string',
        required: true,
        description: 'The member to remove.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: { member_id: string }) {
      await team.removeMember(args.member_id)
      return `Member ${args.member_id} was removed from the team; its process was torn down and its roster record deleted.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'member_start',
    description: 'Start a team member: spawn its ACP agent process and complete the protocol handshake. Idempotent — starting a running member settles immediately. Members autostart by default; use this to bring a stopped or failed member back up.',
    parameters: {
      member_id: {
        type: 'string',
        required: true,
        description: 'The member to start.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: { member_id: string }) {
      await team.start(args.member_id)
      const member = team.list().find(candidate => candidate.id === args.member_id)
      return `Member ${args.member_id} started; connection status: ${member?.status ?? 'unknown'}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'member_stop',
    description: 'Stop a team member: tear down its process and return it to offline. The member\'s own sessions stay with the member and remain listable after a later start.',
    parameters: {
      member_id: {
        type: 'string',
        required: true,
        description: 'The member to stop.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: { member_id: string }) {
      await team.stop(args.member_id)
      return `Member ${args.member_id} stopped; its process was torn down.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'member_restart',
    description: 'Restart a team member: stop its process, then start it again. Use after a member is offline or misbehaving.',
    parameters: {
      member_id: {
        type: 'string',
        required: true,
        description: 'The member to restart.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: { member_id: string }) {
      await team.restart(args.member_id)
      const member = team.list().find(candidate => candidate.id === args.member_id)
      return `Member ${args.member_id} restarted; connection status: ${member?.status ?? 'unknown'}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'member_model',
    description: 'Query or set a team member\'s session model configuration. Use action "get" to read the current model and its selectable options, or "set" to switch the model to one of those value ids. Requires a session id from member_sessions; create one with member_chat new_topic first. The member must advertise session config options, otherwise the call reports it.',
    parameters: {
      member_id: {
        type: 'string',
        required: true,
        description: 'The member whose model config is read or set.',
      },
      session_id: {
        type: 'string',
        required: true,
        description: 'The member session (topic) id from member_sessions.',
      },
      action: {
        type: 'string',
        enum: ['get', 'set'],
        description: '"get" reads the current model and its options (default); "set" switches the model to value.',
      },
      value: {
        type: 'string',
        description: 'The model value id to set (action "set"); pick one from a prior "get".',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: { member_id: string; session_id: string; action?: 'get' | 'set'; value?: string }) {
      const where = `Member ${args.member_id} session ${args.session_id}`
      if (args.action === 'set') {
        if (args.value === undefined) {
          throw new Error('member_model set: pass value, the model value id from a prior "get".')
        }
        try {
          const snapshot = await team.setConfig(args.member_id, args.session_id, MODEL_CONFIG_ID, args.value)
          const model = snapshot.model
          const label = model === undefined
            ? args.value
            : optionLabel(args.value, model.options)
          return `Set model to ${label} on ${where}.`
        } catch (error: unknown) {
          return `${where}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      try {
        const snapshot = await team.getConfig(args.member_id, args.session_id)
        const lines: string[] = []
        const model = snapshot.model
        if (model !== undefined) {
          lines.push(`current model: ${optionLabel(model.currentValue, model.options)}`)
          for (const option of model.options) {
            lines.push(`  - ${option.value} (${option.name})`)
          }
        } else {
          for (const option of snapshot.options) {
            lines.push(`  - ${option.id}${option.category === undefined ? '' : ` [${option.category}]`}`)
          }
        }
        return `${where}\n${lines.join('\n')}`
      } catch (error: unknown) {
        return `${where}: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'member_provider',
    description: 'List or set a team member\'s ACP provider configuration. Use action "list" to read the advertised providers, or "set" to configure one (id, api_type, base_url, optional headers). Requires the member to advertise the providers capability, otherwise the call reports it.',
    parameters: {
      member_id: {
        type: 'string',
        required: true,
        description: 'The member whose providers are listed or set.',
      },
      action: {
        type: 'string',
        enum: ['list', 'set'],
        default: 'list',
        description: '"list" reads the advertised providers (default); "set" configures one.',
      },
      id: {
        type: 'string',
        description: 'Provider id (action "set").',
      },
      api_type: {
        type: 'string',
        description: 'Protocol: anthropic/openai/azure/vertex/bedrock (action "set").',
      },
      base_url: {
        type: 'string',
        description: 'Base URL for the provider (action "set").',
      },
      headers: {
        type: 'object',
        additionalProperties: true,
        description: 'Headers map for the provider (action "set"); every value must be a string.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: {
      member_id: string
      action?: 'list' | 'set'
      id?: string
      api_type?: string
      base_url?: string
      headers?: Record<string, unknown>
    }) {
      if (args.action === 'set') {
        if (args.id === undefined || args.api_type === undefined || args.base_url === undefined) {
          throw new Error('member_provider set: pass id, api_type, and base_url.')
        }
        const headers = args.headers === undefined
          ? undefined
          : headerRecord(args.headers, 'member_provider')
        try {
          await team.setProvider(args.member_id, {
            id: args.id,
            apiType: args.api_type,
            baseUrl: args.base_url,
            headers,
          })
          return `Set provider ${args.id} (api_type=${args.api_type}, base_url=${args.base_url}) on member ${args.member_id}.`
        } catch (error: unknown) {
          return `Member ${args.member_id}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      try {
        const providers = await team.listProviders(args.member_id)
        if (providers.length === 0) {
          return `Member ${args.member_id}: no providers.`
        }
        const lines = providers.map((provider) => {
          const current = provider.current === undefined
            ? '(disabled)'
            : `${provider.current.apiType} ${provider.current.baseUrl}`
          return `  - ${provider.id} required=${provider.required} ${current}`
        })
        return `Member ${args.member_id} providers:\n${lines.join('\n')}`
      } catch (error: unknown) {
        return `Member ${args.member_id}: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }))
}
