/** GH-006-G lifecycle transactions: the root's lifecycle lock, runtime id, and the commit verb. */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  acquireLifecycleLock, lifecycleProtectedReleases, LifecycleLockBusy, lifecycleLockPath, probeLifecycleLock,
} from '../src/lifecycle-lock.ts'
import { ensureRuntimeId, runtimeIdPath } from '../src/runtime-id.ts'
import { readCurrent, STAGING_PREFIX } from '../src/releases.ts'
import { supervisorCli } from '../src/index.ts'

/** A fresh data root per test, removed afterwards. */
const freshRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'gh-lifecycle-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

it('serializes lifecycle transactions: a live foreign holder is waited out, then the claim lands', async () => {
  const root = await freshRoot()
  // A real foreign holder: another process the lock payload names.
  const holder = spawn('sleep', ['5'])
  onTestFinished(() => { holder.kill('SIGKILL') })
  await new Promise((resolve) => { holder.once('spawn', resolve) })
  const foreign = {
    kind: 'gh-remote-lifecycle-lock', pid: holder.pid ?? -1, processIdentity: null, nonce: 'foreign',
    verb: 'update', startedAt: 1, protectedReleases: ['r-new'],
  }
  await mkdir(join(root, 'locks'), { recursive: true })
  await writeFile(lifecycleLockPath(root), `${JSON.stringify(foreign, null, 2)}\n`)
  await expect(acquireLifecycleLock(root, 'gc', { timeoutMs: 300, pollMs: 50 })).rejects.toBeInstanceOf(LifecycleLockBusy)
  holder.kill('SIGKILL')
  await once(holder, 'exit')
  const claimed = await acquireLifecycleLock(root, 'gc', { timeoutMs: 2_000, pollMs: 50 })
  expect(claimed.payload.verb).toBe('gc')
  await claimed.release()
  // Same-process reentrancy is a programming error, not a wait.
  const held = await acquireLifecycleLock(root, 'use', { timeoutMs: 500, pollMs: 50 })
  await expect(acquireLifecycleLock(root, 'use', { timeoutMs: 200, pollMs: 50 })).rejects.toThrow('already holds')
  await held.release()
})

it('reclaims a dead holder\'s claim and reports it as an interrupted transaction', async () => {
  const root = await freshRoot()
  const dead = {
    kind: 'gh-remote-lifecycle-lock', pid: 999_999_999, processIdentity: null, nonce: 'gone',
    verb: 'update', startedAt: 1, protectedReleases: ['r-mid'],
  }
  await mkdir(join(root, 'locks'), { recursive: true })
  await writeFile(lifecycleLockPath(root), `${JSON.stringify(dead, null, 2)}\n`)
  const probed = await probeLifecycleLock(root)
  expect(probed.lock?.verb).toBe('update')
  expect(probed.holderAlive).toBe(false)
  expect((await lifecycleProtectedReleases(root)).get('r-mid')).toBeUndefined()
  const claimed = await acquireLifecycleLock(root, 'gc', { timeoutMs: 1_000, pollMs: 50 })
  expect(claimed.payload.verb).toBe('gc')
  await claimed.release()
})

it('exposes a live transaction\'s protected releases to a gc pass', async () => {
  const root = await freshRoot()
  const held = await acquireLifecycleLock(root, 'commit', { protectedReleases: ['r-staged'] })
  const protectedIds = await lifecycleProtectedReleases(root)
  expect(protectedIds.get('r-staged')).toBe('commit')
  await held.release()
  expect((await lifecycleProtectedReleases(root)).size).toBe(0)
})

it('mints the runtime id once and keeps it stable', async () => {
  const root = await freshRoot()
  const first = await ensureRuntimeId(root)
  const again = await ensureRuntimeId(root)
  expect(again).toBe(first)
  expect(await readFile(runtimeIdPath(root), 'utf8')).toBe(`${first}\n`)
  // A corrupted file re-mints instead of surfacing garbage as identity.
  await writeFile(runtimeIdPath(root), 'not-a-uuid\n')
  const reminted = await ensureRuntimeId(root)
  expect(reminted).not.toBe(first)
  expect(reminted).toMatch(/^[0-9a-f-]{36}$/u)
})

it('commit adopts a staged release and switches the current pointer under one transaction', async () => {
  const root = await freshRoot()
  const staged = join(root, 'releases', `${STAGING_PREFIX}r-adopted`)
  await mkdir(join(staged, 'runtime', 'lib'), { recursive: true })
  await writeFile(join(staged, 'runtime', 'lib', 'bin.js'), 'console.log("archive shape")\n')
  await writeFile(join(staged, 'gh-release.json'), `${JSON.stringify({ kind: 'gh-remote-release', id: 'r-adopted', installedAt: 1 }, null, 2)}\n`)
  const code = await supervisorCli(['--root', root, 'commit', '--id', 'r-adopted'])
  expect(code).toBe(0)
  const current = await readCurrent(root)
  expect(current?.releaseId).toBe('r-adopted')
  // Staging is gone; the release is sealed in place.
  await expect(readFile(join(root, 'releases', 'r-adopted', 'runtime', 'lib', 'bin.js'), 'utf8')).resolves.toContain('archive shape')
})

it('commit refuses an id that is already installed and a staging that is absent', async () => {
  const root = await freshRoot()
  const installed = join(root, 'releases', 'r-there')
  await mkdir(join(installed, 'runtime', 'lib'), { recursive: true })
  await writeFile(join(installed, 'runtime', 'lib', 'bin.js'), 'console.log("there")\n')
  await writeFile(join(installed, 'gh-release.json'), `${JSON.stringify({ kind: 'gh-remote-release', id: 'r-there', installedAt: 1 }, null, 2)}\n`)
  expect(await supervisorCli(['--root', root, 'commit', '--id', 'r-there'])).toBe(74)
  expect(await supervisorCli(['--root', root, 'commit', '--id', 'r-never-staged'])).toBe(74)
})

it('status names the interrupted transaction and the runtime id', async () => {
  const root = await freshRoot()
  const dead = {
    kind: 'gh-remote-lifecycle-lock', pid: 999_999_999, processIdentity: null, nonce: 'gone',
    verb: 'rollback', startedAt: 42, protectedReleases: [],
  }
  await mkdir(join(root, 'locks'), { recursive: true })
  await writeFile(lifecycleLockPath(root), `${JSON.stringify(dead, null, 2)}\n`)
  const writes: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  const spy = (chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }
  process.stdout.write = spy
  try {
    expect(await supervisorCli(['--root', root, 'status'])).toBe(0)
  } finally {
    process.stdout.write = original
  }
  const report = JSON.parse(writes.join('')) as {
    runtimeId: string
    lifecycle: { verb: string; interrupted: boolean } | null
  }
  expect(report.runtimeId).toMatch(/^[0-9a-f-]{36}$/u)
  expect(report.lifecycle).toMatchObject({ verb: 'rollback', interrupted: true })
})
