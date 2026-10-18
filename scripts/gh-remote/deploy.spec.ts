import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, onTestFinished, vi } from 'vitest'
import { create as createTar } from 'tar'
import { bootstrapLifecycle, deployRuntime, ensureHostKey } from './deploy.ts'
import { fileDigest } from './artifact.ts'
import type { RemoteProbe } from './probe.ts'
import { remoteTargetSchema } from './targets.ts'

const capture = vi.hoisted(() => vi.fn<(argv: readonly string[], script: string, timeout: number) => Promise<string>>())
const probe = vi.hoisted(() => vi.fn<() => Promise<RemoteProbe>>())
vi.mock('./probe.ts', async importOriginal => ({ ...await importOriginal<typeof import('./probe.ts')>(), sshCapture: capture, probeRemote: probe }))
const run = promisify(execFile)
const target = remoteTargetSchema.parse({ name: 'fixture', host: '127.0.0.1', port: 22 })

it.each([false, true])('preserves literal arguments, environment, and %s absolute install paths', async (absolute) => {
  const root = await mkdtemp(join(tmpdir(), 'gh-deploy-argv-'))
  onTestFinished(async () => { capture.mockReset(); await rm(root, { recursive: true, force: true }) })
  const relative = "home with 'quotes' and $(touch should-not-exist)"
  const home = absolute ? join(root, relative) : relative
  const upload = join(root, relative, 'upload')
  await mkdir(upload, { recursive: true })
  await writeFile(join(upload, 'bootstrap.sh'), '#!/bin/sh\nfor arg do printf "%s\\0" "$arg"; done\nprintf "%s\\0%s\\0" "$GH_TEST_VALUE" "$GH_REMOTE_HOME"\n')
  // Feed the generated shell source as a literal sh -c argument; no SSH process
  // or remote machine is involved in this parser/executor regression.
  capture.mockImplementation(async (_argv, script) => (await run('sh', ['-c', script], { env: { ...process.env, HOME: root }, cwd: root })).stdout)
  const args = ['--', '--profile', 'gh-headless', "prompt 'quoted' ; $(touch should-not-exist)", '', '--']
  const value = "value with spaces; $(touch should-not-exist) 'end'"
  const output = await bootstrapLifecycle(target, join(root, 'known-hosts'), home, 'run', args, 5000, [`GH_TEST_VALUE=${value}`])
  expect(output.split('\0')).toEqual(['run', ...args, value, join(root, relative), ''])
})

it('rejects malformed environment assignments before opening a connection', async () => {
  capture.mockClear()
  await expect(bootstrapLifecycle(target, 'known-hosts', '.glmh', 'run', [], 5000, ['BAD NAME=value'])).rejects.toThrow('KEY=value')
  expect(capture).not.toHaveBeenCalled()
})

it.each([{ sshConfigAlias: 'lab' }, { proxyJump: 'bastion' }])('reports unfinished alias/jump deployment before scanning or uploading: %j', async (delegation) => {
  await expect(ensureHostKey({ ...target, ...delegation }, 'unused-known-hosts')).rejects.toThrow('not implemented')
})

it('rejects bytes changed during upload before extracting the target installer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gh-deploy-digest-'))
  onTestFinished(async () => {
    vi.unstubAllEnvs()
    capture.mockReset()
    probe.mockReset()
    await rm(root, { recursive: true, force: true })
  })
  const payload = join(root, 'gh-remote')
  const bin = join(root, 'bin')
  await mkdir(payload)
  await mkdir(bin)
  // Only the transfer binary and host probe are external fixtures; the local
  // archive reader and generated target shell run normally.
  await writeFile(join(bin, 'scp'), '#!/bin/sh\nwhile [ "$#" -gt 3 ]; do shift; done\ndest=${3#*:}\ncp "$1" "$2" "$dest"\n', { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  await writeFile(join(payload, 'bootstrap.sh'), '#!/bin/sh\nexit 99\n')
  await writeFile(join(payload, 'manifest.json'), JSON.stringify({
    format: 1, product: 'gh-remote-runtime', version: '0.2.1-rc.1', commit: 'a'.repeat(40), dirty: false,
    target: 'linux-x64', nodeVersion: process.version, entry: 'bootstrap.sh',
    files: [{ path: 'bootstrap.sh', sha256: await fileDigest(join(payload, 'bootstrap.sh')), mode: 0o644 }],
  }))
  const archive = join(root, 'payload.tar.gz')
  await createTar({ cwd: root, file: archive, gzip: true }, ['gh-remote'])
  await writeFile(`${archive}.sha256`, `${await fileDigest(archive)}  payload.tar.gz\n`)
  const knownHosts = join(root, 'known-hosts')
  await writeFile(knownHosts, '127.0.0.1 fixture-key\n')
  probe.mockResolvedValue({ kernel: 'Linux', machine: 'x86_64', arch: 'x64', target: 'linux-x64', libc: 'glibc', tools: { tar: true }, nodeOnTarget: false, homeFreeKb: 1000000, getconfLine: 'glibc' })
  const home = join(root, 'installed')
  capture.mockImplementation(async (_argv, script) => {
    if (script.includes('sha256sum -c -')) await appendFile(join(home, 'upload', 'payload.tar.gz'), 'changed in transit')
    try {
      return (await run('sh', ['-c', script], { cwd: root })).stdout
    } catch (error) {
      if (error instanceof Error && 'code' in error) throw new Error(`ssh exited ${String(error.code)}: ${error.message}`)
      throw error
    }
  })
  await expect(deployRuntime(target, { archive, knownHosts, home })).rejects.toMatchObject({ stage: 'verify-archive' })
  expect(existsSync(join(home, 'upload', 'bootstrap.sh'))).toBe(false)
})
