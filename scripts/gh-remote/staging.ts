/** Staging repair for the GH remote archive: materialize every workspace package the deploy omitted. */
import { existsSync, globSync } from 'node:fs'
import { cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

async function manifest(path: string): Promise<PackageManifest> { return JSON.parse(await readFile(path, 'utf8')) as PackageManifest }

/** Index every workspace package directory by manifest name. */
export async function workspacePackageIndex(workspace: string): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const path of globSync(['apps/*/package.json', 'packages/*/*/package.json', 'vendor/*/package.json'], { cwd: workspace }).sort()) {
    const data = await manifest(join(workspace, path))
    if (data.name !== undefined) index.set(data.name, dirname(join(workspace, path)))
  }
  return index
}

/** Every package.json below node_modules (scoped depth plus nested module trees), excluding .bin/.pnpm machinery. */
async function stagedPackageManifests(staging: string): Promise<string[]> {
  const modules = join(staging, 'node_modules')
  const paths: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.pnpm') continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith('@')) {
        await visit(path)
        continue
      }
      const candidate = join(path, 'package.json')
      if (existsSync(candidate)) paths.push(candidate)
      const nested = join(path, 'node_modules')
      if (existsSync(nested)) await visit(nested)
    }
  }
  await visit(modules)
  return paths
}

/**
 * Materialize workspace packages the prod deploy omitted, to a fixpoint.
 *
 * `pnpm deploy --legacy --prod --auto-install-peers=false` drops both
 * peerDependencies and some transitive workspace dependencies of the legacy
 * hoister. Every dependency, peer, or optional name that resolves to a
 * workspace package but is absent from the staging is copied in from its
 * workspace source (without its own dev-time node_modules); the walk repeats
 * until nothing new appears, so restored packages' own references settle too.
 * Third-party names stay untouched — exactly what the deploy already placed.
 * @param staging - deployed runtime root.
 * @param workspace - workspace root whose packages resolve dependency names.
 * @returns workspace package names restored into the staging.
 */
export async function restoreStagedWorkspacePackages(staging: string, workspace: string): Promise<string[]> {
  const modules = join(staging, 'node_modules')
  const index = await workspacePackageIndex(workspace)
  const restored: string[] = []
  let changed = true
  while (changed) {
    changed = false
    const wanted = new Set<string>()
    for (const path of await stagedPackageManifests(staging)) {
      const data = await manifest(path)
      for (const section of [data.dependencies, data.peerDependencies, data.optionalDependencies]) {
        for (const name of Object.keys(section ?? {})) wanted.add(name)
      }
    }
    for (const name of wanted) {
      if (existsSync(join(modules, name)) || restored.includes(name)) continue
      const source = index.get(name)
      if (source === undefined) continue
      const destination = join(modules, name)
      await mkdir(dirname(destination), { recursive: true })
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: (path: string) => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}/`),
      })
      restored.push(name)
      changed = true
    }
  }
  if (restored.length > 0) console.log(`gh-remote build: restored workspace packages into staging (${restored.length}): ${restored.join(', ')}`)
  return restored
}
