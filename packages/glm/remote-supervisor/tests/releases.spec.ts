/** GH-006-E release lifecycle: immutable installs, atomic pointer, gc pins, uninstall split. */

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  copyTree, gcReleases, installRelease, launcherFor, listReleases, listStaging,
  readCurrent, serviceCommandFor, uninstallRoot, useRelease,
} from '../src/releases.ts'
import { supervisorCli } from '../src/index.ts'

/** A fresh data root per test, removed afterwards. */
const freshRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'gh-releases-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A minimal runtime source directory the installer accepts. */
const runtimeSource = async (parent: string, marker: string): Promise<string> => {
  const dir = join(parent, `src-${marker}`)
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(join(dir, 'lib', 'bin.js'), `console.log('${marker}')\n`)
  return dir
}

it('installs a release immutably: manifest sealed, same id refused', async () => {
  const root = await freshRoot()
  const source = await runtimeSource(root, 'one')
  const first = await installRelease(root, source, { id: 'r-one' })
  expect(first).toEqual({ ok: true, releaseId: 'r-one' })
  const manifest = JSON.parse(await readFile(join(root, 'releases', 'r-one', 'gh-release.json'), 'utf8')) as { kind: string; id: string }
  expect(manifest).toMatchObject({ kind: 'gh-remote-release', id: 'r-one' })
  const second = await installRelease(root, source, { id: 'r-one' })
  expect(second.ok).toBe(false)
  if (!second.ok) expect(second.reason).toContain('immutable')
})

it('refuses install sources without the runtime entry', async () => {
  const root = await freshRoot()
  const bad = join(root, 'not-a-runtime')
  await mkdir(bad, { recursive: true })
  const result = await installRelease(root, bad, { id: 'r-bad' })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toContain('lib/bin.js')
})

it('rejects release ids that escape releases or address the current pointer', async () => {
  const root = await freshRoot()
  const source = await runtimeSource(root, 'safe')
  for (const id of ['../outside', '../../sessions', '/tmp/outside', 'current.json', '.', '..']) {
    expect((await installRelease(root, source, { id })).ok).toBe(false)
    expect((await useRelease(root, id)).ok).toBe(false)
  }
})

it('refuses gc on a corrupt pointer and preserves rollback when selecting the same release twice', async () => {
  const root = await freshRoot()
  const source = await runtimeSource(root, 'safe')
  await installRelease(root, source, { id: 'r-one' })
  await installRelease(root, source, { id: 'r-two' })
  await useRelease(root, 'r-one')
  await useRelease(root, 'r-two')
  await useRelease(root, 'r-two')
  expect((await readCurrent(root))?.previousReleaseId).toBe('r-one')
  await writeFile(join(root, 'releases', 'current.json'), '{torn')
  await expect(gcReleases(root)).rejects.toThrow()
  expect(await listReleases(root)).toEqual(['r-one', 'r-two'])
})

it('switches the current pointer atomically and chains the rollback target', async () => {
  const root = await freshRoot()
  const one = await runtimeSource(root, 'one')
  const two = await runtimeSource(root, 'two')
  await installRelease(root, one, { id: 'r-one' })
  expect(await useRelease(root, 'r-one')).toEqual({ ok: true, previousReleaseId: null })
  await installRelease(root, two, { id: 'r-two' })
  expect(await useRelease(root, 'r-two')).toEqual({ ok: true, previousReleaseId: 'r-one' })
  expect(await readCurrent(root)).toMatchObject({ releaseId: 'r-two', previousReleaseId: 'r-one' })
  const missing = await useRelease(root, 'r-missing')
  expect(missing.ok).toBe(false)
  if (!missing.ok) expect(missing.reason).toContain('not installed')
})

it('retains staging when gc cannot verify whether its installer is still active', async () => {
  const root = await freshRoot()
  await mkdir(join(root, 'releases', '.staging-r-torn'), { recursive: true })
  const source = await runtimeSource(root, 'one')
  await installRelease(root, source, { id: 'r-one' })
  await useRelease(root, 'r-one')
  expect(await listStaging(root)).toEqual(['.staging-r-torn'])
  const gc = await gcReleases(root)
  expect(gc.removedStaging).toEqual([])
  expect(gc.removedReleases).toEqual([])
  expect(gc.kept).toMatchObject({ 'r-one': 'current' })
  expect(gc.kept['.staging-r-torn']).toContain('ownership is unverified')
  expect(await listStaging(root)).toEqual(['.staging-r-torn'])
})

it('gc keeps current, the rollback target, and live-pinned releases', async () => {
  const root = await freshRoot()
  for (const marker of ['a', 'b', 'c', 'd']) {
    await installRelease(root, await runtimeSource(root, marker), { id: `r-${marker}` })
  }
  await useRelease(root, 'r-c')
  await useRelease(root, 'r-d')
  const gc = await gcReleases(root, new Map([['r-a', 'live service runs it']]))
  expect(gc.removedReleases).toEqual(['r-b'])
  expect(gc.kept).toMatchObject({ 'r-d': 'current', 'r-c': 'rollback target', 'r-a': 'live service runs it' })
  expect(await listReleases(root)).toEqual(['r-a', 'r-c', 'r-d'])
})

it('uninstall keeps unrelated data while purge removes the root', async () => {
  const root = await freshRoot()
  const keep = join(root, 'sessions', 'durable.json')
  await mkdir(dirname(keep), { recursive: true })
  await writeFile(keep, 'durable')
  await uninstallRoot(root, false)
  await expect(readFile(keep, 'utf8')).resolves.toBe('durable')
  await uninstallRoot(root, true)
  await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('copyTree preserves symlinks and launcherFor prefers the bundled node', async () => {
  const root = await freshRoot()
  const source = await runtimeSource(root, 'linked')
  await mkdir(join(source, 'bin'), { recursive: true })
  await writeFile(join(source, 'bin', 'node'), '#!/bin/sh\n')
  await symlink('lib', join(source, 'link-to-lib'))
  const target = join(root, 'copy')
  await copyTree(source, target)
  const linked = await lstat(join(target, 'link-to-lib'))
  expect(linked.isSymbolicLink()).toBe(true)
  expect(await launcherFor(target)).toBe(join(target, 'bin', 'node'))
  expect(await serviceCommandFor(target)).toMatchObject({
    command: join(target, 'bin', 'node'),
    args: [join(target, 'lib', 'bin.js'), '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'],
  })
  expect(await launcherFor(join(root, 'elsewhere'))).toBe(process.execPath)
})

it('run without a current release and without a command is a usage error; status reports the release state', async () => {
  const root = await freshRoot()
  expect(await supervisorCli(['--root', root, 'run'])).toBe(64)
  const source = await runtimeSource(root, 'one')
  await installRelease(root, source, { id: 'r-one' })
  await useRelease(root, 'r-one')
  await mkdir(join(root, 'releases', '.staging-r-x'), { recursive: true })
  const writes: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  try {
    expect(await supervisorCli(['--root', root, 'status'])).toBe(0)
  } finally {
    spy.mockRestore()
  }
  const report = JSON.parse(writes.join('')) as {
    current: { releaseId: string } | null
    releases: string[]
    staging: string[]
    liveReleaseHeld: string | null
  }
  expect(report).toMatchObject({
    current: { releaseId: 'r-one' },
    releases: ['r-one'],
    staging: ['.staging-r-x'],
    liveReleaseHeld: null,
  })
})
