/**
 * The real-bootstrap spec: exercises the rendered POSIX installer under /bin/sh
 * against fixture archives whose bundled "node" dispatches supervisor-CLI
 * invocations to the REAL supervisor library, so pointer switches, lifecycle
 * transactions, and status come from the product code the archive ships.
 */

import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { create as createTar } from 'tar'
import { artifactManifestSchema, fileDigest, payloadFiles } from './artifact.ts'
import { renderBootstrapScript } from './bootstrap.ts'

const run = promisify(execFile)

/** The real supervisor CLI the fake bundled node forwards delegation verbs to. */
const realSupervisorCli = resolve(import.meta.dirname, '../../packages/glm/remote-supervisor/lib/index.js')

interface Fixture {
  root: string
  home: string
  archive: (options?: {
    commit?: string
    target?: string
    tamperBytes?: boolean
    extraFile?: boolean
    extraLink?: boolean
    sidecar?: boolean
  }) => Promise<string>
}

/**
 * A payload builder plus an isolated install root. The bundled `bin/node` is a
 * dispatcher: supervisor-CLI invocations run the REAL library under the test
 * process's node; any other argv (the runtime entry) records its invocation
 * and exits non-zero, so run-style verbs end in the crash circuit the product
 * would hit for a non-service entry.
 */
