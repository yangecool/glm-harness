import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { expect, it, onTestFinished } from 'vitest'
import type { IdentityPayload, SupervisorCommand, SupervisorOptions } from '../src/index.ts'
import {
  GhRemoteSupervisor,
  drainChild,
  isPidAlive,
  probeLock,
  readIdentity,
  supervisorCli,
  supervisorPaths,
} from '../src/index.ts'

/** The ready-line contract the fake children speak. */
const READY = 'gh-remote ready: http://127.0.0.1:1/token#x'

/**
 * Fast supervision settings: every timer budget is small, sleep resolves
 * immediately unless the test injects its own recorder.
 */
const fastOptions = (overrides: Partial<SupervisorOptions> = {}): Partial<SupervisorOptions> => ({
  readyTimeoutMs: 5_000,
  baseBackoffMs: 10,
  maxBackoffMs: 40,
  drainTimeoutMs: 2_000,
  crashThreshold: 100,
  crashWindowMs: 60_000,
  ...overrides,
})

/** A fresh data root per test, removed afterwards. */
const freshRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'gh-supervisor-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

const command = (script: string): SupervisorCommand => ({ command: process.execPath, args: ['-e', script] })

/** Child that becomes ready and stays alive until SIGTERM, which it honors promptly. */
const STAY_READY = `process.stdout.write(${JSON.stringify(READY)} + '\\n')
process.on('SIGTERM', () => { process.exit(0) })
setInterval(() => {}, 1 << 30)`

/** Child that becomes ready and then exits on its own — a supervised crash. */
const READY_THEN_EXIT = `process.stdout.write(${JSON.stringify(READY)} + '\\n')
setTimeout(() => { process.exit(1) }, 20)`

/** Child that never speaks the ready line — a ready-timeout crash. */
const NEVER_READY = 'setInterval(() => {}, 1 << 30)'

/** Child that ignores SIGTERM, so draining must escalate to SIGKILL. Handler armed before the ready line: readiness proves the trap. */
const STUBBORN = `process.on('SIGTERM', () => {})
process.stdout.write(${JSON.stringify(READY)} + '\\n')
setInterval(() => {}, 1 << 30)`

const waitUntil = async (probe: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition did not hold in time')
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
}

/** Read a root's identity via the module API, retrying absent reads with waitUntil instead. */
const awaitIdentity = async (root: string): Promise<IdentityPayload> => {
  let seen: IdentityPayload | null = null
  await waitUntil(async () => {
    seen = await readIdentity(supervisorPaths(root))
    return seen !== null
  })
  return seen!
}

it('reports pid liveness for live, dead, and malformed pids', async () => {
  expect(isPidAlive(process.pid)).toBe(true)
  expect(isPidAlive(0)).toBe(false)
  expect(isPidAlive(-1)).toBe(false)
  expect(isPidAlive(Number.NaN)).toBe(false)
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise<void>((resolve) => { exited.once('exit', () => { resolve() }) })
  expect(isPidAlive(exited.pid ?? -1)).toBe(false)
})

it('lays out lock and identity paths under the data root run directory', () => {
  const paths = supervisorPaths('/tmp/gh-root')
  expect(paths.lockDir).toBe(join('/tmp/gh-root', 'run', 'supervisor.lock'))
  expect(paths.identityFile).toBe(join('/tmp/gh-root', 'run', 'service.json'))
})

it('reads identities tolerantly: absent, malformed, foreign, and valid', async () => {
  const root = await freshRoot()
  const paths = supervisorPaths(root)
  expect(await readIdentity(paths)).toBe(null)
  await mkdir(join(root, 'run'), { recursive: true })
  await writeFile(paths.identityFile, 'not json')
  expect(await readIdentity(paths)).toBe(null)
  await writeFile(paths.identityFile, JSON.stringify({ kind: 'other', pid: 1, nonce: 'n' }))
  expect(await readIdentity(paths)).toBe(null)
  await writeFile(paths.identityFile, JSON.stringify({ kind: 'gh-remote-supervisor-identity', pid: 1.5, nonce: 'n' }))
  expect(await readIdentity(paths)).toBe(null)
  const valid: IdentityPayload = {
    kind: 'gh-remote-supervisor-identity', pid: 123, nonce: 'n', startedAt: 1,
    readyAt: 2, restarts: 0, circuitOpen: false, readyUrl: 'http://x', command: ['x'],
  }
  await writeFile(paths.identityFile, JSON.stringify(valid))
  expect(await readIdentity(paths)).toEqual(valid)
})

