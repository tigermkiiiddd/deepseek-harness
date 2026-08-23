/**
 * Model-facing todo list: whole-list replacement by default, plus optional delta actions
 * (`merge` / `remove` / `clear`) that update only specific tasks. Each call appends a `todo/write`
 * snapshot to the calling agent's session; replay is last-write-wins, and UIs render from session
 * events. A non-agent caller has no owning list and is rejected. Named exports preserve loader
 * injection metadata.
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session, TodoItem } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `todos` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

export const name = 'tool-todo'
export const inject = ['tools']

/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed'] as const

/** The delta-action discriminant the model may pass; omitted (or `replace`) means full-list replacement. */
export type TodoAction = 'replace' | 'clear' | 'merge' | 'remove'

/** Schemastery configuration for the todo tool consumer. */
export interface Config {
  /**
   * Required deployment choice for whether several todos may be `in_progress` at once. True suits
   * agents that run work concurrently — subagents, background commands, workflow fan-out — and the
   * description then instructs the model to mark every actively worked task. False restores the
   * single-active discipline: the description asks for exactly one, and a call marking more is
   * rejected.
   */
  allowParallelInProgress: boolean
}

/** Schemastery configuration for the todo tool consumer. */
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})

const DESCRIPTION_HEAD =
  'Record and update a structured task list for the current work. UPDATE specific tasks '
  + 'with a delta instead of resending the whole list: use `action` — `merge` upserts each '
  + 'entry by `content` (adds new tasks, updates the `status` of tasks that already exist), '
  + '`remove` deletes the listed tasks, and `clear` empties the list; each delta merges '
  + 'onto the current list. ONLY send the COMPLETE list with `action: replace` when the '
  + 'task direction changes significantly, for example when the plan is restructured. '
  + 'Keep the list current as work progresses. Use it to plan multi-step work: add one '
  + 'todo per concrete step before you start. '

const DESCRIPTION_PARALLEL =
  'Mark every todo being actively worked '
  + 'on `in_progress` — several at once when work genuinely runs in parallel (e.g. '
  + 'concurrent subagents or background commands), one for sequential work; while '
  + 'work remains, at least one task should be `in_progress`. '

const DESCRIPTION_SINGLE =
  'Keep AT MOST ONE todo `in_progress` at a '
  + 'time; while work remains, exactly one active task should be `in_progress`. '

const DESCRIPTION_TAIL =
  'Mark a todo '
  + '`completed` the moment it is done (do not batch completions), and allow no '
  + '`in_progress` item only once all work is complete. Skip the list for trivial '
  + 'single-step tasks. Statuses: `pending` (not started), `in_progress` (being '
  + 'worked on now), `completed` (finished).'

/**
 * The model-facing description for one activation. The active-status clause is the only part that
 * varies, because it is the only instruction the parallel policy changes.
 * @param allowParallel - whether several todos may be `in_progress` at once.
 * @returns the composed tool description.
 */
function describe(allowParallel: boolean): string {
  return DESCRIPTION_HEAD
    + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE)
    + DESCRIPTION_TAIL
}

/**
 * Validate and trim a raw todo delta: each entry must be non-empty, unique, and already
 * status-checked. Deliberately does NOT count `in_progress` items — a delta may legitimately add
 * one active task even when another already exists, and the active-count rule applies to the
 * *resulting* list, not the delta. The registry has already rejected an unknown `content`/`status`
 * shape, so the recorded casts express that guarantee.
 * @param raw - the model-supplied list, already schema-checked.
 * @returns the cleaned canonical list.
 */
function normalize(raw: { content: string; status: string }[]): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    }
    seen.add(content)
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  return todos
}

/**
 * Reject any list carrying more than one `in_progress` item unless the deployment allows parallel
 * work, preserving the deployment's single-active discipline on every action's result.
 * @param todos - the resulting full list about to be logged.
 * @param allowParallel - the deployment's parallel-active policy.
 */
function assertSingleActive(todos: TodoItem[], allowParallel: boolean): void {
  let active = 0
  for (const todo of todos) {
    if (todo.status === 'in_progress') active++
  }
  if (!allowParallel && active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  }
}

