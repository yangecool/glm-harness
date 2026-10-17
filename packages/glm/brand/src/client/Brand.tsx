/**
 * GLM Harness occupants for the generic brand slots: the spark mark cropped
 * from the product asset by mask (so it follows `currentColor` on every
 * surface), the wordmark set in the shipped brand font, and the platform
 * suffix badge the way the shell composes product + platform identity.
 * @module @glm-harness/gh-brand/src/client/Brand
 */
import type { CSSProperties } from 'react'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PRODUCT_LABEL, PRODUCT_NAME, PRODUCT_SUFFIX } from './locales.ts'

const MARK_URL = '/glm-mark.svg'

type GlmBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/** The spark mark as a currentColor mask at the requested square size. */
function markStyle(size: number): CSSProperties {
  return {
    display: 'inline-block',
    flex: 'none',
    width: size,
    height: size,
    backgroundColor: 'currentColor',
    WebkitMaskImage: `url("${MARK_URL}")`,
    maskImage: `url("${MARK_URL}")`,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: `${size}px ${size}px`,
    maskSize: `${size}px ${size}px`,
  }
}

/** Platform suffix badge matching the shell's product + platform composition. */
function HarnessBadge({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        boxSizing: 'border-box',
        display: 'inline-block',
        flex: 'none',
        height: size,
        paddingInline: Math.max(4, Math.round(size * 0.32)),
        borderRadius: Math.max(3, Math.round(size * 0.24)),
        background: 'color-mix(in srgb, currentColor 8%, transparent)',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, currentColor 10%, transparent), 0 2px 8px color-mix(in srgb, currentColor 6%, transparent)',
        color: 'currentColor',
        fontFamily: 'var(--dsw-font-family)',
        fontSize: Math.max(7, Math.round(size * 0.48)),
        fontWeight: 650,
        letterSpacing: '0.12em',
        lineHeight: `${size}px`,
        opacity: 0.48,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {PRODUCT_SUFFIX}
    </span>
  )
}

/** Wordmark letters set in the shipped brand font at one text height. */
function WordmarkLetters({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        color: 'currentColor',
        fontFamily: 'Montserrat, var(--dsw-font-family, sans-serif)',
        fontSize: Math.max(11, Math.round(size * 0.62)),
        fontWeight: 650,
        letterSpacing: '0.02em',
        lineHeight: `${size}px`,
        whiteSpace: 'nowrap',
      }}
    >
      {PRODUCT_NAME}
    </span>
  )
}

/** Render only the GLM spark mark with the host-requested presentation. */
export function GlmBrandMark({ size, className }: GlmBrandMarkProps) {
  return <span className={className} aria-hidden="true" style={markStyle(size)} />
}

/** Sidebar identity: spark-adjacent wordmark plus the platform badge. */
export function GlmBrandName({ className }: { className?: string | undefined } = {}) {
  return (
    <span className={className} aria-label={PRODUCT_LABEL} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, whiteSpace: 'nowrap' }}>
      <WordmarkLetters size={24} />
      <HarnessBadge size={14} />
    </span>
  )
}

/** Hero mark before the blank-session headline, at the host-requested size. */
export function GlmHeroBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <span className={className} aria-hidden="true" style={markStyle(size)} />
}
