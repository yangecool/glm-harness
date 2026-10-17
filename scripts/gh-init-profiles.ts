/**
 * Initialize the GLM Harness profiles inside a GH-owned Harness home.
 *
 * Run: `tsx scripts/gh-init-profiles.ts [--home <dir>]` (default `~/.glmh`).
 *
 * GH profiles are product-owned compositions, initialized on disk the same
 * way the reserved Desktop profile is: the launcher loads whatever a home's
 * `profiles/<name>` provides, so GH never patches the shipped template list
 * in app-boot. Re-running is a no-op on an initialized profile
 * (`initProfile` never touches existing files), which keeps a user's saved
 * profile patches and installed plugins intact.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { initProfile } from '../packages/boot/app-boot/src/profile.ts'

/**
 * The GH product profiles: the shared GH base plus exactly one surface
 * bundle. Every entry starts from `@glm-harness/gh-base`, never
 * `@deepseek-ai/dsh-base`; `scripts/check-gh-closure.ts` fails when a
 * composed GH profile names an upstream model, account, or telemetry package.
 */
export const GH_PROFILES: Readonly<Record<string, readonly string[]>> = {
  'gh-web': ['@glm-harness/gh-base', '@deepseek-ai/dsh-web-app'],
  'gh-headless': ['@glm-harness/gh-base', '@deepseek-ai/dsh-headless'],
}

/**
 * Write every GH profile manifest into a Harness home.
 * @param home - the GH Harness home (`$DSH_HOME` for GH launches).
 * @returns the initialized profile directories.
 */
export function initGhProfiles(home: string): readonly string[] {
  const initialized: string[] = []
  for (const [name, bundles] of Object.entries(GH_PROFILES)) {
    const dir = join(home, 'profiles', name)
    initProfile(dir, [...bundles])
    initialized.push(dir)
  }
  return initialized
}

function homeFromArgv(argv: readonly string[]): string {
  const index = argv.indexOf('--home')
  const value = index !== -1 ? argv[index + 1] : undefined
  if (value !== undefined && value !== '') return value
  return join(homedir(), '.glmh')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const home = homeFromArgv(process.argv.slice(2))
  for (const dir of initGhProfiles(home)) {
    console.log(`gh: initialized ${dir}`)
  }
}
