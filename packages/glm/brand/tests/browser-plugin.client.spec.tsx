// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GlmBrandMark, GlmBrandName, GlmHeroBrandMark } from '../src/client/Brand.tsx'
import { apply, inject } from '../src/client/index.ts'
import { GLM_ACCENT, GLM_RAMP, installGlmTheme } from '../src/client/theme.ts'

afterEach(cleanup)

const HOLES = [
  'sidebar.brand.mark', 'sidebar.brand.name',
  'conversation.hero.brand.mark',
] as const

describe('GLM browser brand', () => {
  it('owns all generic brand slots and releases them on teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: Object.fromEntries(HOLES.map(hole => [hole, { kind: 'single', scope: 'root' }])),
    } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('sidebar.brand.mark')[0]?.component).toBe(GlmBrandMark)
    expect(slots.entries('sidebar.brand.name')[0]?.component).toBe(GlmBrandName)
    expect(slots.entries('conversation.hero.brand.mark')[0]?.component).toBe(GlmHeroBrandMark)
    await fiber.dispose()
    for (const hole of HOLES) expect(slots.entries(hole)).toHaveLength(0)
  })

  it('renders the spark mark and the GLM Harness identity', () => {
    const mark = render(<GlmBrandMark size={34} className="hero" />)
    expect(mark.container.firstElementChild?.getAttribute('class')).toBe('hero')
    expect((mark.container.firstElementChild as HTMLElement).style.maskImage).toContain('/glm-mark.svg')
    const name = render(<GlmBrandName />)
    expect(name.container.firstElementChild?.getAttribute('aria-label')).toBe('GLM Harness')
    expect(name.container.textContent).toContain('GLM')
    expect(name.container.textContent).toContain('HARNESS')
  })

  it('installs the GLM ramp override and removes it on dispose', () => {
    const dispose = installGlmTheme()
    const element = document.head.querySelector('style[data-gh-brand-theme]')
    expect(element?.textContent ?? '').toContain(`--dsw-static-deepseek-500: ${GLM_RAMP[500]};`)
    expect(element?.textContent ?? '').toContain(`--dsw-alias-onboarding-accent: ${GLM_ACCENT};`)
    expect(element?.textContent ?? '').toContain('body[data-ds-dark-theme]')
    dispose()
    expect(document.head.querySelector('style[data-gh-brand-theme]')).toBeNull()
  })
})
