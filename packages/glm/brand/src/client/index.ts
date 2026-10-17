/**
 * GLM Harness occupants for the generic browser-brand slots, plus the GLM
 * color ramp override. The three slots this baseline ships (sidebar
 * mark/name and the conversation-hero mark) register as one
 * declaration-aware set the way the stock occupants do; the theme
 * stylesheet installs beside them so removing this plugin restores the
 * stock identity and ramp together.
 * @module @glm-harness/gh-brand/src/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { GlmBrandMark, GlmBrandName, GlmHeroBrandMark } from './Brand.tsx'
import { installGlmTheme } from './theme.ts'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/** Fill every shipped product-brand slot and follow declaration lifetime. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installGlmTheme(), 'gh-brand: GLM color ramp')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, GlmBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, GlmBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, GlmHeroBrandMark)
      })))
}
