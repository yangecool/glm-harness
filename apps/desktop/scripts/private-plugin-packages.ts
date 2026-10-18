/** Private workspace plugins must join the local Desktop tarballs without becoming npm publications. */
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'

interface WorkspaceManifest {
  name: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/**
 * Select private plugin directories reachable from the Desktop runtime roots.
 * Public packages remain owned by release:pack; the private Host is packed separately.
 * @param root - repository workspace root.
 * @returns repository-relative plugin directories in stable order.
 */
export function privateDesktopPluginDirectories(root: string): string[] {
  const workspace = load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const packages = new Map<string, { path: string; manifest: WorkspaceManifest }>()
  for (const path of globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: root })) {
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as WorkspaceManifest
    packages.set(manifest.name, { path: dirname(path).replaceAll('\\', '/'), manifest })
  }
  const selected: string[] = []
  const visited = new Set<string>()
  const visit = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    const entry = packages.get(name)
    if (entry === undefined) return
    if (entry.manifest.private === true && entry.path.startsWith('packages/')) selected.push(entry.path)
    for (const dependency of Object.keys({
      ...entry.manifest.dependencies, ...entry.manifest.peerDependencies, ...entry.manifest.optionalDependencies,
    })) visit(dependency)
  }
  for (const rootPackage of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']) {
    if (!packages.has(rootPackage)) throw new Error(`desktop package: workspace omits ${rootPackage}`)
    visit(rootPackage)
  }
  return selected.sort()
}