async function fixture(entryBody = 'exit 3\n'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'gh-remote-bootstrap-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'install-root')
  const supervisorShim = [
    '#!/bin/sh',
    'case "$1" in',
    '  *gh-remote-supervisor/lib/index.js)',
    '    shift',
    `    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(realSupervisorCli)} "$@"`,
    '    ;;',
    '  *)',
    `    printf '%s\\n' ${JSON.stringify(entryBody)} > "$GH_REMOTE_ROOT/entry-invocation"`,
    '    printf ' + JSON.stringify('entry:%s home:%s root:%s') + ' "$*" "$DSH_HOME" "$GH_REMOTE_ROOT"',
    '    ;;',
    'esac',
  ].join('\n')
  const build = async (options: {
    commit?: string
    target?: string
    tamperBytes?: boolean
    extraFile?: boolean
    extraLink?: boolean
    sidecar?: boolean
  } = {}): Promise<string> => {
    const staging = join(root, `payload-${options.commit ?? 'aaaa'}`)
    const payload = join(staging, 'gh-remote')
    await mkdir(join(payload, 'bin'), { recursive: true })
    await mkdir(join(payload, 'runtime', 'lib'), { recursive: true })
    await mkdir(join(payload, 'runtime', 'node_modules', '@glm-harness', 'gh-remote-supervisor', 'lib'), { recursive: true })
    await mkdir(join(payload, 'home-template', 'profiles', 'gh-headless'), { recursive: true })
    await writeFile(join(payload, 'bootstrap.sh'), renderBootstrapScript())
    await chmod(join(payload, 'bootstrap.sh'), 0o755)
    await writeFile(join(payload, 'bin', 'node'), `${supervisorShim}\n`)
    await chmod(join(payload, 'bin', 'node'), 0o755)
    await writeFile(join(payload, 'runtime', 'lib', 'bin.js'), `// entry ${options.commit ?? 'aaaa'}\n`)
    await writeFile(join(payload, 'runtime', 'node_modules', '@glm-harness', 'gh-remote-supervisor', 'lib', 'index.js'), '// supervisor cli placeholder (the shim forwards)\n')
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
    if (options.extraLink === true) {
      const { symlink } = await import('node:fs/promises')
      await symlink('bin/node', join(payload, 'undeclared-link'))
    }
    await writeFile(join(payload, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    const archive = join(root, `archive-${options.commit ?? 'aaaa'}.tar.gz`)
    await createTar({ cwd: staging, file: archive, gzip: true, portable: true }, ['gh-remote'])
    if (options.sidecar !== false) {
      await writeFile(`${archive}.sha256`, `${await fileDigest(archive)}  archive-${options.commit ?? 'aaaa'}.tar.gz\n`)
    }
    if (options.tamperBytes === true) {
      const raw = await readFile(archive)
      const byte = raw.at(-20)
      if (byte === undefined) throw new Error('fixture archive too short to corrupt')
      raw[raw.length - 20] = byte ^ 0xff
      await writeFile(archive, raw)
    }
    return archive
  }
  return { root, home, archive: build }
}

interface Outcome { code: number; signal: string | null; stdout: string; stderr: string }

async function bootstrap(fixtureHome: string, command: string, ...args: string[]): Promise<Outcome> {
  return bootstrapWithEnvironment(fixtureHome, {}, command, ...args)
}

async function bootstrapWithEnvironment(
  fixtureHome: string, environment: NodeJS.ProcessEnv, command: string, ...args: string[]
): Promise<Outcome> {
  await mkdir(fixtureHome, { recursive: true })
  const script = join(fixtureHome, 'script.sh')
  await writeFile(script, renderBootstrapScript())
  await chmod(script, 0o755)
  try {
    const { stdout, stderr } = await run('sh', [script, command, ...args], { env: { ...process.env, ...environment, GH_REMOTE_HOME: fixtureHome }, timeout: 90_000 })
    return { code: 0, signal: null, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; signal?: string | null; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, signal: failure.signal ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/** The supervisor status document bootstrap's status verb forwards. */
const statusDocument = async (home: string): Promise<{
  current: { releaseId: string } | null
  releases: string[]
  runtimeId: string
  lifecycle: { verb: string } | null
}> => {
  const status = await bootstrap(home, 'status')
  expect(status.code).toBe(0)
  return JSON.parse(status.stdout) as never
}

it('installs through a real supervisor commit: home seeded, pointer set, staging consumed', async () => {
  const test = await fixture()
  const install = await bootstrap(test.home, 'install', await test.archive())
  expect(install.code).toBe(0)
  expect(install.stdout).toContain('probe ok')
  expect(install.stdout).toMatch(/activated \d{8}T\d{6}Z-aaaaaaaa/)
  await expect(readFile(join(test.home, 'home', 'profiles', 'gh-headless', 'package.json'), 'utf8')).resolves.toBe('{}\n')
  const status = await statusDocument(test.home)
  expect(status.current?.releaseId).toMatch(/^\d{8}T\d{6}Z-aaaaaaaa/u)
  expect(status.releases).toHaveLength(1)
  expect(status.runtimeId).toMatch(/^[0-9a-f-]{36}$/u)
  expect(status.lifecycle).toBeNull()
  // No staging leftover: the commit verb renamed it into the release store.
  expect(status.releases.every(id => !id.startsWith('.staging-'))).toBe(true)
})

it('run execs the supervisor profile from the current release with the shared home', { timeout: 120_000 }, async () => {
  const test = await fixture()
  await bootstrap(test.home, 'install', await test.archive())
  const runResult = await bootstrap(test.home, 'run')
  // The entry is not a real service, so the supervision loop ends in the
  // crash circuit — after recording exactly what it was asked to run.
  expect([0, 75]).toContain(runResult.code)
  expect(runResult.stdout).toContain('--profile gh-supervisor --no-open --host 127.0.0.1 --port 0')
  expect(runResult.stdout).toContain('/runtime/lib/bin.js')
  expect(runResult.stdout).toContain(`home:${join(test.home, 'home')}`)
  expect(runResult.stdout).toContain(`root:${test.home}`)
})

it('refuses tampered archives with the verify-archive stage code', async () => {
  const test = await fixture()
  const archive = await test.archive({ tamperBytes: true })
  const outcome = await bootstrap(test.home, 'install', archive)
  expect(outcome.code).toBe(91)
  expect(outcome.stderr).toContain('stage=verify-archive')
})

it('refuses archives without a checksum sidecar', async () => {
  const test = await fixture()
  const archive = await test.archive({ sidecar: false })
  const outcome = await bootstrap(test.home, 'install', archive)
  expect(outcome.code).toBe(91)
  expect(outcome.stderr).toContain('stage=verify-archive')
})

it('refuses mismatched target architectures at the probe stage', async () => {
  const test = await fixture()
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
  const test = await fixture()
  const archive = await test.archive({ extraFile: true })
  const outcome = await bootstrap(test.home, 'install', archive)
  expect(outcome.code).toBe(93)
  expect(outcome.stderr).toContain('stage=verify-payload')
})

it('rolls back to the previous release through the supervisor transaction', { timeout: 120_000 }, async () => {
  const test = await fixture()
  await bootstrap(test.home, 'install', await test.archive({ commit: 'a'.repeat(40) }))
  await bootstrap(test.home, 'install', await test.archive({ commit: 'b'.repeat(40) }))
  const before = await statusDocument(test.home)
  expect(before.current?.releaseId).toMatch(/bbbbbbbb/u)
  const rollback = await bootstrap(test.home, 'rollback')
  // The drain finds no live service; the switch lands; the supervise loop then
  // ends in the crash circuit against the non-service entry.
  expect([0, 75]).toContain(rollback.code)
  expect(rollback.stderr + rollback.stdout).toContain('no live service to drain')
  const after = await statusDocument(test.home)
  expect(after.current?.releaseId).toMatch(/aaaaaaaa/u)
})

it('updates to a staged release through install + drain + switch', { timeout: 120_000 }, async () => {
  const test = await fixture()
  await bootstrap(test.home, 'install', await test.archive({ commit: 'a'.repeat(40) }))
  const update = await bootstrap(test.home, 'update', await test.archive({ commit: 'c'.repeat(40) }))
  expect([0, 75]).toContain(update.code)
  const after = await statusDocument(test.home)
  expect(after.current?.releaseId).toMatch(/cccccccc/u)
  expect(after.releases).toHaveLength(2)
})

it('reports the runner stage when no release is active', async () => {
  const test = await fixture()
  const outcome = await bootstrap(test.home, 'status')
  expect(outcome.code).toBe(97)
  expect(outcome.stderr).toContain('stage=runner')
})

it('serializes concurrent installs through the lock', async () => {
  const test = await fixture()
  const archive = await test.archive({ commit: 'c'.repeat(40) })
  const first = bootstrap(test.home, 'install', archive)
  const second = bootstrap(test.home, 'install', archive)
  const [one, two] = await Promise.all([first, second])
  expect([one.code, two.code].sort()).toEqual([0, 0])
  const status = await statusDocument(test.home)
  expect(status.releases).toHaveLength(2)
})

it('keeps releases immutable when the same commit is installed twice in one second with --force', async () => {
  const test = await fixture()
  const clock = join(test.root, 'clock')
  await mkdir(clock)
  await writeFile(join(clock, 'date'), '#!/bin/sh\nprintf "20261018T000000Z\\n"\n', { mode: 0o755 })
  const environment = { PATH: `${clock}:${process.env.PATH}` }
  const archive = await test.archive()
  const first = await bootstrapWithEnvironment(test.home, environment, 'install', archive, '--force')
  const second = await bootstrapWithEnvironment(test.home, environment, 'install', archive, '--force')
  expect(first.code).toBe(0)
  expect(second.code).toBe(0)
  const status = await statusDocument(test.home)
  expect(status.releases).toHaveLength(2)
  expect(status.releases.every(id => id.startsWith('20261018T000000Z-aaaaaaaa'))).toBe(true)
})

it('uses the documented home when GH_REMOTE_HOME is unset', async () => {
  const test = await fixture()
  const archive = await test.archive()
  const hidden = join(test.root, 'home-env')
  await mkdir(join(hidden, '.glmh-remote'), { recursive: true })
  const script = join(test.root, 'no-env.sh')
  await writeFile(script, [
    '#!/bin/sh',
    `cd ${JSON.stringify(test.root)}`,
    `exec sh ${JSON.stringify(join(test.home, 'script.sh'))} install ${JSON.stringify(archive)}`,
  ].join('\n'))
  await chmod(script, 0o755)
  // The rendered script defaults ROOT to $HOME/.glmh-remote; point HOME at the
  // fixture so the default lands inside it.
  await writeFile(join(test.root, 'script-copy.sh'), renderBootstrapScript())
  await chmod(join(test.root, 'script-copy.sh'), 0o755)
  const outcome = await run('sh', [join(test.root, 'script-copy.sh'), 'install', archive], {
    env: { ...process.env, HOME: hidden, GH_REMOTE_HOME: '' },
    timeout: 90_000,
  }).then(() => ({ code: 0 }), (error: unknown) => ({ code: (error as { code?: number }).code ?? -1 }))
  expect(outcome.code).toBe(0)
  await expect(readFile(join(hidden, '.glmh-remote', 'home', 'profiles', 'gh-headless', 'package.json'), 'utf8')).resolves.toBe('{}\n')
})

it('refuses undeclared symbolic links before activating a release', async () => {
  const test = await fixture()
  const archive = await test.archive({ extraLink: true })
  const outcome = await bootstrap(test.home, 'install', archive)
  expect(outcome.code).toBe(92)
  expect(outcome.stderr).toContain('stage=extract')
})

it('stop delegates to the supervisor and is a clean no-op when nothing runs', async () => {
  const test = await fixture()
  await bootstrap(test.home, 'install', await test.archive())
  const stop = await bootstrap(test.home, 'stop')
  expect(stop.code).toBe(0)
  expect((stop.stderr + stop.stdout)).toContain('not supervised')
})
