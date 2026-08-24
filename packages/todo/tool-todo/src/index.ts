/**
 * Model-facing todo list with an indexed read tool and index-addressed write actions. Each write
 * appends a `todo/write` snapshot to the calling agent's session; replay is last-write-wins, and
 * UIs render from session events. A non-agent caller has no owning list and is rejected. Named
 * exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
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

/** The required write-action discriminant. */
export type TodoAction = 'add' | 'update' | 'remove' | 'clear'

/** One index-addressed update against the current todo list. */
interface TodoUpdate {
  index: number
  content?: string
  status?: TodoItem['status']
}

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
  'Record and update a structured task list for the current work without resending the whole list. '
  + 'The `action` is REQUIRED: `add` appends new `todos`; `update` changes existing entries '
  + 'using zero-based `updates[].index`; `remove` deletes zero-based `indices`; and `clear` empties '
  + 'the list. Indices always refer to the current ordered list before that call. `update` never '
  + 'adds a task, and an invalid index fails instead of appending. There is no whole-list replace. '
  + 'Call `todo_read` before `update` or `remove` whenever the latest indexed list is not visible. '
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
 * Validate and trim complete todo entries. The active-count rule applies to the resulting list,
 * after the selected action has run. The registry has already rejected an unknown
 * `content`/`status` field set, so the status cast records that guarantee.
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

