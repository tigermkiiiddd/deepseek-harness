/**
 * One persistent team-member connection: the member's own process speaking ACP
 * on the client side. The member owns its sessions and their history; this
 * connection only spawns the process, lists/loads/creates sessions through the
 * protocol, and drives chat turns. A dead process is respawned on demand and
 * its persisted sessions remain listable and loadable through the member.
 *
 * @module @deepseek-ai/dsh-team/member
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { MemberConfig, MemberSession, MemberStatus, MemberSnapshot } from './types.ts'

/** Cooperative process teardown: EOF window, then termination escalation. */
async function disposeMemberProcess(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  child.stdin?.end()
  const deadline = Date.now() + eofGraceMs
  const exitPromise = child.waitForExit()
  const withinGrace = await Promise.race([
    exitPromise.then(() => true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => { resolve(false) }, Math.max(0, deadline - Date.now()))),
  ])
  if (!withinGrace) {
    child.terminate()
    await exitPromise
  }
}

/** One member process plus its live ACP connection, keyed by member id. */
export class MemberConnection {
  status: MemberStatus = 'closed'
  private child: SubprocessHandle | undefined
  private conn: ClientSideConnection | undefined
  private failedError: string | undefined
  /** Collector for the in-flight chat turn's text chunks (one turn at a time). */
  private chatSink: ((text: string) => void) | undefined
  /** Collector for history chunks streamed during a loadSession replay. */
  private historySink: ((entry: { role: 'user' | 'assistant'; text: string }) => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: MemberConfig,
    private readonly resolveCwd: () => string,
  ) {}

  /** The member's configured identity. */
  snapshot(): MemberSnapshot {
    return {
      id: this.config.id,
      title: this.config.title ?? this.config.id,
      description: this.config.description,
      status: this.status,
    }
  }

  /** The last connection failure's message, for views. */
  lastError(): string | undefined {
    return this.failedError
  }

  /**
   * Establish the member process and connection if absent, respawning after a
   * death. The member's persisted sessions survive respawns.
   */
  private async ensure(): Promise<ClientSideConnection> {
    if (this.conn !== undefined && this.status === 'connected') return this.conn
    this.status = 'connecting'
    this.failedError = undefined
    try {
      const child = this.ctx.subprocess.spawn(this.spawnSpec())
      if (child.stdin === undefined || child.stdout === undefined) {
        throw new Error('team: subprocess implementation dropped a piped protocol stream')
      }
      const spawnFailed: Promise<never> = child.done.then(
        () => new Promise<never>(() => {}),
        (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
      )
      spawnFailed.catch(() => { /* raced below; never unhandled */ })

      const permission = this.config.permission ?? 'reject'
      const conn = new ClientSideConnection(
        () => ({
          sessionUpdate: (notification: SessionNotification): Promise<void> => {
            const update = notification.update
            if (update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text') {
              this.historySink?.({ role: 'user', text: update.content.text })
            } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
              if (this.chatSink !== undefined) {
                this.chatSink(update.content.text)
              } else {
                this.historySink?.({ role: 'assistant', text: update.content.text })
              }
            }
            return Promise.resolve()
          },
          requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
            if (permission === 'allow') {
              const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
              if (allow !== undefined) {
                return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
              }
            }
            return Promise.resolve({ outcome: { outcome: 'cancelled' } })
          },
        }),
        ndJsonStream(
          NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      )
      await Promise.race([
        (async (): Promise<void> => {
          await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        })(),
        spawnFailed,
      ])
      // A transport death (process exit or protocol failure) marks the member
      // closed so the next operation respawns it.
      void conn.closed
        .catch(() => { /* settled below */ })
        .then(() => {
          if (this.conn === conn) this.status = 'closed'
        })
      this.child = child
      this.conn = conn
      this.status = 'connected'
      return conn
    } catch (error: unknown) {
      this.status = 'failed'
      this.failedError = error instanceof Error ? error.message : String(error)
      await this.teardown()
      throw error
    }
  }

  private spawnSpec(): SubprocessSpawnSpec {
    return {
      argv: [this.config.command, ...this.config.args],
      cwd: this.resolveCwd(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      env: this.config.env ?? {},
      graceMs: 3_000,
    }
  }

  /** List the member's own conversation topics, optionally filtered by workspace. */
  async listSessions(cwd?: string): Promise<MemberSession[]> {
    const conn = await this.ensure()
    const response = await conn.listSessions(cwd === undefined ? {} : { cwd })
    return response.sessions.map(session => ({ sessionId: session.sessionId, cwd: session.cwd }))
  }

  /** Resume one of the member's topics so chat continues its history. */
  async loadSession(sessionId: string): Promise<void> {
    const conn = await this.ensure()
    await conn.loadSession({ sessionId, cwd: this.resolveCwd(), mcpServers: [] })
  }

  /**
   * Load one of the member's topics and collect its replayed conversation
   * history (the member's own record of the topic).
   * @param sessionId - the member's session (topic) id.
   * @returns the topic's messages in replay order.
   */
  async readHistory(sessionId: string): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
    const conn = await this.ensure()
    const entries: { role: 'user' | 'assistant'; text: string }[] = []
    this.historySink = entry => entries.push(entry)
    try {
      await conn.loadSession({ sessionId, cwd: this.resolveCwd(), mcpServers: [] })
      return entries
    } finally {
      this.historySink = undefined
    }
  }

  /** Open a new topic on the member. */
  async newSession(): Promise<string> {
    const conn = await this.ensure()
    const session = await conn.newSession({ cwd: this.resolveCwd(), mcpServers: [] })
    return session.sessionId
  }

  /**
   * Drive one chat turn against one of the member's sessions, collecting the
   * committed assistant text.
   * @param sessionId - the member's session (topic) id.
   * @param text - the user-role message.
   * @param signal - cancellation: sends a remote cancel and settles early.
   * @returns the committed text and the ACP stop reason.
   */
  async chat(sessionId: string, text: string, signal?: AbortSignal): Promise<{ text: string; stopReason: StopReason }> {
    const conn = await this.ensure()
    const chunks: string[] = []
    this.chatSink = chunk => chunks.push(chunk)
    try {
      const onAbort = (): void => {
        void conn.cancel({ sessionId }).catch(() => { /* member gone */ })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await conn.prompt({
          sessionId,
          prompt: [{ type: 'text', text }],
        })
        return { text: chunks.join(''), stopReason: response.stopReason }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    } finally {
      this.chatSink = undefined
    }
  }

  /** Tear down the process and connection. Idempotent. */
  async close(): Promise<void> {
    await this.teardown()
    this.status = 'closed'
  }

  private async teardown(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.conn = undefined
    if (child !== undefined) {
      await disposeMemberProcess(child, 2_000)
    }
  }
}
