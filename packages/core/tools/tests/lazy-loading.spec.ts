import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import CodeRuntime from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import ToolRuntime, {
  RUN_CODE_NAME,
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_NAME,
  TOOL_SEARCH_NAME,
  defineTool,
} from '@deepseek-ai/dsh-tools'
import type { Config, ToolDefinition, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createLazyBridgeTools,
  definitionToSdkSchema,
  definitionToToolSchema,
  estimateToolSchemaTokens,
  executeDeferredTool,
  lazyBridgeSdkSchemas,
  renderLazyCatalog,
  resolveLazyLoadingConfig,
  resolveLazyLoadingState,
} from '@deepseek-ai/dsh-tools/src/lazy-loading.ts'

const signal = new AbortController().signal

class FakeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  lastRequest?: CodeRunRequest

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    this.lastRequest = request
    return Promise.resolve({ logs: [], value: null })
  }
}

async function setup(config: Config, runtime = false) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, config)
  if (runtime) await ctx.plugin(FakeRuntime)
  return ctx
}

function registerEcho(ctx: Context, name = 'echo') {
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name,
    description: `Echo a string through ${name}.`,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      calls.push(args)
      return Promise.resolve(`${name}:${args.value}`)
    },
  }))
  return calls
}

async function execute(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ signal, callId: CallId(`call-${name}`), name, arguments: args })
}

function echoDefinition(name: string, description = `Echo a string through ${name}.`): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: args => Promise.resolve(`${name}:${args.value}`),
  })
}

function bridgeExec(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  const callId = CallId('bridge-call')
  return {
    callId,
    rootCallId: callId,
    name: TOOL_CALL_NAME,
    arguments: {},
    signal,
    token: Symbol('bridge') as ToolExecutionToken,
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
    ...overrides,
  }
}

