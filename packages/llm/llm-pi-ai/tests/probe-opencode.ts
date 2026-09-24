/**
 * Direct reproduce inside the repo: resolve the opencode-go route from user settings.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { load } from 'js-yaml'

async function main(): Promise<void> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const settings = load(readFileSync(join(home, 'settings.yaml'), 'utf8')) as Record<string, unknown>
  const piAiConfig = settings['llm-pi-ai'] as Record<string, unknown> | undefined
  process.env.OPENCODE_GO_API_KEY ??= 'probe'
  process.env.ZAI_API_KEY ??= 'probe'
  process.env.ORNITH_LOCAL_API_KEY ??= 'probe'

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, piAiConfig)

  console.log('providers:', ctx.llm.listProviders().map(p => p.id))
  try {
    const models = await ctx.llm.listModels('opencode-go')
    console.log('opencode-go models:', models.length)
    console.log('first:', JSON.stringify(models[0]))
  } catch (error) {
    console.error('listModels FAILED:', error instanceof Error ? error.message : String(error))
  }
  try {
    const resolved = await ctx.llm.resolveCallConfig({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    console.log('resolveCallConfig OK:', resolved.provider, resolved.model)
  } catch (error) {
    console.error('resolveCallConfig FAILED:', error instanceof Error ? error.message : String(error))
  }
  try {
    const resolved = await ctx.llm.resolveCallConfig({ provider: 'opencode-go', model: 'minimax-m3' })
    console.log('minimax-m3 OK:', resolved.provider, resolved.model)
  } catch (error) {
    console.error('minimax-m3 FAILED:', error instanceof Error ? error.message : String(error))
  }
  await ctx.dispose()
}

void main()