it('probes locks: absent, malformed, stale, and live', async () => {
  const root = await freshRoot()
  const paths = supervisorPaths(root)
  expect(await probeLock(paths)).toEqual({ locked: false, holderPid: null, lock: null })
  await mkdir(paths.lockDir, { recursive: true })
  await writeFile(join(paths.lockDir, 'lock.json'), '{ nope')
  expect((await probeLock(paths)).locked).toBe(false)
  await writeFile(join(paths.lockDir, 'lock.json'), JSON.stringify({ kind: 'other', pid: 1, nonce: 'n' }))
  expect((await probeLock(paths)).locked).toBe(false)
  await writeFile(join(paths.lockDir, 'lock.json'), JSON.stringify({
    kind: 'gh-remote-supervisor-lock', pid: 999_999_999, nonce: 'n', acquiredAt: 0, command: [],
  }))
  expect((await probeLock(paths)).locked).toBe(false)
  await writeFile(join(paths.lockDir, 'lock.json'), JSON.stringify({
    kind: 'gh-remote-supervisor-lock', pid: process.pid, nonce: 'n', acquiredAt: 0, command: [],
  }))
  const live = await probeLock(paths)
  expect(live.locked).toBe(true)
  expect(live.holderPid).toBe(process.pid)
})

it('acquires fresh roots, refuses live owners, steals stale ones, and loses races', async () => {
  const root = await freshRoot()
  const first = new GhRemoteSupervisor(root, command(STAY_READY), fastOptions())
  expect(await first.acquireLock()).toEqual({ ok: true })
  const lockRaw = JSON.parse(await readFile(join(first.paths.lockDir, 'lock.json'), 'utf8')) as { pid?: number; command?: string[] }
  expect(lockRaw.pid).toBe(process.pid)
  expect(lockRaw.command?.[0]).toBe(process.execPath)
  // Same-process second acquisition: the live-pid owner is this process from
  // the first supervisor — refused, never stolen from a live pid.
  const second = new GhRemoteSupervisor(root, command(STAY_READY), fastOptions())
  const refused = await second.acquireLock()
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.pid).toBe(process.pid)
  // Stale owner: replace the lock with a dead pid, then acquire.
  await writeFile(join(first.paths.lockDir, 'lock.json'), JSON.stringify({
    kind: 'gh-remote-supervisor-lock', pid: 999_999_999, nonce: 'n', acquiredAt: 0, command: [],
  }))
  expect((await second.acquireLock()).ok).toBe(true)
  // EEXIST race: a pre-created empty lock directory loses to nobody.
  const raced = new GhRemoteSupervisor(root, command(STAY_READY), fastOptions())
  const lost = await raced.acquireLock()
  expect(lost.ok).toBe(false)
})

it('runs a ready child, publishes identity and URL, and stops cleanly', async () => {
  const root = await freshRoot()
  const supervisor = new GhRemoteSupervisor(root, command(STAY_READY), fastOptions())
  const finished = supervisor.run()
  const identity = await awaitIdentity(root)
  await waitUntil(async () => (await readIdentity(supervisorPaths(root)))?.readyUrl === 'http://127.0.0.1:1/token#x')
  expect(identity.kind).toBe('gh-remote-supervisor-identity')
  expect(identity.pid).toBeGreaterThan(0)
  expect(isPidAlive(identity.pid)).toBe(true)
  await supervisor.stop()
  const outcome = await finished
  expect(outcome.reason).toBe('stopped')
  expect(outcome.exit?.code).toBe(0)
  expect(await readIdentity(supervisorPaths(root))).toBe(null)
  expect((await probeLock(supervisorPaths(root))).locked).toBe(false)
  await supervisor.stop()
})

it('detects the ready line after chatter and when split across chunks', async () => {
  const script = `process.stdout.write('booting…\\n')
process.stdout.write(${JSON.stringify(READY.slice(0, 8))})
setTimeout(() => { process.stdout.write(${JSON.stringify(READY.slice(8))} + '\\n') }, 60)
process.on('SIGTERM', () => { process.exit(0) })
setInterval(() => {}, 1 << 30)`
  const root = await freshRoot()
  const supervisor = new GhRemoteSupervisor(root, command(script), fastOptions())
  const finished = supervisor.run()
  await waitUntil(async () => (await readIdentity(supervisorPaths(root)))?.readyUrl === 'http://127.0.0.1:1/token#x')
  await supervisor.stop()
  expect((await finished).reason).toBe('stopped')
})

it('counts ready timeouts as crashes and drains the silent child', async () => {
  const root = await freshRoot()
  const supervisor = new GhRemoteSupervisor(root, command(NEVER_READY), fastOptions({ readyTimeoutMs: 150, crashThreshold: 1 }))
  const outcome = await supervisor.run()
  expect(outcome.reason).toBe('circuit-open')
  expect(outcome.detail).toContain('1 crashes')
  expect(supervisor.child).toBe(null)
})