/**
 * The durable current list: the latest whole `todo/write` snapshot, or `[]` before the first
 * write. Merge actions build on this so the agent need not resend the entire list.
 * @param session - the calling agent's session, read back to its latest todo snapshot.
 * @returns a copy of the current todo entries.
 */
function currentTodoList(session: Session): TodoItem[] {
  const last = session.events.findLast(event => event.type === 'todo/write')
  return last ? last.data.todos.map(todo => ({ content: todo.content, status: todo.status })) : []
}

/**
 * Upsert-by-content: update the `status` of matched entries in place, append newly added entries,
 * and preserve the existing order of untouched entries.
 * @param current - the durable current list.
 * @param delta - the normalized entries to merge in.
 * @returns the merged full list.
 */
function mergeInto(current: TodoItem[], delta: TodoItem[]): TodoItem[] {
  const byContent = new Map(delta.map(todo => [todo.content, todo] as const))
  const merged = current.map(todo => byContent.get(todo.content) ?? todo)
  for (const todo of delta) {
    if (!current.some(existing => existing.content === todo.content)) merged.push(todo)
  }
  return merged
}

/**
 * For `replace` / `merge` / `remove` the model must supply the `todos` array; `clear` ignores it.
 * @param args - the tool call arguments, already schema-checked.
 * @param action - the chosen action, used only to phrase the missing-argument error.
 * @returns the present `todos` array.
 */
function takeTodos(args: { todos?: TodoItem[] }, action: TodoAction): TodoItem[] {
  if (args.todos === undefined) {
    throw new Error(`todo_write requires a \`todos\` array for action "${action}"`)
  }
  return args.todos
}

/** Wire payload schema of the `todos` projection (whole list or pre-first-write null). */
const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

/**
 * Register the `todo_write` tool on `ctx.tools` and, when the session-projection seam is composed,
 * the `todos` unit.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit todo policy.
 */
export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
  // The unit child activates only when a projection registry is composed
  // (headless assemblies without the seam stay unaffected). Standing-plan fold:
  // latest whole todo/write list, cleared by the next turn/start (turn/end keeps
  // the finished checklist visible); null before the first write or after a
  // later turn begins; every other event returns the same state reference.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'todos', TodoItem[] | null>({
      key: 'todos',
      stateSchema: todosProjectionSchema,
      init: () => null,
      apply: (state, event) => {
        if (event.type === 'todo/write') return event.data.todos
        if (event.type === 'turn/start') return null
        return state
      },
      wire: { viewSchema: todosProjectionSchema, view: state => state },
      stateVersion: 2,
    })
  })
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      action: {
        type: 'string',
        enum: ['replace', 'clear', 'merge', 'remove'],
        description: 'replace (default): the whole list, replacing the previous one. '
          + 'merge: upsert each entry by content (add new tasks, update the status of existing '
          + 'tasks). remove: delete the listed contents. clear: empty the list. Each delta '
          + 'operates on the current list (the latest todo/write).',
      },
      todos: {
        type: 'array',
        description: 'Task entries to change. replace (default): the COMPLETE list replacing the '
          + 'previous one. merge: a delta to add entries or update their status (matched by '
          + 'content). remove: the content values to delete (status ignored). Omit for clear.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
              enum: [...STATUSES],
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...STATUSES] },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      const action = args.action ?? 'replace'
      const current = currentTodoList(exec.agent.session)
      let todos: TodoItem[]
      if (action === 'clear') {
        todos = []
      } else {
        const delta = normalize(takeTodos(args, action))
        if (action === 'merge') {
          todos = mergeInto(current, delta)
        } else if (action === 'remove') {
          const remove = new Set(delta.map(todo => todo.content))
          todos = current.filter(todo => !remove.has(todo.content))
        } else {
          todos = delta
        }
      }
      assertSingleActive(todos, allowParallel)
      exec.agent.session.append('todo/write', { todos })
      const count = (status: TodoItem['status']): number => todos.filter(todo => todo.status === status).length
      return Promise.resolve({
        todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args }),
  }))
}
