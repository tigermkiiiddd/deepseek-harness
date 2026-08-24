import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
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
import type { Config } from '@deepseek-ai/dsh-tools'

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
    const catalog = assembly.sections.find(section => section.name === 'tools:lazy-catalog')?.text
    expect(catalog).toContain('echo')
    expect(catalog).not.toContain('"parameters"')
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
})
