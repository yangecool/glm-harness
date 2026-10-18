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
import { readFileSync, writeFileSync } from 'node:fs'
import { initProfile } from '../packages/boot/app-boot/src/profile.ts'

/**
 * The GH product profiles: the shared GH base plus exactly one surface
 * bundle. Every entry starts from `@glm-harness/gh-base`, never
 * `@deepseek-ai/dsh-base`; `scripts/check-gh-closure.ts` fails when a
 * composed GH profile names an upstream model, account, or telemetry package.
 *
 * `desktop` is the RESERVED profile name the upstream Electron shell reads
 * from `$DSH_HOME/profiles/desktop`; claiming it with the GH tuple (base,
 * web-app, then the gh-desktop product overlay) is what lets the unmodified
 * shell boot the GH composition. The overlay removes the upstream telemetry
 * rows that the reserved name would otherwise enable.
 */
export const GH_PROFILES: Readonly<Record<string, readonly string[]>> = {
  'gh-web': ['@glm-harness/gh-base', '@deepseek-ai/dsh-web-app', '@glm-harness/gh-brand'],
  'gh-headless': ['@glm-harness/gh-base', '@deepseek-ai/dsh-headless'],
  // The resident remote service: the web transport's server half with the
  // browser payload stripped; boots headless (`--no-open --host --port`).
  'gh-remote': ['@glm-harness/gh-base', '@deepseek-ai/dsh-web-app', '@glm-harness/gh-remote-app'],
  desktop: ['@glm-harness/gh-base', '@deepseek-ai/dsh-web-app', '@glm-harness/gh-brand', '@glm-harness/gh-desktop'],
}

/**
 * The product layer each GH profile composes last. Surface bundles re-address
 * the `system-prompt` row with their own one-line persona, and a row patch
 * replaces the whole config, so the GH decisions must speak after every
 * bundle: the upstream harness identity drops (the gh-persona row owns the
 * model identity), the surface persona line stays, and the model-facing tool
 * order is pinned. Users edit this file freely; re-initialization only
 * replaces it while it still matches the pristine loader template.
 */
const GH_PROFILE_PATCH = `# Your patch layer for this GH profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- id: system-prompt
  config:
    includeHarnessIdentity: false
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model.
    toolOrder: !!js "['read','read_image','edit','write',process.platform === 'win32' ? 'pwsh' : 'bash','grep','glob','todo_write','job_list','job_output','job_kill','web_search','web_fetch','skill','subagent','subagent_fork','send_message','interrupt_agent','list_agents','create_goal','update_goal','get_goal','workflow','exit_plan_mode','<unlisted-tools>']"
`

/** The extra rows only web-surface profiles need (they compose dsh-web-app). */
const GH_WEB_PROFILE_PATCH = `
# The web surface's dev-context rows name the upstream "DeepSeek Harness"
# checkout to the model; GH drops them until a GH-authored source context
# exists. gh-persona owns the model identity in every profile.
- id: harness-dev-context
  disabled: true

# The web-app bundle's preset-menu client cannot activate here: its host
# permissionPresets service is disabled (gh-permissions owns the modes), and a
# client entry that never activates fails the web boot gate. The GH composer
# control (ui-gh-permissions, inserted by gh-base) is the sole occupant.
- id: ui-permission
  disabled: true
`

/** Profiles that compose the web surface bundle and its dev-context rows. */
const GH_WEB_PROFILES: ReadonlySet<string> = new Set(['gh-web', 'gh-remote', 'desktop'])

/** The loader's pristine empty patch, the marker of an untouched profile layer. */
const PRISTINE_PROFILE_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

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
    const patchPath = join(dir, 'cordis.patch.yml')
    if (readFileSync(patchPath, 'utf8') === PRISTINE_PROFILE_PATCH) {
      writeFileSync(patchPath, GH_WEB_PROFILES.has(name) ? GH_PROFILE_PATCH + GH_WEB_PROFILE_PATCH : GH_PROFILE_PATCH)
    }
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