it('restarts crashed children with capped exponential backoff and fresh pids', async () => {
  const delays: number[] = []
  const recorder = async (ms: number): Promise<void> => { delays.push(ms) }
  const root = await freshRoot()
  const supervisor = new GhRemoteSupervisor(root, command(READY_THEN_EXIT), fastOptions({
    baseBackoffMs: 10, maxBackoffMs: 25, sleep: recorder,
  }))
  const finished = supervisor.run()
  const pids: number[] = [await waitUntilIdentityPid(root)]
  for (let index = 0; index < 3; index += 1) {
    await waitUntil(async () => {
      const current = await readIdentity(supervisorPaths(root))
      return current !== null && !pids.includes(current.pid)
    })
    const current = (await readIdentity(supervisorPaths(root)))!
    pids.push(current.pid)
  }
  await supervisor.stop()
  await finished
  expect(delays.slice(0, 3)).toEqual([10, 20, 25])
  expect(new Set(pids).size).toBe(4)
})

/** Wait for the first published identity pid and return it. */
async function waitUntilIdentityPid(root: string): Promise<number> {
  return (await awaitIdentity(root)).pid
}

it('opens the circuit after the windowed crash threshold', async () => {
  const root = await freshRoot()
  const supervisor = new GhRemoteSupervisor(root, command(READY_THEN_EXIT), fastOptions({
    baseBackoffMs: 1, maxBackoffMs: 2, crashThreshold: 3, sleep: async () => {},
  }))
  const outcome = await supervisor.run()
  expect(outcome.reason).toBe('circuit-open')
  expect(supervisor.restarts).toBeGreaterThanOrEqual(2)
  expect(await readIdentity(supervisorPaths(root))).toBe(null)
})

it('reports spawn failures without hanging', async () => {
  const root = await freshRoot()
  const supervisor = new GhRemoteSupervisor(root, { command: '/nonexistent-gh-supervisor-probe', args: [] }, fastOptions())
  const outcome = await supervisor.run()
  expect(outcome.reason).toBe('spawn-error')
  expect((await probeLock(supervisorPaths(root))).locked).toBe(false)
})

it('drains graceful children with SIGTERM and stubborn ones with SIGKILL', async () => {
  const graceful = spawn(process.execPath, ['-e', STAY_READY], { stdio: ['ignore', 'pipe', 'ignore'] })
  await firstChunk(graceful.stdout)
  const outcome = await drainChild(graceful, 2_000)
  expect(outcome).toBe('terminated')
  // The stubborn child must have REGISTERED its SIGTERM handler before the
  // drain starts, or an early signal kills it before the test's point.
  const stubborn = spawn(process.execPath, ['-e', STUBBORN], { stdio: ['ignore', 'pipe', 'ignore'] })
  await firstChunk(stubborn.stdout)
  const escalated = await drainChild(stubborn, 150)
  expect(escalated).toBe('killed')
  expect(isPidAlive(graceful.pid ?? -1)).toBe(false)
  expect(isPidAlive(stubborn.pid ?? -1)).toBe(false)
})

/** Resolve with the stream's first data chunk — enough to await a ready line. */
function firstChunk(stream: Readable): Promise<string> {
  return new Promise((resolve) => { stream.once('data', (chunk: Buffer) => { resolve(chunk.toString('utf8')) }) })
}

it('CLI verbs: usage errors, empty status, unsupervised stop, and lock refusal exit codes', async () => {
  expect(await supervisorCli([])).toBe(64)
  expect(await supervisorCli(['--root'])).toBe(64)
  const root = await freshRoot()
  expect(await supervisorCli(['--root', root])).toBe(64)
  expect(await supervisorCli(['--root', root, 'run'])).toBe(64)
  expect(await supervisorCli(['--root', root, 'run', '--'])).toBe(64)
  expect(await supervisorCli(['--root', root, 'bogus'])).toBe(64)
  expect(await supervisorCli(['--root', root, 'restart'])).toBe(64)
  expect(await supervisorCli(['--root', root, 'stop'])).toBe(0)
  expect(await supervisorCli(['--root', root, 'status'])).toBe(0)
  // A live lock owned by this process refuses a CLI run with exit 69.
  const holder = new GhRemoteSupervisor(root, command(STAY_READY), fastOptions())
  expect((await holder.acquireLock()).ok).toBe(true)
  expect(await supervisorCli(['--root', root, 'run', '--', process.execPath, '-e', STAY_READY])).toBe(69)
  await rm(holder.paths.lockDir, { recursive: true, force: true })
})

