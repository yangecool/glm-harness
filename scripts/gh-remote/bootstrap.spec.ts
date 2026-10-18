import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { create as createTar } from 'tar'
import { artifactManifestSchema, fileDigest, payloadFiles } from './artifact.ts'
import { renderBootstrapScript } from './bootstrap.ts'

const run = promisify(execFile)

interface Fixture {
  root: string
  home: string
  archive: (options?: {
    commit?: string
    target?: string
    tamperBytes?: boolean
    extraFile?: boolean
    sidecar?: boolean
  }) => Promise<string>
}

/** A payload builder plus an isolated install root for exercising the real bootstrap with /bin/sh. */
async function fixture(nodeBody: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'gh-remote-bootstrap-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'install-root')
  const build = async (options: {
    commit?: string
    target?: string
    tamperBytes?: boolean
    extraFile?: boolean
    sidecar?: boolean
  } = {}): Promise<string> => {
    const staging = join(root, `payload-${options.commit ?? 'aaaa'}`)
    const payload = join(staging, 'gh-remote')
    await mkdir(join(payload, 'bin'), { recursive: true })
    await mkdir(join(payload, 'runtime', 'lib'), { recursive: true })
    await mkdir(join(payload, 'home-template', 'profiles', 'gh-headless'), { recursive: true })
    await writeFile(join(payload, 'bootstrap.sh'), renderBootstrapScript())
    await chmod(join(payload, 'bootstrap.sh'), 0o755)
    await writeFile(join(payload, 'bin', 'node'), nodeBody)
    await chmod(join(payload, 'bin', 'node'), 0o755)
    await writeFile(join(payload, 'runtime', 'lib', 'bin.js'), `// entry ${options.commit ?? 'aaaa'}\n`)
    await writeFile(join(payload, 'home-template', 'profiles', 'gh-headless', 'package.json'), '{}\n')
    const metadata = artifactManifestSchema.parse({
      format: 1, product: 'gh-remote-runtime', version: '0.2.1-rc.1',
      commit: options.commit ?? 'a'.repeat(40), dirty: false,
      target: options.target ?? 'linux-x64', nodeVersion: process.version, entry: 'bootstrap.sh',
      files: await Promise.all((await payloadFiles(payload)).map(async path => ({
        path, sha256: await fileDigest(join(payload, path)), mode: (await lstat(join(payload, path))).mode & 0o777,
      }))),
    })
    if (options.extraFile === true) await writeFile(join(payload, 'undeclared.txt'), 'stowaway\n')
    await writeFile(join(payload, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    const archive = join(root, `archive-${options.commit ?? 'aaaa'}.tar.gz`)
    await createTar({ cwd: staging, file: archive, gzip: true, portable: true }, ['gh-remote'])
    if (options.sidecar !== false) {
      await writeFile(`${archive}.sha256`, `${await fileDigest(archive)}  archive-${options.commit ?? 'aaaa'}.tar.gz\n`)
    }
    if (options.tamperBytes === true) {
      const raw = await readFile(archive)
      raw[raw.length - 20] ^= 0xff
      await writeFile(archive, raw)
    }
    return archive
  }
  return { root, home, archive: build }
}

interface Outcome { code: number; signal: string | null; stdout: string; stderr: string }

async function bootstrap(fixtureHome: string, command: string, ...args: string[]): Promise<Outcome> {
  await mkdir(fixtureHome, { recursive: true })
  const script = join(fixtureHome, 'script.sh')
  await writeFile(script, renderBootstrapScript())
  await chmod(script, 0o755)
  try {
    const { stdout } = await run('sh', [script, command, ...args], { env: { ...process.env, GH_REMOTE_HOME: fixtureHome }, timeout: 60_000 })
    return { code: 0, signal: null, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { code?: number; signal?: string | null; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, signal: failure.signal ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

it('installs, seeds the home, activates atomically, and reports status', async () => {
  const test = await fixture('#!/bin/sh\nexit 0\n')
  const archive = await test.archive()
  const install = await bootstrap(test.home, 'install', archive)
  expect(install.code).toBe(0)
  expect(install.stdout).toContain('probe ok')
  expect(install.stdout).toMatch(/activated \d{8}T\d{6}Z-aaaaaaaa/)
  await expect(readFile(join(test.home, 'home', 'profiles', 'gh-headless', 'package.json'), 'utf8')).resolves.toBe('{}\n')
  const status = await bootstrap(test.home, 'status')
  expect(status.code).toBe(0)
  expect(status.stdout).toContain('release=')
  expect(status.stdout).toContain('version=0.2.1-rc.1')
  expect(status.stdout).toContain('pid=-')
  expect(status.stdout).toContain('alive=no')
})

it('execs the bundled node entry with the seeded home and passthrough arguments', async () => {
  const test = await fixture('#!/bin/sh\necho "args:$*" "home:$DSH_HOME"\n')
  await bootstrap(test.home, 'install', await test.archive())
  const runResult = await bootstrap(test.home, 'run', '--', '--profile', 'gh-headless', 'do work')
  expect(runResult.code).toBe(0)
  expect(runResult.stdout).toContain('args:')
  expect(runResult.stdout).toContain('--profile gh-headless do work')
  expect(runResult.stdout).toContain(`home:${join(test.home, 'home')}`)
})

it('refuses tampered archives with the verify-archive stage code', async () => {
  const test = await fixture('#!/bin/sh\nexit 0\n')
  const archive = await test.archive({ tamperBytes: true })
  const outcome = await bootstrap(test.home, 'install', archive)
  expect(outcome.code).toBe(91)
  expect(outcome.stderr).toContain('stage=verify-archive')
})

it('refuses archives without a checksum sidecar', async () => {
  const test = await fixture('#!/bin/sh\nexit 0\n')
  const archive = await test.archive({ sidecar: false })
  const outcome = await bootstrap(test.home, 'install', archive)
  expect(outcome.code).toBe(91)
  expect(outcome.stderr).toContain('stage=verify-archive')
})

it('refuses mismatched target architectures at the probe stage', async () => {
  const test = await fixture('#!/bin/sh\nexit 0\n')
  const archive = await test.archive({ target: 'linux-arm64' })
  const outcome = await bootstrap(test.home, 'install', archive)
  if (process.arch === 'x64') {
    expect(outcome.code).toBe(90)
    expect(outcome.stderr).toContain('stage=probe')
  } else {
    expect(outcome.code).toBe(0)
  }
})

it('refuses payloads carrying undeclared files after extraction', async () => {
  const test = await fixture('#!/bin/sh\nexit 0\n')
  const archive = await test.archive({ extraFile: true })
  const outcome = await bootstrap(test.home, 'install', archive)
  expect(outcome.code).toBe(93)
  expect(outcome.stderr).toContain('stage=verify-payload')
})

it('rolls back to the previous release after verifying it', async () => {
  const test = await fixture('#!/bin/sh\ncat "$0"\n')
  await bootstrap(test.home, 'install', await test.archive({ commit: 'a'.repeat(40) }))
  await bootstrap(test.home, 'install', await test.archive({ commit: 'b'.repeat(40) }))
  const status = await bootstrap(test.home, 'status')
  expect(status.stdout).toMatch(/commit=bbbbbbbb/)
  const rollback = await bootstrap(test.home, 'rollback')
  expect(rollback.code).toBe(0)
  expect(rollback.stdout).toContain('rolled back')
  const after = await bootstrap(test.home, 'status')
  expect(after.stdout).toMatch(/commit=aaaaaaaa/)
})

it('reports the runner stage when no release is active', async () => {
  const test = await fixture('#!/bin/sh\nexit 0\n')
  const outcome = await bootstrap(test.home, 'status')
  expect(outcome.code).toBe(97)
  expect(outcome.stderr).toContain('stage=runner')
})

it('serializes concurrent installs through the lock', async () => {
  const test = await fixture('#!/bin/sh\nexit 0\n')
  const archive = await test.archive({ commit: 'c'.repeat(40) })
  const first = bootstrap(test.home, 'install', archive, '--force')
  const second = bootstrap(test.home, 'install', archive, '--force')
  const [one, two] = await Promise.all([first, second])
  expect([one.code, two.code].sort()).toEqual([0, 0])
  const status = await bootstrap(test.home, 'status')
  expect(status.code).toBe(0)
})
