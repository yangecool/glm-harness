import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as persona from '../src/index.ts'

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '' })
  await ctx.plugin(persona)
  return ctx
}

describe('gh-persona', () => {
  it('renders the GLM identity ahead of the work policy with no upstream identity', async () => {
    const ctx = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(section => section.name)).toEqual([
      persona.GH_IDENTITY_SECTION,
      'deployment:persona-prefix',
      persona.GH_WORK_POLICY_SECTION,
      'deployment:persona-suffix',
    ])
    const rendered = renderPrompt(assembly)
    expect(rendered.startsWith(persona.GH_IDENTITY_TEXT)).toBe(true)
    expect(rendered).toContain('AI coding agent powered by GLM Harness')
    expect(rendered).not.toContain('DeepSeek Harness')
  })

  it('keeps the assembled prefix byte-identical across assemblies (stable request prefix)', async () => {
    const ctx = await mount()
    expect(renderPrompt(await ctx.systemPrompt.assemble()))
      .toBe(renderPrompt(await ctx.systemPrompt.assemble()))
  })

  it('names no tool, platform, or capability the composition might not grant', () => {
    for (const token of ['web_search', 'web_fetch', 'bash', 'grep', 'glob', 'Windows', 'Linux', 'macOS', 'terminal', 'browser', 'background', 'cache', 'memory']) {
      expect(persona.GH_WORK_POLICY_TEXT).not.toContain(token)
    }
  })

  it('removes both sections when the owning scope is disposed, leaving the registry intact', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '' })
    const scope = createScope(ctx, { name: 'gh-persona-holder' })
    await scope.ctx.plugin(persona)
    const key = scopeOf(scope.ctx)!
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toContain('GLM Harness')
    await scope.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).not.toContain('GLM Harness')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('')
  })

  it('rejects a second mount in the same scope instead of duplicating sections', async () => {
    const ctx = await mount()
    await expect(ctx.plugin(persona)).rejects.toThrow(/already registered/)
  })
})