/** Reject repeated display content in a resulting list. */
function assertUniqueContent(todos: readonly TodoItem[]): void {
  const seen = new Set<string>()
  for (const todo of todos) {
    if (seen.has(todo.content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(todo.content)}`)
    }
    seen.add(todo.content)
  }
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
 * The durable current list: the latest whole `todo/write` snapshot after the current
 * `turn/start`, or `[]` before this turn's first write. Delta actions build on this so the agent
 * need not resend the entire list.
 * @param session - the calling agent's session, read back to its latest todo snapshot.
 * @returns a copy of the current todo entries.
 */
function currentTodoList(session: Session): TodoItem[] {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event === undefined) continue
    if (event.type === 'todo/write') {
      return event.data.todos.map(todo => ({ content: todo.content, status: todo.status }))
    }
    if (event.type === 'turn/start') return []
  }
  return []
}

/**
 * Apply index-addressed changes without changing list length or order.
 * @param current - the durable current list.
 * @param updates - changes whose indices address `current` before this call.
 * @returns the updated full list.
 */
function updateAtIndices(current: TodoItem[], updates: TodoUpdate[]): TodoItem[] {
  const result = current.map(todo => ({ ...todo }))
  const seen = new Set<number>()
  for (const update of updates) {
    const existing = current[update.index]
    if (existing === undefined) {
      throw new Error(`invalid todo index ${update.index}: current list has ${current.length} entries`)
    }
    if (seen.has(update.index)) {
      throw new Error(`invalid todo updates: duplicate index ${update.index}`)
    }
    seen.add(update.index)
    if (update.content === undefined && update.status === undefined) {
      throw new Error(`invalid todo update at index ${update.index}: provide content or status`)
    }
    const content = update.content?.trim()
    if (content !== undefined && content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    result[update.index] = {
      content: content ?? existing.content,
      status: update.status ?? existing.status,
    }
  }
  return result
}

/**
 * Read the todo entries required by `add`.
 * @param args - the tool call arguments, already schema-checked.
 * @param action - the selected todo-list action.
 * @returns the present `todos` array.
 */
function takeTodos(args: { todos?: TodoItem[] }): TodoItem[] {
  if (args.todos === undefined) {
    throw new Error('todo_write requires a `todos` array for action "add"')
  }
  return args.todos
}

/** Read the changes required by `update`. */
function takeUpdates(args: { updates?: TodoUpdate[] }): TodoUpdate[] {
  if (args.updates === undefined || args.updates.length === 0) {
    throw new Error('todo_write requires a non-empty `updates` array for action "update"')
  }
  return args.updates
}

/** Read the indices required by `remove`. */
function takeIndices(args: { indices?: number[] }): number[] {
  if (args.indices === undefined || args.indices.length === 0) {
    throw new Error('todo_write requires a non-empty `indices` array for action "remove"')
  }
  return args.indices
}

/** Remove entries by their indices in the current list. */
function removeAtIndices(current: TodoItem[], indices: number[]): TodoItem[] {
  const selected = new Set<number>()
  for (const index of indices) {
    if (index < 0 || index >= current.length) {
      throw new Error(`invalid todo index ${index}: current list has ${current.length} entries`)
    }
    if (selected.has(index)) throw new Error(`invalid todo indices: duplicate index ${index}`)
    selected.add(index)
  }
  return current.filter((_todo, index) => !selected.has(index))
}

/** Closed-union backstop for todo actions. */
/* v8 ignore next 3 -- the input schema rejects actions outside this closed union. */
function assertNever(value: never): never {
  throw new Error(`unreachable todo action: ${String(value)}`)
}

interface TodoResult {
  todos: TodoItem[]
  counts: {
    pending: number
    inProgress: number
    completed: number
  }
}

/** Build the canonical result shared by reads and writes. */
function todoResult(todos: TodoItem[]): TodoResult {
  const count = (status: TodoItem['status']): number => todos.filter(todo => todo.status === status).length
  return {
    todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
    counts: {
      pending: count('pending'),
      inProgress: count('in_progress'),
      completed: count('completed'),
    },
  }
}

/** Render the complete current list with operation indices for the model. */
function indexedTodoText(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'Current todo list: []'
  const entries = todos.map((todo, index) => `${index} [${todo.status}] ${JSON.stringify(todo.content)}`)
  return `Current todo list (zero-based indices):\n${entries.join('\n')}`
}

/** The result fields shared by todo_read and todo_write. */
const TODO_RESULT_SCHEMA = {
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
} as const satisfies ValueSchemaSpec

/** Wire payload schema of the `todos` projection (whole list or pre-first-write null). */
const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

/**
 * Register the `todo_read` and `todo_write` tools on `ctx.tools` and, when the
 * session-projection seam is composed, the `todos` unit.
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
    name: 'todo_read',
    description: 'Read the current ordered task list with zero-based indices. Call this before '
      + '`todo_write` update or remove whenever the latest indexed list is not visible, including '
      + 'after compaction. Never guess an index.',
    parameters: {},
    output: {
      schema: TODO_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: indexedTodoText(value.todos) }],
    },
    execute(_args, exec) {
      if (!exec.agent) throw new Error('todo_read requires an owning agent session')
      return Promise.resolve(todoResult(currentTodoList(exec.agent.session)))
    },
    presentCall: () => ({ card: 'generic', title: 'Read todo list', kind: 'other', rawInput: {} }),
  }))
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'update', 'remove', 'clear'],
        description: 'add: append `todos`. update: change entries addressed by zero-based '
          + '`updates[].index`. remove: delete entries addressed by zero-based `indices`. clear: '
          + 'empty the list. Whole-list replacement is not supported.',
      },
      todos: {
        type: 'array',
        description: 'New task entries. Required by add; omitted by update, remove, and clear.',
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
      updates: {
        type: 'array',
        description: 'Changes for action update. Each zero-based index addresses the current list '
          + 'before this call; provide content, status, or both. Updating never appends.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer', required: true, description: 'Zero-based current-list index.' },
            content: { type: 'string', description: 'Replacement task text. Omit to keep it.' },
            status: {
              type: 'string',
              enum: [...STATUSES],
              description: 'Replacement lifecycle state. Omit to keep it.',
            },
          },
        },
      },
      indices: {
        type: 'array',
        description: 'Zero-based current-list indices to delete for action remove.',
        items: { type: 'integer' },
      },
    },
    output: {
      schema: TODO_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.\n${indexedTodoText(value.todos)}`,
      }],
    },
    execute(args, exec) {
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      const action = args.action
      const current = currentTodoList(exec.agent.session)
      let todos: TodoItem[]
      switch (action) {
        case 'add':
          todos = [...current, ...normalize(takeTodos(args))]
          break
        case 'update':
          todos = updateAtIndices(current, takeUpdates(args))
          break
        case 'remove':
          todos = removeAtIndices(current, takeIndices(args))
          break
        case 'clear':
          todos = []
          break
        /* v8 ignore next 2 -- the input schema rejects actions outside this closed union. */
        default:
          return assertNever(action)
      }
      assertUniqueContent(todos)
      assertSingleActive(todos, allowParallel)
      exec.agent.session.append('todo/write', { todos })
      return Promise.resolve(todoResult(todos))
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args }),
  }))
}
