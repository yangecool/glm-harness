/**
 * GLM Harness boundary gate: the @glm-harness product group stays a closed,
 * upstream-business-free composition.
 *
 * Run: `tsx scripts/check-gh-closure.ts` (after `pnpm install`).
 *
 * Two sides are checked and both must stay clean:
 *
 * 1. Dependency closure — the transitive workspace dependency closure of every
 *    `@glm-harness/*` package contains no banned upstream business package.
 *    Banning the dependency keeps the packages out of GH artifacts even before
 *    any profile composes them.
 * 2. Composed profile tree — every profile in `GH_PROFILES` composes (through
 *    the same loader path `dsh --dump-config` uses) to an entry list that
 *    mentions no banned package, while still mounting the shared GH base rows.
 *    This catches a banned row smuggled in through a later bundle or patch
 *    even when the package graph itself looks clean.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { composeEntries } from '../packages/boot/app-boot/src/profile.ts'
import { readWorkspaceManifests, type WorkspaceManifest } from './check-workspace-constraints.ts'
import { GH_PROFILES, initGhProfiles } from './gh-init-profiles.ts'
import { prepareProfile } from '../apps/cli/src/profile-boot.ts'

const root = resolve(import.meta.dirname, '..')

/**
 * Upstream packages that carry model, account, or telemetry business. The GH
 * product re-implements these domains as `@glm-harness` packages (plan E02,
 * E09); none of them may enter a GH closure as a dependency, a composed row,
 * or any other mention inside a composed profile tree.
 */
export const GH_BANNED_UPSTREAM_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-llm-deepseek-api-key',
  '@deepseek-ai/dsh-llm-deepseek-account',
  '@deepseek-ai/dsh-deepseek-account-platform',
  '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  '@deepseek-ai/dsh-web-search-deepseek',
  '@deepseek-ai/dsh-otel',
  '@deepseek-ai/dsh-session-telemetry-otel',
]

/** Dependency sections that reach the installed runtime. */
const runtimeDependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/** The workspace name of a manifest, when it is a workspace package. */
function workspaceName(manifest: WorkspaceManifest): string | undefined {
  return manifest.manifest.name
}

/**
 * Compute the transitive workspace dependency closure of the named seeds.
 * @param manifests - every workspace member manifest.
 * @param seeds - workspace package names to start from.
 * @returns the closure including the seeds that exist.
 */
export function ghDependencyClosure(manifests: readonly WorkspaceManifest[], seeds: readonly string[]): Set<string> {
  const byName = new Map(manifests.map(manifest => [workspaceName(manifest), manifest] as const))
  const closure = new Set<string>()
  const queue = [...seeds]
  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || closure.has(name)) continue
    closure.add(name)
    const manifest = byName.get(name)?.manifest
    if (manifest === undefined) continue
    for (const section of runtimeDependencySections) {
      for (const dependency of Object.keys(manifest[section] ?? {})) queue.push(dependency)
    }
  }
  return closure
}

/** Check that no banned upstream package enters the @glm-harness dependency closure. */
export function checkDependencyClosure(manifests: readonly WorkspaceManifest[]): string[] {
  const seeds = manifests
    .map(manifest => workspaceName(manifest))
    .filter((name): name is string => name !== undefined && name.startsWith('@glm-harness/'))
  if (seeds.length === 0) return ['no @glm-harness packages found in the workspace']
  const closure = ghDependencyClosure(manifests, seeds)
  const errors: string[] = []
  for (const banned of GH_BANNED_UPSTREAM_PACKAGES) {
    if (closure.has(banned)) {
      errors.push(`@glm-harness dependency closure includes banned ${banned}`)
    }
  }
  return errors
}

/**
 * Compose every GH profile in an isolated home and check the entry tree.
 * @returns violation messages; empty means every profile composes clean.
 */
export function checkComposedProfiles(): string[] {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'gh-closure-'))
  process.env.DSH_HOME = home
  const errors: string[] = []
  try {
    initGhProfiles(home)
    for (const [name, bundles] of Object.entries(GH_PROFILES)) {
      const loaded = prepareProfile(name, false)
      const entries = composeEntries(loaded.layers.map(layer => layer.patches))
      const serialized = JSON.stringify(entries)
      for (const banned of GH_BANNED_UPSTREAM_PACKAGES) {
        if (serialized.includes(banned)) {
          errors.push(`profile ${name} composed tree mentions banned ${banned}`)
        }
      }
      for (const bundle of bundles) {
        if (!loaded.layers.some(layer => layer.packageName === bundle)) {
          errors.push(`profile ${name} did not load bundle ${bundle}`)
        }
      }
      if (!entries.some(entry => entry.name === '@deepseek-ai/dsh-llm')
        // The supervisor profile is process supervision, not a model surface:
        // one minimal row (sdk-minimal pattern) that must never grow a model
        // seam. Every model-facing profile still mounts the LLM seam.
        && name !== 'gh-supervisor') {
        errors.push(`profile ${name} does not mount the LLM seam`)
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
  return errors
}

function main(): void {
  const errors = [
    ...checkDependencyClosure(readWorkspaceManifests(root)),
    ...checkComposedProfiles(),
  ]
  if (errors.length > 0) {
    for (const error of errors) console.error(`gh-closure: ${error}`)
    process.exitCode = 1
    return
  }
  console.log('gh-closure: @glm-harness closures and composed profiles are free of banned upstream business packages')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
