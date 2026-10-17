/**
 * The GLM color ramp as a runtime cascade override. The platform stylesheet
 * defines the accent ramp (`--dsw-static-deepseek-*`) and the onboarding
 * accent once per theme block on `body` / `body[data-ds-dark-theme]`; this
 * stylesheet re-declares the same custom properties on the same selectors and
 * wins by document order (it is appended after every static sheet), so no
 * upstream file changes and disabling this plugin restores the stock ramp.
 * @module @glm-harness/gh-brand/src/client/theme
 */

/**
 * The GLM brand blue ramp, lightness-aligned with the stock ramp it replaces
 * so dark-mode surfaces keep their designed contrast relationships.
 * 450/500 carry the brand hue; 600–900 stay desaturated for text-adjacent
 * dark surfaces, mirroring the stock ramp's behavior.
 */
export const GLM_RAMP = {
  50: 'rgb(238, 244, 255)',
  100: 'rgb(223, 234, 255)',
  200: 'rgb(203, 222, 255)',
  300: 'rgb(178, 205, 255)',
  400: 'rgb(124, 172, 255)',
  450: 'rgb(88, 140, 255)',
  500: 'rgb(59, 111, 255)',
  600: 'rgb(75, 110, 190)',
  '700-delete': 'rgb(52, 82, 160)',
  800: 'rgb(56, 70, 98)',
  900: 'rgb(43, 53, 78)',
} as const

/** The standalone accent the onboarding surfaces pin outside the ramp. */
export const GLM_ACCENT = 'rgb(59, 111, 255)'

/** The override stylesheet body: one ramp declaration pair per theme block. */
export const GLM_THEME_CSS = `body{${Object.entries(GLM_RAMP).map(([step, value]) => `--dsw-static-deepseek-${step}: ${value};`).join('')}--dsw-alias-onboarding-accent: ${GLM_ACCENT};}
body[data-ds-dark-theme]{${Object.entries(GLM_RAMP).map(([step, value]) => `--dsw-static-deepseek-${step}: ${value};`).join('')}--dsw-alias-onboarding-accent: ${GLM_ACCENT};}`

/**
 * Install the GLM ramp override stylesheet into the current document.
 * @returns a disposer removing the element; safe to call where `document` is absent.
 */
export function installGlmTheme(): () => void {
  if (typeof document === 'undefined') return () => {}
  const element = document.createElement('style')
  element.dataset.ghBrandTheme = ''
  element.textContent = GLM_THEME_CSS
  document.head.append(element)
  return () => { element.remove() }
}