it('CLI run supervises a real child over its lifecycle and exits 76 on spawn failure', async () => {
  const stable = await freshRoot()
  const cli = spawn(process.execPath, ['--import', 'tsx', join('packages/glm/remote-supervisor/src/index.ts'),
    '--root', stable, 'run', '--', process.execPath, '-e', STAY_READY], { cwd: process.cwd() })
  onTestFinished(() => { cli.kill('SIGKILL') })
  const identity = await awaitIdentity(stable)
  await waitUntil(async () => (await readIdentity(supervisorPaths(stable)))?.readyUrl === 'http://127.0.0.1:1/token#x')
  cli.kill('SIGTERM')
  const [cliCode] = await new Promise<[number | null]>((resolve) => { cli.once('exit', (code) => { resolve([code]) }) })
  expect(cliCode).toBe(0)
  expect(await readIdentity(supervisorPaths(stable))).toBe(null)
  expect(isPidAlive(identity.pid)).toBe(false)

  const crashRoot = await freshRoot()
  const crash = spawn(process.execPath, ['--import', 'tsx', join('packages/glm/remote-supervisor/src/index.ts'),
    '--root', crashRoot, 'run', '--', '/nonexistent-gh-supervisor-probe'], { cwd: process.cwd() })
  const [crashCode] = await new Promise<[number | null]>((resolve) => { crash.once('exit', (code) => { resolve([code]) }) })
  expect(crashCode).toBe(76)
  expect(await readIdentity(supervisorPaths(crashRoot))).toBe(null)
}, 30_000)

it('status verb reports a live supervised service', async () => {
  const root = await freshRoot()
  const supervisor = new GhRemoteSupervisor(root, command(STAY_READY), fastOptions())
  const finished = supervisor.run()
  const identity = await awaitIdentity(root)
  expect(identity.nonce).toBe(supervisor.nonce)
  expect(await supervisorCli(['--root', root, 'status'])).toBe(0)
  await supervisor.stop()
  await finished
  expect(await readIdentity(supervisorPaths(root))).toBe(null)
  expect((await probeLock(supervisorPaths(root))).locked).toBe(false)
})

it('stop verb stops the resident supervisor process and its child', async () => {
  const root = await freshRoot()
  const cli = spawn(process.execPath, ['--import', 'tsx', join('packages/glm/remote-supervisor/src/index.ts'),
    '--root', root, 'run', '--', process.execPath, '-e', STAY_READY], { cwd: process.cwd() })
  onTestFinished(() => { cli.kill('SIGKILL') })
  const exited = new Promise<[number | null]>((resolve) => { cli.once('exit', (code) => { resolve([code]) }) })
  const identity = await awaitIdentity(root)
  await waitUntil(async () => (await readIdentity(supervisorPaths(root)))?.readyUrl === 'http://127.0.0.1:1/token#x')
  expect(await supervisorCli(['--root', root, 'stop'])).toBe(0)
  const [cliCode] = await exited
  expect(cliCode).toBe(0)
  expect(isPidAlive(identity.pid)).toBe(false)
  expect(await readIdentity(supervisorPaths(root))).toBe(null)
  expect((await probeLock(supervisorPaths(root))).locked).toBe(false)
}, 30_000)

it('stop verb escalates when the supervised child ignores SIGTERM', async () => {
  const root = await freshRoot()
  const cli = spawn(process.execPath, ['--import', 'tsx', join('packages/glm/remote-supervisor/src/index.ts'),
    '--root', root, 'run', '--', process.execPath, '-e', STUBBORN], { cwd: process.cwd() })
  onTestFinished(() => { cli.kill('SIGKILL') })
  const exited = new Promise<[number | null]>((resolve) => { cli.once('exit', (code) => { resolve([code]) }) })
  const identity = await awaitIdentity(root)
  expect(isPidAlive(identity.pid)).toBe(true)
  // The CLI supervisor drains with the product default ladder (SIGTERM, 10s,
  // SIGKILL), so the stop verb observes the holder exiting on its own.
  expect(await supervisorCli(['--root', root, 'stop'])).toBe(0)
  const [cliCode] = await exited
  expect(cliCode).toBe(0)
  expect(isPidAlive(identity.pid)).toBe(false)
  expect(await readIdentity(supervisorPaths(root))).toBe(null)
}, 30_000)

it('run loop survives a SIGKILL of the child and republishes a fresh identity', async () => {
  const root = await freshRoot()
  const supervisor = new GhRemoteSupervisor(root, command(STAY_READY), fastOptions())
  const finished = supervisor.run()
  const first = await awaitIdentity(root)
  process.kill(first.pid, 'SIGKILL')
  await waitUntil(async () => {
    const current = await readIdentity(supervisorPaths(root))
    return current !== null && current.pid !== first.pid && current.readyUrl === 'http://127.0.0.1:1/token#x'
  })
  const second = await readIdentity(supervisorPaths(root))
  expect(second?.restarts).toBe(1)
  await supervisor.stop()
  expect((await finished).reason).toBe('stopped')
})