describe('lazy tool loading', () => {
  it('keeps the legacy full native catalog when explicitly off', async () => {
    const ctx = await setup({ mode: 'native', lazyLoading: { enabled: 'off' } })
    registerEcho(ctx)

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(assembly.sections.some(section => section.name === 'tools:lazy-catalog')).toBe(false)
  })

  it('replaces deferred native schemas with stable bridges and a compact listing', async () => {
    const ctx = await setup({ mode: 'native', lazyLoading: { enabled: 'on', listingMaxTokens: 200 } })
    registerEcho(ctx)

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([
      TOOL_CALL_NAME,
      TOOL_DESCRIBE_NAME,
      TOOL_SEARCH_NAME,
    ])
    expect(assembly.tools.find(tool => tool.name === TOOL_SEARCH_NAME)?.description)
      .toContain('when an exact deferred tool name is unknown or the compact listing is truncated')
    expect(assembly.tools.find(tool => tool.name === TOOL_DESCRIBE_NAME)?.description)
      .toContain(`Call ${TOOL_DESCRIBE_NAME} directly, never through ${TOOL_CALL_NAME}`)
    expect(assembly.tools.find(tool => tool.name === TOOL_CALL_NAME)?.description)
      .toContain('never pass a top-level tool or any bridge tool')
    const catalog = assembly.sections.find(section => section.name === 'tools:lazy-catalog')?.text
    expect(catalog).toContain('echo')
    expect(catalog).not.toContain('"parameters"')
    expect(catalog).toContain('Only the deferred end tools listed below use `tool_describe` and `tool_call`.')
    expect(catalog).toContain('If the exact deferred name is listed below, call `tool_describe` directly, then `tool_call` directly; `tool_search` is unnecessary.')
    expect(catalog).toContain('Use `tool_search` directly only when you need to find a deferred tool by capability or when this listing is truncated.')
  })

  it('searches, describes, and invokes a deferred tool through the real registry pipeline', async () => {
    const ctx = await setup({ mode: 'native', lazyLoading: { enabled: 'on' } })
    const calls = registerEcho(ctx)
    const prefixBeforeDescribe = await ctx.systemPrompt.assemble()

    const searched = await execute(ctx, TOOL_SEARCH_NAME, { query: 'echo' })
    expect(searched.isError).toBe(false)
    expect(searched.isError ? undefined : searched.value).toMatchObject({
      totalAvailable: 1,
      matches: [{ name: 'echo' }],
    })

    const described = await execute(ctx, TOOL_DESCRIBE_NAME, { name: 'echo' })
    expect(described.isError).toBe(false)
    expect(described.isError ? undefined : described.value).toMatchObject({
      name: 'echo',
      parameters: { type: 'object' },
    })
    // Describing a tool returns schema data at the conversation tail; it never
    // mutates the system sections or native tool prefix for the next request.
    expect(await ctx.systemPrompt.assemble()).toEqual(prefixBeforeDescribe)

    const called = await execute(ctx, TOOL_CALL_NAME, { name: 'echo', arguments: { value: 'hello' } })
    expect(called.isError).toBe(false)
    expect(called.isError ? undefined : called.value).toBe('echo:hello')
    expect(calls).toEqual([{ value: 'hello' }])
  })

  it('corrects bridge tools routed through tool_call', async () => {
    const ctx = await setup({ mode: 'native', lazyLoading: { enabled: 'on' } })
    registerEcho(ctx)

    const describe = await execute(ctx, TOOL_CALL_NAME, {
      name: TOOL_DESCRIBE_NAME,
      arguments: { name: 'echo' },
    })
    expect(describe.error?.message).toBe(
      'tool_call cannot invoke bridge tool "tool_describe"; call "tool_describe" directly. '
      + 'tool_call accepts only deferred end-tool names listed under Deferred tools or returned by tool_search.',
    )

    const search = await execute(ctx, TOOL_CALL_NAME, {
      name: TOOL_SEARCH_NAME,
      arguments: { query: 'echo' },
    })
    expect(search.error?.message).toBe(
      'tool_call cannot invoke bridge tool "tool_search"; call "tool_search" directly. '
      + 'tool_call accepts only deferred end-tool names listed under Deferred tools or returned by tool_search.',
    )
  })

  it('uses the auto token threshold without changing off/below-threshold behavior', async () => {
    const inactive = await setup({
      mode: 'native',
      lazyLoading: { enabled: 'auto', activationThresholdTokens: 100_000 },
    })
    registerEcho(inactive)
    expect((await inactive.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['echo'])

    const active = await setup({
      mode: 'native',
      lazyLoading: { enabled: 'auto', activationThresholdTokens: 1 },
    })
    registerEcho(active)
    expect((await active.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual([
      TOOL_CALL_NAME,
      TOOL_DESCRIBE_NAME,
      TOOL_SEARCH_NAME,
    ])
  })

  it('keeps configured always-visible tools exact while deferring the rest', async () => {
    const ctx = await setup({
      mode: 'native',
      lazyLoading: { enabled: 'on', alwaysVisible: ['echo'] },
    })
    registerEcho(ctx)
    registerEcho(ctx, 'remote_tool')

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([
      'echo',
      TOOL_CALL_NAME,
      TOOL_DESCRIBE_NAME,
      TOOL_SEARCH_NAME,
    ])
    const catalog = assembly.sections.find(section => section.name === 'tools:lazy-catalog')?.text
    expect(catalog).toContain('remote_tool')
    expect(catalog).not.toContain('- echo')
  })

  it('keeps deferred definitions out of both the Code SDK and runtime bindings', async () => {
    const ctx = await setup({ mode: 'code', lazyLoading: { enabled: 'on' } }, true)
    registerEcho(ctx)

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toContain(`${TOOL_SEARCH_NAME}:`)
    expect(sdk).toContain(`${TOOL_DESCRIBE_NAME}:`)
    expect(sdk).toContain(`${TOOL_CALL_NAME}:`)
    expect(sdk).not.toContain('echo:')

    const result = await execute(ctx, RUN_CODE_NAME, { code: 'return null', description: 'Inspect lazy bindings' })
    expect(result.isError).toBe(false)
    const runtime = ctx.codeRuntime as FakeRuntime
    expect(Object.keys(runtime.lastRequest?.bindings[0]?.functions ?? {}).sort()).toEqual([
      TOOL_CALL_NAME,
      TOOL_DESCRIBE_NAME,
      TOOL_SEARCH_NAME,
    ])
  })

  it('reserves bridge names against tool registration', async () => {
    const ctx = await setup({ mode: 'native', lazyLoading: { enabled: 'off' } })
    expect(() => registerEcho(ctx, TOOL_SEARCH_NAME)).toThrow(/reserved for tool presentation infrastructure/)
  })

  it('validates config and covers every schema-cost value kind', () => {
    expect(resolveLazyLoadingConfig(undefined)).toMatchObject({
      enabled: 'off',
      activationThresholdTokens: 8000,
      listingMaxTokens: 4000,
    })
    expect(() => resolveLazyLoadingConfig({ activationThresholdTokens: 1.5 }))
      .toThrow('lazyLoading.activationThresholdTokens must be a positive integer')
    expect(() => resolveLazyLoadingConfig({ listingMaxTokens: 0 }))
      .toThrow('lazyLoading.listingMaxTokens must be a positive integer')

    const definition = echoDefinition('cost')
    const varied = {
      ...definition,
      parameters: { values: [null, 'text', 7, true] },
    } as unknown as ToolDefinition
    expect(estimateToolSchemaTokens([varied])).toBeGreaterThan(0)
  })

  it('sorts eligible definitions and renders inactive, empty-description, and truncated catalogs', () => {
    const config = resolveLazyLoadingConfig({ enabled: 'on', alwaysVisible: ['visible'] })
    const definitions = [
      echoDefinition('visible'),
      echoDefinition(TOOL_SEARCH_NAME),
      echoDefinition('run_code'),
      echoDefinition('beta'),
      echoDefinition('alpha', ''),
      echoDefinition('alpha', 'duplicate'),
    ]
    const state = resolveLazyLoadingState(definitions, config)
    expect(state.deferred.map(definition => definition.name)).toEqual(['alpha', 'alpha', 'beta'])
    expect(renderLazyCatalog({ active: false, deferred: [], estimatedTokens: 0 }, config)).toBe('')
    expect(renderLazyCatalog(state, { ...config, listingMaxTokens: 4000 })).toContain('- alpha\n')
    expect(renderLazyCatalog(state, { ...config, listingMaxTokens: 1 }))
      .toContain(`more; use ${TOOL_SEARCH_NAME}`)
    expect(resolveLazyLoadingState([], config)).toMatchObject({ active: false, deferred: [] })
  })

  it('searches the deferred catalog with bounded limits and actionable misses', async () => {
    const definitions = [
      echoDefinition('alphabet_tool', 'Manage an object.'),
      echoDefinition('alpha_tool', 'Manage an object.'),
      echoDefinition('alpha_tool', 'Manage an object.'),
      echoDefinition('zeta', 'Alpha object lookup.'),
    ]
    const state = { active: true, deferred: definitions, estimatedTokens: 1 }
    const bridges = createLazyBridgeTools({
      state: () => state,
      executeUnderlying: (_name, args) => Promise.resolve(args),
    })
    const search = bridges.get(TOOL_SEARCH_NAME)!
    await expect(search.execute({ query: '   ' }, bridgeExec())).rejects.toThrow('query must be non-empty')
    await expect(search.execute({ query: 'alpha   object', limit: 0 }, bridgeExec())).resolves.toMatchObject({
      matches: [{ name: 'alpha_tool' }],
    })
    const tools = await search.execute({ query: 'tool', limit: 99 }, bridgeExec()) as {
      matches: { name: string }[]
    }
    expect(tools.matches.map(match => match.name))
      .toEqual(['alpha_tool', 'alpha_tool', 'alphabet_tool'])
    await expect(search.execute({ query: 'missing' }, bridgeExec())).resolves.toMatchObject({ matches: [] })

    const describe = bridges.get(TOOL_DESCRIBE_NAME)!
    await expect(describe.execute({ name: TOOL_SEARCH_NAME }, bridgeExec()))
      .rejects.toThrow('tool_describe cannot describe bridge tool "tool_search"; call "tool_search" directly')
    await expect(describe.execute({ name: 'missing' }, bridgeExec()))
      .rejects.toThrow('tool_describe cannot describe "missing" because it is not deferred in this scope')

    const call = bridges.get(TOOL_CALL_NAME)!
    await expect(call.execute({ name: 'alpha_tool', arguments: { value: 'x' } }, bridgeExec()))
      .resolves.toEqual({ value: 'x' })
  })

  it('projects bridge schemas and forwards nested success semantics', async () => {
    const definition = echoDefinition('echo')
    expect(definitionToToolSchema(definition)).toEqual({
      name: 'echo',
      description: definition.description,
      parameters: definition.parameters,
    })
    expect(definitionToSdkSchema(definition)).toEqual({
      name: 'echo',
      description: definition.description,
      parameters: definition.parameters,
      output: definition.output.schema,
    })
    const bridges = createLazyBridgeTools({
      state: () => ({ active: true, deferred: [definition], estimatedTokens: 1 }),
      executeUnderlying: (_name, args) => Promise.resolve(args),
    })
    expect(lazyBridgeSdkSchemas(bridges).map(schema => schema.name))
      .toEqual([TOOL_SEARCH_NAME, TOOL_DESCRIBE_NAME, TOOL_CALL_NAME])

    const additional = createUserMessage({
      content: [{ type: 'text', text: 'additional' }],
      source: { kind: 'plugin', plugin: 'spec' },
    })
    const nestedExecute = vi.fn().mockResolvedValue({
      isError: false,
      value: 'done',
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      additionalContexts: [additional],
      concludesTurn: true,
    })
    const registry = { execute: nestedExecute } as unknown as ToolRuntime
    const agent = {} as Agent
    const exec = bridgeExec({ agent })
    await expect(executeDeferredTool(
      registry,
      () => ({ active: true, deferred: [definition], estimatedTokens: 1 }),
      'echo',
      { value: 'x' },
      exec,
    )).resolves.toBe('done')
    expect(nestedExecute).toHaveBeenCalledWith(expect.objectContaining({
      name: 'echo',
      agent,
      parent: exec.token,
      rootCallId: exec.rootCallId,
    }))
    expect(exec.deferContext).toHaveBeenCalledTimes(2)
    expect(exec.concludeTurn).toHaveBeenCalledOnce()
  })

  it('rejects inactive, missing, and failed nested deferred calls', async () => {
    const definition = echoDefinition('echo')
    const exec = bridgeExec()
    const registry = {
      execute: vi.fn().mockResolvedValue({
        isError: true,
        error: { message: 'nested denied' },
        content: [{ type: 'text', text: 'Error: nested denied' }],
      }),
    } as unknown as ToolRuntime
    await expect(executeDeferredTool(
      registry,
      () => ({ active: false, deferred: [definition], estimatedTokens: 1 }),
      'echo',
      {},
      exec,
    )).rejects.toThrow('tool_call cannot invoke "echo" because it is not deferred in this scope')
    await expect(executeDeferredTool(
      registry,
      () => ({ active: true, deferred: [], estimatedTokens: 1 }),
      'echo',
      {},
      exec,
    )).rejects.toThrow('tool_call cannot invoke "echo" because it is not deferred in this scope')
    await expect(executeDeferredTool(
      registry,
      () => ({ active: true, deferred: [definition], estimatedTokens: 1 }),
      'echo',
      {},
      exec,
    )).rejects.toThrow('nested denied')
  })
})
