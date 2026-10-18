/** Regression coverage for source declarations owned by the client test aggregate. */

import { existsSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

function clientCssDeclarations(): string[] {
  const clientGroups = ['client', 'extensions']
  return clientGroups.flatMap((group) => {
    const clientRoot = resolve(root, 'packages', group)
    return readdirSync(clientRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => resolve(clientRoot, entry.name, 'src/css-modules.d.ts'))
  })
    .filter(existsSync)
    .map(file => file.replaceAll(sep, '/'))
    .sort()
}

describe('client TypeScript aggregate', () => {
  it('keeps GH browser package compilers out of the Host dependency graph before Typert generation', () => {
    const visited = new Set<string>()
    const browserProjects: string[] = []
    const visit = (path: string): void => {
      const configPath = path.endsWith('.json') ? path : resolve(path, 'tsconfig.json')
      if (visited.has(configPath)) return
      visited.add(configPath)
      const read = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
      if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
      const raw: unknown = read.config
      if (typeof raw === 'object' && raw !== null && 'extends' in raw
        && typeof raw.extends === 'string' && raw.extends.endsWith('tsconfig.base.client.json')) {
        const project = configPath.slice(root.length).replaceAll(sep, '/')
        if (project.startsWith('/packages/glm/')) browserProjects.push(project)
      }
      // The upstream webworker chain reaches the upstream browser subgraph by
      // design; the invariant under test is GH-owned packages only.
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, resolve(configPath, '..'))
      for (const reference of parsed.projectReferences ?? []) visit(reference.path)
    }
    visit(resolve(root, 'tsconfig.host.json'))
    expect(browserProjects).toEqual([])
  })

  it('loads package CSS declarations without relying on workspace-link realpaths', () => {
    const configPath = resolve(root, 'tsconfig.client.json')
    const read = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
    if (read.error !== undefined) {
      throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
    const loaded = parsed.fileNames
      .map(file => file.replaceAll(sep, '/'))
      .filter(file => file.endsWith('/src/css-modules.d.ts'))
      .sort()
    expect(loaded).toEqual(clientCssDeclarations())
  })
})
