import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import { type Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-todo` on a real `ToolRuntime`
 * and invokes the registered `todo_write` tool through `ctx.tools.execute`,
 * with a fake parent Agent carrying a real `Session` — so the append the tool
 * makes is observable on a genuine session log (only the agent wrapper is a
 * stand-in; the session and the tool are the shipping code).
 */

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(allowParallelInProgress: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, { allowParallelInProgress })
  return ctx
}

let callCounter = 0
function callTodo(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'todo_write',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function readTodos(ctx: Context, agent: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'todo_read',
    arguments: {},
    agent,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-todo', () => {
  it('keeps current indices model-visible and removes whole-list replacement', async () => {
    const ctx = await setup(true)
    const schema = ctx.tools.schemas().find(entry => entry.name === 'todo_write')!
    const parameters = schema.parameters as { required?: string[]; properties?: Record<string, unknown> }
    const action = parameters.properties?.action as { enum?: string[] }
    expect(parameters.required).toContain('action')
    expect(action.enum).toEqual(['add', 'update', 'remove', 'clear'])
    expect(ctx.tools.schemas().some(entry => entry.name === 'todo_read')).toBe(true)

    const agent = agentWithSession('model-visible-indices')
    const added = await callTodo(ctx, {
      action: 'add',
      todos: [
        { content: 'plan', status: 'in_progress' },
        { content: 'build', status: 'pending' },
      ],
    }, { agent })
    expect(text(added)).toContain('0 [in_progress] "plan"')
    expect(text(added)).toContain('1 [pending] "build"')

    const read = await readTodos(ctx, agent)
    expect(read.isError).toBe(false)
    expect(text(read)).toContain('0 [in_progress] "plan"')
    expect(text(read)).toContain('1 [pending] "build"')

    const replace = await callTodo(ctx, {
      action: 'replace',
      todos: [{ content: 'replacement', status: 'in_progress' }],
    }, { agent })
    expect(replace.isError).toBe(true)
  })

  it('registers index-addressed todo actions and their argument collections', async () => {
    const ctx = await setup(true)
    const schema = ctx.tools.schemas().find(s => s.name === 'todo_write')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['action', 'todos', 'updates', 'indices'])
    const action = props.action as { type?: string; enum?: unknown[] }
    expect(action.type).toBe('string')
    expect(action.enum).toEqual(['add', 'update', 'remove', 'clear'])
    const todos = props.todos as { type: string; items?: { properties?: Record<string, { type: string; enum?: string[] }> } }
    expect(todos.type).toBe('array')
    const itemProps = todos.items?.properties ?? {}
    expect(Object.keys(itemProps).sort()).toEqual(['content', 'status'])
    expect(itemProps.status?.enum).toEqual(['pending', 'in_progress', 'completed'])
    const updates = props.updates as { items?: { properties?: Record<string, { type: string; enum?: string[] }> } }
    expect(Object.keys(updates.items?.properties ?? {}).sort()).toEqual(['content', 'index', 'status'])
    expect(updates.items?.properties?.index?.type).toBe('integer')
    const indices = props.indices as { items?: { type?: string } }
    expect(indices.items?.type).toBe('integer')
  })

  it('appends a todo/write event carrying the whole list to the calling session', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('writer')
    const todos: TodoItem[] = [
      { content: 'plan', status: 'in_progress' },
      { content: 'build', status: 'pending' },
    ]
    const result = await callTodo(ctx, { action: 'add', todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_write success')
    expect(result.value).toEqual({
      todos,
      counts: { pending: 1, inProgress: 1, completed: 0 },
    })
    expect(text(result)).toContain('1 pending, 1 in progress, 0 completed')

    const event = agent.session.events.findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual(todos)
  })

  it('stores the trimmed content (the dedupe/length key), not the raw input', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('trim')
    const result = await callTodo(ctx, { action: 'add', todos: [{ content: '  plan the work  ', status: 'pending' }] }, { agent })
    expect(result.isError).toBe(false)

    const event = agent.session.events.findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual([{ content: 'plan the work', status: 'pending' }])
  })

  it('appends a second batch and logs the complete resulting snapshot', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('writer-2')
    await callTodo(ctx, { action: 'add', todos: [{ content: 'a', status: 'completed' }] }, { agent })
    await callTodo(ctx, { action: 'add', todos: [
      { content: 'b', status: 'in_progress' },
    ] }, { agent })

    const current = agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos
    expect(current).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ])
  })

  it('starts from an empty list after the next turn begins', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('next-turn')
    await callTodo(ctx, { action: 'add', todos: [
      { content: 'old turn', status: 'completed' },
    ] }, { agent })
    agent.session.append('turn/start', { turn: 1 })

    const read = await readTodos(ctx, agent)
    expect(read).toMatchObject({ isError: false, value: { todos: [] } })
    await callTodo(ctx, { action: 'add', todos: [
      { content: 'new turn', status: 'in_progress' },
    ] }, { agent })

    expect(agent.session.events.findLast(event => event.type === 'todo/write')?.data.todos).toEqual([
      { content: 'new turn', status: 'in_progress' },
    ])
  })

  it('rejects a malformed status before execute runs (registry arg-validation)', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { action: 'add', todos: [{ content: 'x', status: 'doing' }] })
    expect(result.isError).toBe(true)
  })

  it('rejects a non-array todos argument', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { action: 'add', todos: 'nope' })
    expect(result.isError).toBe(true)
  })

  it('accepts several in_progress items at once (parallel work)', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('parallel')
    const todos: TodoItem[] = [
      { content: 'run subagent a', status: 'in_progress' },
      { content: 'run subagent b', status: 'in_progress' },
      { content: 'merge results', status: 'pending' },
    ]
    const result = await callTodo(ctx, { action: 'add', todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_write success')
    expect(result.value).toEqual({
      todos,
      counts: { pending: 1, inProgress: 2, completed: 0 },
    })
    expect(agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos).toEqual(todos)
  })

  describe('allowParallelInProgress', () => {
    const parallel = [
      { content: 'run subagent a', status: 'in_progress' },
      { content: 'run subagent b', status: 'in_progress' },
    ]

    it('false rejects a call marking several items in_progress', async () => {
      const ctx = await setup(false)
      const agent = agentWithSession('single-active')
      const result = await callTodo(ctx, { action: 'add', todos: parallel }, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('at most one task may be in_progress')
      // A rejected call must not reach the durable log.
      expect(agent.session.events.some(e => e.type === 'todo/write')).toBe(false)
    })

    it('false still accepts one active item', async () => {
      const ctx = await setup(false)
      const todos: TodoItem[] = [
        { content: 'run subagent a', status: 'in_progress' },
        { content: 'run subagent b', status: 'pending' },
      ]
      const result = await callTodo(ctx, { action: 'add', todos })
      expect(result.isError).toBe(false)
    })

    it('true accepts the very list false rejects', async () => {
      const ctx = await setup(true)
      const result = await callTodo(ctx, { action: 'add', todos: parallel })
      expect(result.isError).toBe(false)
    })

    it('instructs the model to keep at most one active, while true instructs parallel', async () => {
      const single = await setup(false)
      const singleDesc = single.tools.schemas().find(s => s.name === 'todo_write')!.description
      expect(singleDesc).toContain('Keep AT MOST ONE todo `in_progress`')
      expect(singleDesc).not.toContain('several at once')

      const parallelDesc = (await setup(true)).tools.schemas().find(s => s.name === 'todo_write')!.description
      expect(parallelDesc).toContain('several at once when work genuinely runs in parallel')
      expect(parallelDesc).not.toContain('AT MOST ONE')
    })
  })

  describe('delta actions', () => {
    it('updates a task by index without duplicating it when its content changes', async () => {
      const ctx = await setup(true)
      const agent = agentWithSession('update-by-index')
      await callTodo(ctx, { action: 'add', todos: [
        { content: 'write member-home tests', status: 'in_progress' },
        { content: 'run regression tests', status: 'pending' },
      ] }, { agent })

      const result = await callTodo(ctx, {
        action: 'update',
        updates: [{ index: 0, content: 'finish member-home tests (92 passing)', status: 'completed' }],
      }, { agent })

      expect(result.isError).toBe(false)
      expect(agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos).toEqual([
        { content: 'finish member-home tests (92 passing)', status: 'completed' },
        { content: 'run regression tests', status: 'pending' },
      ])
    })

    it('describes index-addressed deltas and makes update non-appending', async () => {
      const desc = (await setup(true)).tools.schemas().find(s => s.name === 'todo_write')!.description
      expect(desc).toContain('zero-based `updates[].index`')
      expect(desc).toContain('`update` never adds a task')
      expect(desc).toContain('fails instead of appending')
    })

    it('clear empties the list, even before the first write', async () => {
      const ctx = await setup(true)
      const agent = agentWithSession('clear')
      const result = await callTodo(ctx, { action: 'clear' }, { agent })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected clear to succeed')
      const cleared = result.value as unknown as { todos: TodoItem[]; counts: { pending: number; inProgress: number; completed: number } }
      expect(cleared.todos).toEqual([])
      expect(cleared.counts).toEqual({ pending: 0, inProgress: 0, completed: 0 })
      expect(agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos).toEqual([])
    })

    it('add appends new tasks without resending the whole list', async () => {
      const ctx = await setup(true)
      const agent = agentWithSession('add')
      await callTodo(ctx, { action: 'add', todos: [{ content: 'plan', status: 'in_progress' }] }, { agent })
      await callTodo(ctx, { action: 'add', todos: [{ content: 'build', status: 'pending' }] }, { agent })
      expect(agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos).toEqual([
        { content: 'plan', status: 'in_progress' },
        { content: 'build', status: 'pending' },
      ])
    })

    it('updates only the supplied fields at each index', async () => {
      const ctx = await setup(true)
      const agent = agentWithSession('partial-update')
      await callTodo(ctx, { action: 'add', todos: [
        { content: 'plan', status: 'in_progress' },
        { content: 'build', status: 'pending' },
      ] }, { agent })
      await callTodo(ctx, { action: 'update', updates: [
        { index: 0, status: 'completed' },
        { index: 1, content: 'build and verify' },
      ] }, { agent })
      expect(agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos).toEqual([
        { content: 'plan', status: 'completed' },
        { content: 'build and verify', status: 'pending' },
      ])
    })

    it('add with no prior todo/write starts from an empty list', async () => {
      const ctx = await setup(true)
      const agent = agentWithSession('add-none')
      const result = await callTodo(ctx, { action: 'add', todos: [{ content: 'first', status: 'in_progress' }] }, { agent })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected add to succeed')
      const added = result.value as unknown as { todos: TodoItem[] }
      expect(added.todos).toEqual([{ content: 'first', status: 'in_progress' }])
    })

    it('remove deletes pre-action indices and preserves the remaining order', async () => {
      const ctx = await setup(true)
      const agent = agentWithSession('remove')
      await callTodo(ctx, { action: 'add', todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
        { content: 'd', status: 'pending' },
      ] }, { agent })
      await callTodo(ctx, { action: 'remove', indices: [1, 3] }, { agent })
      expect(agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos).toEqual([
        { content: 'a', status: 'completed' },
        { content: 'c', status: 'pending' },
      ])
    })

    it('asserts the single-active rule on an added result when not allowParallel', async () => {
      const ctx = await setup(false)
      const agent = agentWithSession('add-single-active')
      await callTodo(ctx, { action: 'add', todos: [{ content: 'a', status: 'in_progress' }] }, { agent })
      const result = await callTodo(ctx, { action: 'add', todos: [{ content: 'b', status: 'in_progress' }] }, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('at most one task may be in_progress')
      // A rejected delta must not change the durable list.
      expect(agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos).toEqual([{ content: 'a', status: 'in_progress' }])
    })

    it('requires a todos array for add', async () => {
      const ctx = await setup(true)
      const agent = agentWithSession('missing-todos')
      const result = await callTodo(ctx, { action: 'add' }, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('requires a `todos` array for action "add"')
      expect(agent.session.events.some(e => e.type === 'todo/write')).toBe(false)
    })

    it.each([
      { label: 'missing updates', args: { action: 'update' }, fragment: 'non-empty `updates`' },
      { label: 'empty updates', args: { action: 'update', updates: [] }, fragment: 'non-empty `updates`' },
      { label: 'missing indices', args: { action: 'remove' }, fragment: 'non-empty `indices`' },
      { label: 'empty indices', args: { action: 'remove', indices: [] }, fragment: 'non-empty `indices`' },
    ])('rejects $label without changing the durable list', async ({ label, args, fragment }) => {
      const ctx = await setup(true)
      const agent = agentWithSession(`invalid-${label}`)
      await callTodo(ctx, { action: 'add', todos: [{ content: 'a', status: 'pending' }] }, { agent })
      const result = await callTodo(ctx, args, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(fragment)
      expect(agent.session.events.filter(e => e.type === 'todo/write')).toHaveLength(1)
    })

    it.each([
      { label: 'negative update index', args: { action: 'update', updates: [{ index: -1, status: 'completed' }] }, fragment: 'invalid todo index -1' },
      { label: 'large update index', args: { action: 'update', updates: [{ index: 1, status: 'completed' }] }, fragment: 'invalid todo index 1' },
      { label: 'duplicate update index', args: { action: 'update', updates: [{ index: 0, status: 'completed' }, { index: 0, content: 'renamed' }] }, fragment: 'duplicate index 0' },
      { label: 'empty update', args: { action: 'update', updates: [{ index: 0 }] }, fragment: 'provide content or status' },
      { label: 'blank update content', args: { action: 'update', updates: [{ index: 0, content: '  ' }] }, fragment: 'non-empty string' },
      { label: 'negative remove index', args: { action: 'remove', indices: [-1] }, fragment: 'invalid todo index -1' },
      { label: 'large remove index', args: { action: 'remove', indices: [1] }, fragment: 'invalid todo index 1' },
      { label: 'duplicate remove index', args: { action: 'remove', indices: [0, 0] }, fragment: 'duplicate index 0' },
    ])('rejects $label instead of appending or guessing', async ({ label, args, fragment }) => {
      const ctx = await setup(true)
      const agent = agentWithSession(`invalid-index-${label}`)
      await callTodo(ctx, { action: 'add', todos: [{ content: 'a', status: 'pending' }] }, { agent })
      const result = await callTodo(ctx, args, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(fragment)
      expect(agent.session.events.filter(e => e.type === 'todo/write')).toHaveLength(1)
    })

    it.each([
      { label: 'add', args: { action: 'add', todos: [{ content: 'a', status: 'completed' }] } },
      { label: 'update', args: { action: 'update', updates: [{ index: 1, content: 'a' }] } },
    ])('rejects duplicate resulting content after $label', async ({ label, args }) => {
      const ctx = await setup(true)
      const agent = agentWithSession(`duplicate-result-${label}`)
      await callTodo(ctx, { action: 'add', todos: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
      ] }, { agent })
      const result = await callTodo(ctx, args, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('duplicate content "a"')
      expect(agent.session.events.filter(e => e.type === 'todo/write')).toHaveLength(1)
    })
  })

  it.each([
    { label: 'empty content', todos: [{ content: '   ', status: 'pending' }], fragment: 'non-empty' },
    { label: 'duplicate content', todos: [{ content: 'dup', status: 'pending' }, { content: 'dup', status: 'completed' }], fragment: 'duplicate' },
    { label: 'unknown item keys', todos: [{ content: 'a', status: 'pending', children: [] }], fragment: 'not a declared property' },
  ])('rejects $label as an isError result', async ({ todos, fragment }) => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { action: 'add', todos })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
  })

  it('rejects a non-agent caller (the list has no owning session)', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { action: 'add', todos: [{ content: 'a', status: 'pending' }] }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('rejects a non-agent todo_read caller', async () => {
    const ctx = await setup(true)
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId(`call-${++callCounter}`),
      name: 'todo_read',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('presents the call with a stable title and the list as raw input', async () => {
    const ctx = await setup(true)
    const def = ctx.tools.get('todo_write')!
    const todos = [{ content: 'a', status: 'pending' }]
    expect(def.presentCall?.({ action: 'add', todos })).toEqual({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: { action: 'add', todos } })
    expect(ctx.tools.get('todo_read')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'Read todo list', kind: 'other', rawInput: {},
    })
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, { allowParallelInProgress: true })
    expect(ctx.tools.schemas().some(s => s.name === 'todo_write')).toBe(true)
    expect(ctx.tools.schemas().some(s => s.name === 'todo_read')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'todo_write')).toBe(false)
    expect(ctx.tools.schemas().some(s => s.name === 'todo_read')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-todo')
    expect(tool.inject).toEqual(['tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-todo')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
