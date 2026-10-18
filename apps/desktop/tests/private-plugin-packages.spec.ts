/** Local Desktop packing includes reachable private plugins and leaves unrelated packages out. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { privateDesktopPluginDirectories } from '../scripts/private-plugin-packages.ts'

it('packs a transitive private plugin once through public and peer dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-private-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*/*\n')
  const entries = [
    ['apps/cli', { name: '@deepseek-ai/dsh', dependencies: { '@t/public': 'workspace:*' } }],
    ['apps/desktop-host', { name: '@deepseek-ai/dsh-desktop-host', private: true, dependencies: { '@t/private': 'workspace:*' } }],
    ['packages/base/public', { name: '@t/public', peerDependencies: { '@t/private': 'workspace:*' } }],
    ['packages/product/private', { name: '@t/private', private: true, dependencies: { '@t/public': 'workspace:*', external: '^1' } }],
    ['packages/product/unused', { name: '@t/unused', private: true }],
  ] as const
  for (const [path, manifest] of entries) {
    await mkdir(join(root, path), { recursive: true })
    await writeFile(join(root, path, 'package.json'), JSON.stringify(manifest))
  }
  expect(privateDesktopPluginDirectories(root)).toEqual(['packages/product/private'])
})
