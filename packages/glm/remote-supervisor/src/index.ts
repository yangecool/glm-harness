/**
 * @glm-harness/gh-remote-supervisor — plain-Node process supervision for a
 * resident gh-remote service. One data root admits exactly one supervised
 * child: a lock directory pins the owner, an identity file publishes the
 * running child, readiness waits for a stdout contract line, crashes restart
 * on a bounded backoff until a circuit breaker stops the loop, and stop or
 * restart drains the same child the identity names. No framework imports, so
 * the same module runs beside any runtime archive.
 * @module @glm-harness/gh-remote-supervisor
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  gcReleases, installRelease, listReleases, listStaging, readCurrent,
  releaseEntry, serviceCommandFor, STAGING_PREFIX, uninstallRoot, useRelease, validReleaseId,
} from './releases.ts'
import {
  acquireLifecycleLock, LifecycleLockBusy, lifecycleProtectedReleases, probeLifecycleLock,
  type LifecycleTransaction,
} from './lifecycle-lock.ts'
import { ensureRuntimeId, runtimeIdPath } from './runtime-id.ts'

export {
  acquireLifecycleLock, LifecycleLockBusy, lifecycleProtectedReleases, probeLifecycleLock,
} from './lifecycle-lock.ts'
export type { LifecycleLockPayload, LifecycleLockProbe, LifecycleTransaction } from './lifecycle-lock.ts'
export { ensureRuntimeId, runtimeIdPath } from './runtime-id.ts'
export * from './releases.ts'

/** Layout inside a data root owned by {@link GhRemoteSupervisor}. */
export interface SupervisorPaths {
  /** The data root the supervisor owns. */
  root: string
  /** Single-instance lock directory; presence means some supervisor claims this root. */
  lockDir: string
  /** Published identity of the supervised child, rewritten on every restart. */
  identityFile: string
}

/** How the supervised child is launched. */
export interface SupervisorCommand {
  /** Executable to run. */
  command: string
  /** Arguments passed to the executable. */
  args: string[]
  /** Environment for the child; defaults to inheriting the supervisor's. */
  env?: NodeJS.ProcessEnv
  /** Working directory for the child; defaults to the supervisor's cwd. */
  cwd?: string
}

/** Tunable supervision behavior; every field has a product default. */
export interface SupervisorOptions {
  /** Required stdout prefix that marks the child ready; the rest of the line is the service URL. */
  readyLinePrefix: string
  /** Wall-clock budget from spawn to the ready line before the child counts as crashed. */
  readyTimeoutMs: number
  /** First crash backoff; doubles per restart up to {@link SupervisorOptions.maxBackoffMs}. */
  baseBackoffMs: number
  /** Backoff ceiling. */
  maxBackoffMs: number
  /** Grace period between SIGTERM and SIGKILL while draining. */
  drainTimeoutMs: number
  /** Crashes within {@link SupervisorOptions.crashWindowMs} that trip the circuit breaker. */
  crashThreshold: number
  /** Window the crash threshold counts over. */
  crashWindowMs: number
  /** Injected clock for tests. */
  now: () => number
  /** Injected sleep for tests. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

const defaultOptions: SupervisorOptions = {
  readyLinePrefix: 'gh-remote ready: ',
  readyTimeoutMs: 60_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  drainTimeoutMs: 10_000,
  crashThreshold: 5,
  crashWindowMs: 5 * 60_000,
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }),
}

/** Lock directory contents — the claim a live supervisor holds on a root. */
export interface LockPayload {
  /** Schema discriminator. */
  kind: 'gh-remote-supervisor-lock'
  /** OS pid of the supervisor process. */
  pid: number
  /** Kernel boot and process-start identity; absent in older records. */
  processIdentity?: string | null
  /** Random per-acquisition token; ownership checks compare this, not pids alone. */
  nonce: string
  /** Epoch milliseconds the lock was acquired. */
  acquiredAt: number
  /** The supervised command, for diagnostics. */
  command: string[]
}

/** Identity file contents — what is running right now. */
export interface IdentityPayload {
  /** Schema discriminator. */
  kind: 'gh-remote-supervisor-identity'
  /** OS pid of the supervised child. */
  pid: number
  /** Kernel boot and process-start identity used before signaling a recorded pid. */
  processIdentity?: string | null
  /** The launch nonce shared with the lock; proves the identity is this supervisor's child. */
  nonce: string
  /** Epoch milliseconds the child was spawned. */
  startedAt: number
  /** Epoch milliseconds the ready line was observed; null until then. */
  readyAt: number | null
  /** Completed restarts so far; 0 on the first child. */
  restarts: number
  /** Whether the circuit breaker has stopped the restart loop. */
  circuitOpen: boolean
  /** The authenticated service URL from the latest ready line. */
  readyUrl: string | null
  /** The release the service runs from, when the supervisor launched it out of `releases/`. */
  releaseId: string | null
  /** The supervised command. */
  command: string[]
}

/**
 * Whether an OS pid is alive. Signal 0 only decides liveness; {@link process.kill}
 * throws for missing permission even on live pids, which still proves liveness.
 * @param pid - the OS pid to probe.
 * @returns true when the pid names a live process.
 */
export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '')) return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }
  return true
}

/**
 * Read Linux process birth identity without trusting a pid reused after exit or reboot.
 * @param pid - positive process id to inspect.
 * @returns boot id and kernel start ticks, or null when identity cannot be established.
 */
export const readProcessIdentity = async (pid: number): Promise<string | null> => {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    const [boot, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = fields[19]
    return ticks !== undefined && /^\d+$/u.test(ticks) ? `${boot.trim()}:${ticks}` : null
  } catch (error) {
    // A vanished or inaccessible process cannot authorize a later signal.
    void error
    return null
  }
}

/** Path layout for a data root.
 * @param root - the data root to lay out.
 * @returns the lock and identity paths under it.
 */
export const supervisorPaths = (root: string): SupervisorPaths => ({
  root,
  lockDir: join(root, 'run', 'supervisor.lock'),
  identityFile: join(root, 'run', 'service.json'),
})

/**
 * Read a root's identity file, if present and well-formed. A malformed file
 * reads as absent: the writer atomically replaces the file, so a torn read
 * only means "between writes".
 * @param paths - the data root's path layout.
 * @returns the parsed identity, or null when absent or malformed.
 */
export const readIdentity = async (paths: SupervisorPaths): Promise<IdentityPayload | null> => {
  let raw: string
  try {
    raw = await readFile(paths.identityFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<IdentityPayload>
    if (candidate.kind !== 'gh-remote-supervisor-identity') return null
    if (!Number.isInteger(candidate.pid) || typeof candidate.nonce !== 'string') return null
    return parsed as IdentityPayload
  } catch {
    return null
  }
}

/** What {@link probeLock} observed about a data root's lock. */
export interface LockProbe {
  /** Whether a lock with a live owner pid holds the root. */
  locked: boolean
  /** The live owner pid when one holds the root. */
  holderPid: number | null
  /** The parsed lock payload when one exists. */
  lock: LockPayload | null
}

/**
 * Whether a data root is claimable: no lock directory, or a lock whose owner
 * is gone. A lock held by any live pid — foreign or a former incarnation of
 * this process — means the root is busy and must be refused, not stolen.
 * @param paths - the data root's path layout.
 * @returns the lock observation for acquisition decisions.
 */
export const probeLock = async (paths: SupervisorPaths): Promise<LockProbe> => {
  let raw: string
  try {
    raw = await readFile(join(paths.lockDir, 'lock.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { locked: false, holderPid: null, lock: null }
    throw error
  }
  let lock: LockPayload | null = null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = parsed as Partial<LockPayload>
      if (candidate.kind === 'gh-remote-supervisor-lock' && Number.isInteger(candidate.pid) && typeof candidate.nonce === 'string') {
        lock = parsed as LockPayload
      }
    }
  } catch {
    lock = null
  }
  if (!lock) return { locked: false, holderPid: null, lock: null }
  if (isPidAlive(lock.pid)) return { locked: true, holderPid: lock.pid, lock }
  return { locked: false, holderPid: null, lock }
}

/**
 * Send SIGTERM, wait out the grace period, then SIGKILL, and wait for exit.
 * Never throws: draining must run its full ladder even when the child misbehaves
 * or never spawned at all — both end events settle the same wait. The grace
 * timer is cleared when the child wins the race, so a graceful drain leaves
 * nothing holding the supervisor's event loop open.
 * @param child - the process to drain.
 * @param timeoutMs - the SIGTERM-to-SIGKILL grace period.
 * @returns how the child ended: 'terminated' on SIGTERM or natural exit, 'killed' after SIGKILL.
 */
export const drainChild = async (
  child: ChildProcess,
  timeoutMs: number,
): Promise<'terminated' | 'killed'> => {
  const dead = (): boolean => child.exitCode !== null || child.signalCode !== null
  // An already-dead child never emits 'exit' again; observing death here is
  // the only reliable settle for the window between exit and listener attach.
  if (dead()) return 'terminated'
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => { resolve() })
    child.once('error', () => { resolve() })
  })
  if (dead()) return 'terminated'
  child.kill('SIGTERM')
  let graceTimer: NodeJS.Timeout | undefined
  const grace = new Promise<boolean>((resolve) => { graceTimer = setTimeout(() => { resolve(false) }, timeoutMs) })
  const settled = await Promise.race([exited.then(() => true), grace])
  clearTimeout(graceTimer)
  if (settled) return 'terminated'
  try {
    child.kill('SIGKILL')
  } catch {
    // The race already waited for exit; a dead kill target is success.
  }
  await exited
  return 'killed'
}

/** Why {@link GhRemoteSupervisor.run} returned. */
export type RunReason = 'stopped' | 'circuit-open' | 'lock-refused' | 'spawn-error'

/** The supervision loop's final report. */
export interface RunOutcome {
  /** Which ending condition fired. */
  reason: RunReason
  /** Human-readable detail for logs. */
  detail: string
  /** The last child's exit observation, when one was spawned. */
  exit: { code: number | null; signal: NodeJS.Signals | null } | null
}

/**
 * The supervisor. Construct, {@link GhRemoteSupervisor.run | run} (or one of
 * the verbs), and await the returned result. Instances are single-use.
 */
export class GhRemoteSupervisor {
  /** Resolved paths derived from the data root. */
  readonly paths: SupervisorPaths
  /** Behavior settings in force. */
  readonly options: SupervisorOptions
  /** The command under supervision. */
  readonly command: SupervisorCommand
  /** This acquisition's lock nonce, once {@link GhRemoteSupervisor.acquireLock | acquired}. */
  nonce: string | null = null
  /** The current child process, if one is spawned. */
  child: ChildProcess | null = null
  /** Completed restarts of the current supervision session. */
  restarts = 0
  /** Whether the circuit breaker has opened and stopped the loop. */
  circuitOpen = false
  /** The authenticated service URL of the latest ready line. */
  readyUrl: string | null = null
  /** The release this supervisor's child runs from, when launched out of `releases/`. */
  readonly releaseId: string | null
  private crashTimes: number[] = []
  private running = false
  private stopped = false
  private readonly stopController = new AbortController()
  private identityWrite: Promise<void> = Promise.resolve()

  /**
   * @param root - data root to own.
   * @param command - how to launch the supervised service.
   * @param overrides - partial behavior settings over the defaults.
   * @param releaseId - release the command was derived from, recorded on the identity.
   */
  constructor(root: string, command: SupervisorCommand, overrides?: Partial<SupervisorOptions>, releaseId: string | null = null) {
    this.paths = supervisorPaths(root)
    this.options = { ...defaultOptions, ...overrides }
    this.command = command
    this.releaseId = releaseId
  }

  /**
   * Claim the data root. An existing lock whose owner pid is alive (any
   * process, including this one from an earlier incarnation) is refused; a
   * stale lock — dead owner — is replaced.
   * @returns the refusal reason when another live owner holds the root.
   */
  async acquireLock(): Promise<{ ok: true } | { ok: false; reason: string; pid: number | null }> {
    const probed = await probeLock(this.paths)
    const holder = probed.lock?.pid ?? null
    if (probed.locked && holder !== null) {
      return {
        ok: false,
        reason: holder === process.pid
          ? 'this process already holds the lock'
          : `lock held by live pid ${holder}`,
        pid: holder,
      }
    }
    // Stealing a dead supervisor's lock must not spawn a second service over
    // one still running: the orphaned child keeps the root's data and port.
    {
      const orphan = await readIdentity(this.paths)
      if (orphan !== null && isPidAlive(orphan.pid)) {
        return {
          ok: false,
          reason: `previous supervisor died but its service (pid ${orphan.pid}) still runs; run stop first`,
          pid: orphan.pid,
        }
      }
    }
    this.nonce = randomUUID()
    const payload: LockPayload = {
      kind: 'gh-remote-supervisor-lock',
      pid: process.pid,
      processIdentity: await readProcessIdentity(process.pid),
      nonce: this.nonce,
      acquiredAt: this.options.now(),
      command: [this.command.command, ...this.command.args],
    }
    await mkdir(dirname(this.paths.identityFile), { recursive: true, mode: 0o700 })
    // A stale lock (dead owner) keeps its directory; remove it before
    // claiming so the create below is the only acquisition step that can fail.
    let reclaim: string | undefined
    if (probed.lock !== null) {
      reclaim = `${this.paths.lockDir}.reclaim-${createHash('sha256').update(JSON.stringify(probed.lock)).digest('hex')}`
      try {
        await writeFile(reclaim, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'stale lock takeover in progress', pid: null }
        throw error
      }
    }
    try {
      if (probed.lock !== null) {
        const latest = await probeLock(this.paths)
        if (latest.locked || JSON.stringify(latest.lock) !== JSON.stringify(probed.lock)) {
          return { ok: false, reason: 'lock owner changed during takeover', pid: latest.holderPid }
        }
        await rm(this.paths.lockDir, { recursive: true, force: true })
      }
      await mkdir(this.paths.lockDir, { mode: 0o700 })
      await writeFile(join(this.paths.lockDir, 'lock.json'), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      // EEXIST races a concurrent acquisition on an empty root; probe-then-
      // create converges for every loser because the winner is immediately live.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'lost the lock race', pid: null }
      throw error
    } finally {
      if (reclaim !== undefined) await rm(reclaim, { force: true })
    }
    return { ok: true }
  }

  /** Rewrite the identity file to describe the current child. */
  private async writeIdentity(state: { pid: number; startedAt: number; readyAt?: number; readyUrl?: string }): Promise<void> {
    const nonce = this.nonce
    if (nonce === null) return
    const payload: IdentityPayload = {
      kind: 'gh-remote-supervisor-identity',
      pid: state.pid,
      processIdentity: await readProcessIdentity(state.pid),
      nonce,
      startedAt: state.startedAt,
      readyAt: state.readyAt ?? null,
      restarts: this.restarts,
      circuitOpen: this.circuitOpen,
      readyUrl: state.readyUrl ?? this.readyUrl,
      releaseId: this.releaseId,
      command: [this.command.command, ...this.command.args],
    }
    const write = async (): Promise<void> => {
      const staging = `${this.paths.identityFile}.tmp-${randomUUID()}`
      await writeFile(staging, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(staging, this.paths.identityFile)
    }
    this.identityWrite = this.identityWrite.then(write)
    await this.identityWrite
  }

  /** One spawn–supervise cycle; resolves when the child is dead. */
  private async runChild(): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
    const startedAt = this.options.now()
    const child = spawn(this.command.command, this.command.args, {
      env: this.command.env,
      cwd: this.command.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Attach every end listener synchronously: spawn errors and exits can
    // fire before any awaited step that follows. The error rides the same
    // resolution so no closure-narrowed flag is needed.
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>((resolve) => {
      child.once('exit', (code, signal) => { resolve({ code, signal, error: null }) })
      child.once('error', (error) => { resolve({ code: null, signal: null, error }) })
    })
    this.child = child
    // A new child is not ready yet: reset the announced URL so the identity
    // never points at a previous incarnation's listener.
    this.readyUrl = null
    const initialIdentity = child.pid === undefined ? Promise.resolve() : this.writeIdentity({ pid: child.pid, startedAt })
    const [, timedOut] = await Promise.all([initialIdentity, this.awaitReady(child, startedAt, initialIdentity)])
    if (timedOut) await drainChild(child, this.options.drainTimeoutMs)
    const outcome = await ended
    this.child = null
    if (outcome.error !== null) throw outcome.error
    return timedOut
      ? { code: null, signal: null, timedOut: true }
      : { code: outcome.code, signal: outcome.signal, timedOut: false }
  }

  /**
   * Watch stdout for the ready line. Resolves false once seen (recording
   * readiness and the URL), true when the budget runs out; a child death or
   * spawn error before either resolves false and lets the exit path own the
   * observation. Stderr forwards to this process's stderr for diagnostics;
   * stdout beyond the contract line is dropped.
   */
  private awaitReady(child: ChildProcess, startedAt: number, initialIdentity: Promise<void>): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false
      let announced = false
      let buffer = ''
      let oversized = false
      const settle = (timedOut: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        buffer = ''
        resolve(timedOut)
      }
      const timer = setTimeout(() => { settle(true) }, this.options.readyTimeoutMs)
      const onStdout = (chunk: string): void => {
        if (settled || announced) return
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!oversized && line.length <= 16_384 && line.startsWith(this.options.readyLinePrefix)) {
            this.readyUrl = line.slice(this.options.readyLinePrefix.length).trim()
            announced = true
            const readyAt = this.options.now()
            const readyUrl = this.readyUrl
            clearTimeout(timer)
            void initialIdentity.then(() => this.writeIdentity({ pid: child.pid ?? -1, startedAt, readyAt, readyUrl }))
              .then(() => { settle(false) }, reject)
            buffer = ''
            return
          }
          oversized = false
        }
        if (buffer.length > 16_384) {
          oversized = true
          buffer = ''
        }
      }
      if (child.stdout) {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', onStdout)
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => { process.stderr.write(chunk) })
      }
      child.once('exit', () => { settle(false) })
      child.once('error', () => { settle(false) })
    })
  }

  /** Record a crash and open the circuit when the windowed threshold trips. */
  private registerCrash(): void {
    const now = this.options.now()
    this.crashTimes.push(now)
    this.crashTimes = this.crashTimes.filter(t => now - t <= this.options.crashWindowMs)
    if (this.crashTimes.length >= this.options.crashThreshold) this.circuitOpen = true
  }

  /**
   * The main supervision loop: claim the root, then spawn–supervise–restart
   * until an explicit stop or the circuit breaker opens. Resolves only after
   * the child is dead and the identity file is cleared.
   * @returns why the loop ended and how the last child went down.
   */
  async run(): Promise<RunOutcome> {
    const acquired = await this.acquireLock()
    if (!acquired.ok) return { reason: 'lock-refused', detail: acquired.reason, exit: null }
    this.running = true
    let lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
    while (!this.stopped && !this.circuitOpen) {
      let observation: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }
      try {
        observation = await this.runChild()
      } catch (error) {
        if (this.child !== null) await drainChild(this.child, this.options.drainTimeoutMs)
        this.child = null
        this.running = false
        await this.release()
        return { reason: 'spawn-error', detail: String(error), exit: null }
      }
      lastExit = { code: observation.code, signal: observation.signal }
      if (this.stopRequested()) break
      this.registerCrash()
      if (this.stopRequested() || this.breakerOpen()) break
      await this.backoff()
    }
    this.running = false
    await this.release()
    return this.circuitOpen
      ? { reason: 'circuit-open', detail: `${this.crashTimes.length} crashes within ${this.options.crashWindowMs}ms`, exit: lastExit }
      : { reason: 'stopped', detail: 'stop requested', exit: lastExit }
  }

  /**
   * Read the stop flag through a call: `stop()` mutates it from signal
   * handlers and races, which the compiler's flow analysis cannot see across
   * awaits inside the supervision loop.
   */
  private stopRequested(): boolean {
    return this.stopped
  }

  /**
   * Read the circuit flag through a call: {@link registerCrash} opens it
   * mid-loop, which flow analysis cannot see either.
   */
  private breakerOpen(): boolean {
    return this.circuitOpen
  }

  /** Backoff before the next restart; an explicit stop during the wait wins. */
  private async backoff(): Promise<void> {
    const delay = Math.min(this.options.baseBackoffMs * 2 ** this.restarts, this.options.maxBackoffMs)
    this.restarts += 1
    try {
      await this.options.sleep(delay, this.stopController.signal)
    } catch (error) {
      if (!this.stopped) throw error
    }
  }

  /** Request the loop stop and drain the live child. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.stopController.abort()
    if (this.running && this.child) await drainChild(this.child, this.options.drainTimeoutMs)
  }

  /** Remove the identity file and the lock directory. */
  private async release(): Promise<void> {
    await this.identityWrite
    await rm(this.paths.identityFile, { force: true })
    await rm(this.paths.lockDir, { recursive: true, force: true })
  }
}

/**
 * `lib/index.js` doubles as the CLI. The verbs:
 *
 * - `run [--root DIR] -- COMMAND [ARGS…]` — supervise until stopped.
 * - `stop [--root DIR]` — drain the root's live child and release the root.
 * - `restart [--root DIR]` — stop, then a fresh supervisor run in-process.
 * - `status [--root DIR]` — print the identity JSON, or `null`.
 *
 * Signals: SIGTERM/SIGINT drain and exit 0. Exit codes: 0 clean stop or
 * successful verb; 64 usage; 69 lock refused; 75 circuit open; 76 spawn error.
 * @param argv - arguments after the program name.
 * @returns the process exit code.
 */
export const supervisorCli = async (argv: string[]): Promise<number> => {
  const usage = 'usage: gh-remote-supervisor [--root DIR] (run [-- CMD [ARGS…]] | stop | restart | status'
    + ' | install --from DIR [--id ID] [--note NOTE] | commit --id ID [--note NOTE] | use ID'
    + ' | update (--from DIR | --release ID) [--drain-timeout MS] | rollback [--drain-timeout MS]'
    + ' | gc | uninstall [--purge])'
  const readRoot = (args: string[]): { root: string; rest: string[] } | { error: string } => {
    const [flag, root] = args
    if (args.length < 2 || flag !== '--root' || root === undefined) return { error: usage }
    return { root, rest: args.slice(2) }
  }
  const parsed = readRoot(argv)
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`)
    return 64
  }
  const { root, rest } = parsed
  const [verb, ...verbArgs] = rest
  const paths = supervisorPaths(root)
  const commandOf = (args: readonly string[]): SupervisorCommand | { error: string } => {
    if (args.length === 0 || args[0] !== '--') return { error: 'run requires `--` before the command' }
    const [command, ...commandArgs] = args.slice(1)
    if (!command) return { error: 'run requires a command after `--`' }
    return { command, args: commandArgs }
  }
  /** Read options of the form `--flag value` out of a verb's arguments. */
  const readFlags = (args: readonly string[]): { flags: Map<string, string>; rest: string[] } => {
    const flags = new Map<string, string>()
    const spare: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg !== undefined && arg.startsWith('--') && index + 1 < args.length) {
        flags.set(arg.slice(2), args[index + 1] as string)
        index += 1
        continue
      }
      if (arg !== undefined) spare.push(arg)
    }
    return { flags, rest: spare }
  }
  /** Resolve a command for run-style verbs: explicit `--` command, else the current release. */
  const commandOrRelease = async (
    args: readonly string[],
  ): Promise<{ command: SupervisorCommand; releaseId: string | null } | { error: string }> => {
    if (args.length > 0 && args[0] === '--') {
      const command = commandOf(args)
      return 'error' in command ? command : { command, releaseId: null }
    }
    const current = await readCurrent(root)
    if (current === null) return { error: `no current release at ${root}; install one or pass run -- CMD` }
    const command = await serviceCommandFor(join(root, 'releases', current.releaseId))
    return { command, releaseId: current.releaseId }
  }
  /** Parse a millisecond flag value, tolerating underscore separators. */
  const readMillis = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw?.replaceAll('_', ''))
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  /**
   * The supervised child's environment: the supervisor's own environment plus
   * the shared home (when the root has one), the root address for the
   * handshake RPCs, and the release the child runs from.
   */
  const childEnvironment = (releaseId: string | null): NodeJS.ProcessEnv => {
    const env = { ...process.env }
    const home = join(root, 'home')
    if (env.DSH_HOME === undefined && existsSync(home)) env.DSH_HOME = home
    env.GH_REMOTE_ROOT = root
    if (releaseId !== null) env.GH_REMOTE_RELEASE_ID = releaseId
    return env
  }
  /**
   * Run one verb body under the root's lifecycle transaction lock: mutating
   * verbs never interleave, and a failure maps to its exit code with the
   * transaction always released.
   */
  const runLifecycle = async <T>(
    verb: string,
    options: { protectedReleases?: readonly string[] },
    body: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; code: number }> => {
    let tx: LifecycleTransaction
    try {
      tx = await acquireLifecycleLock(root, verb, options)
    } catch (error) {
      process.stderr.write(`gh-remote-supervisor: ${error instanceof Error ? error.message : String(error)}\n`)
      return { ok: false, code: error instanceof LifecycleLockBusy ? 69 : 74 }
    }
    try {
      return { ok: true, value: await body() }
    } catch (error) {
      process.stderr.write(`gh-remote-supervisor: ${verb} failed: ${error instanceof Error ? error.message : String(error)}\n`)
      return { ok: false, code: 74 }
    } finally {
      await tx.release()
    }
  }
  /** Authenticate one live service; only a verified absence skips drain. */
  const serviceSession = async (signal: AbortSignal): Promise<
    { kind: 'absent' } | { kind: 'ready'; origin: string; cookie: string } | { kind: 'failed'; error: string }
  > => {
    const identity = await readIdentity(paths)
    if (identity === null || !isPidAlive(identity.pid)) {
      const lock = await probeLock(paths)
      if (lock.locked || identity === null && existsSync(paths.identityFile)) {
        return { kind: 'failed', error: 'the service state is unverified or restarting; refusing version switch' }
      }
      return { kind: 'absent' }
    }
    const readyUrl = identity.readyUrl
    if (readyUrl === null) return { kind: 'failed', error: 'live service is not ready; refusing version switch' }
    try {
      const exchange = await fetch(readyUrl, { redirect: 'manual', signal })
      if (!exchange.ok && exchange.status !== 302 && exchange.status !== 303) {
        return { kind: 'failed', error: 'service authentication failed; refusing version switch' }
      }
      const cookie = exchange.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ')
      return { kind: 'ready', origin: new URL(readyUrl).origin, cookie }
    } catch (error) {
      void error
      return { kind: 'failed', error: 'service authentication is unavailable or timed out; refusing version switch' }
    }
  }
  /** One authenticated RPC; callers validate the operation-specific fields. */
  const ghRemoteCall = async <V extends object>(
    session: { origin: string; cookie: string }, method: string, payload: unknown, signal: AbortSignal,
  ): Promise<V | { error: string }> => {
    try {
      const response = await fetch(new URL(`/api/${method}`, session.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: session.cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: `supervisor-${randomUUID()}`, method, payload: { args: payload } }),
        signal,
      })
      const envelope = await response.json() as { result?: { ok?: boolean; value?: unknown } } | null
      if (!response.ok || typeof envelope !== 'object' || envelope === null || envelope.result?.ok !== true) {
        return { error: `rpc ${method} failed with HTTP ${String(response.status)}` }
      }
      const value = envelope.result.value
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: `rpc ${method} returned invalid data` }
      return value as V
    } catch (error) {
      void error
      return { error: `rpc ${method} is unavailable or timed out` }
    }
  }
  /** Close new work, then drain within one deadline; a failed drain restores its prior open gate. */
  const drainActivity = async (timeoutMs: number): Promise<{ ok: boolean; detail: string }> => {
    if (timeoutMs <= 0) return { ok: false, detail: 'the drain budget is exhausted; refusing version switch' }
    const deadline = Date.now() + timeoutMs
    const signal = AbortSignal.timeout(timeoutMs)
    const session = await serviceSession(signal)
    if (session.kind === 'absent') return { ok: true, detail: 'no live service to drain' }
    if (session.kind === 'failed') return { ok: false, detail: session.error }
    const describe = await ghRemoteCall<{ capabilities?: unknown; admission?: unknown }>(session, 'ghRemote/describe', {}, signal)
    if ('error' in describe) return { ok: false, detail: `${describe.error}; refusing version switch` }
    if (!Array.isArray(describe.capabilities) || !describe.capabilities.includes('admission-close')
      || describe.admission !== 'open' && describe.admission !== 'closed') {
      return { ok: false, detail: 'live release cannot prove admission closure; stop it explicitly before switching' }
    }
    const fail = async (detail: string): Promise<{ ok: false; detail: string }> => {
      if (describe.admission === 'open') {
        const restored = await ghRemoteCall<{ admission?: unknown }>(session, 'ghRemote/admission', { request: { action: 'open' } }, AbortSignal.timeout(timeoutMs))
        detail += !('error' in restored) && restored.admission === 'open'
          ? '; prior open admissions restored'
          : '; admission recovery is unverified; query or restart the service before sending new work'
      }
      return { ok: false, detail }
    }
    const closed = await ghRemoteCall<{ admission?: unknown }>(session, 'ghRemote/admission', { request: { action: 'close' } }, signal)
    if ('error' in closed || closed.admission !== 'closed') return await fail('admission close failed; refusing version switch')
    let last = -1
    while (Date.now() < deadline) {
      const counts = await ghRemoteCall<{ runningAgents?: number; ownedActivity?: number }>(session, 'ghRemote/activity', {}, signal)
      if ('error' in counts || counts.runningAgents === undefined || counts.ownedActivity === undefined
        || !Number.isSafeInteger(counts.runningAgents) || !Number.isSafeInteger(counts.ownedActivity)
        || counts.runningAgents < 0 || counts.ownedActivity < 0) {
        return await fail('activity query failed or omitted owned work; refusing version switch')
      }
      last = counts.runningAgents + counts.ownedActivity
      if (last === 0 && Date.now() < deadline) return { ok: true, detail: 'new admissions closed; activity idle before switch' }
      if (Date.now() < deadline) await sleep(Math.min(500, deadline - Date.now()))
    }
    return await fail(`activity did not drain (${String(last)} resources) within ${String(timeoutMs)}ms; refusing version switch`)
  }
  /** The supervision loop behind run-style verbs, ending in a process exit code. */
  const supervise = async (command: SupervisorCommand, releaseId: string | null): Promise<number> => {
    const supervisor = new GhRemoteSupervisor(root, command, undefined, releaseId)
    const signaled = { signal: null as NodeJS.Signals | null }
    const onSignal = (signal: NodeJS.Signals): void => {
      signaled.signal = signal
      void supervisor.stop()
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
    const outcome = await supervisor.run()
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    if (outcome.reason === 'circuit-open') {
      process.stderr.write(`gh-remote-supervisor: circuit open: ${outcome.detail}\n`)
      return 75
    }
    if (outcome.reason === 'lock-refused') {
      process.stderr.write(`gh-remote-supervisor: ${outcome.detail}\n`)
      return 69
    }
    if (outcome.reason === 'spawn-error') {
      process.stderr.write(`gh-remote-supervisor: spawn failed: ${outcome.detail}\n`)
      return 76
    }
    if (signaled.signal !== null) process.stderr.write(`gh-remote-supervisor: drained on ${signaled.signal}\n`)
    return 0
  }
  if (verb === 'install') {
    const { flags } = readFlags(verbArgs)
    const from = flags.get('from')
    if (from === undefined) {
      process.stderr.write('install requires --from DIR\n')
      return 64
    }
    const id = flags.get('id') ?? `r-${Date.now()}-${randomUUID().slice(0, 8)}`
    const note = flags.get('note')
    const result = await runLifecycle('install', { protectedReleases: [id] }, async () => installRelease(root, from, {
      id,
      ...(note === undefined ? {} : { note }),
    }))
    if (!result.ok) return result.code
    if (!result.value.ok) {
      process.stderr.write(`gh-remote-supervisor: ${result.value.reason}\n`)
      return 69
    }
    process.stdout.write(`${result.value.releaseId}\n`)
    return 0
  }
  if (verb === 'commit') {
    const { flags } = readFlags(verbArgs)
    const id = flags.get('id')
    if (id === undefined || !validReleaseId(id)) {
      process.stderr.write('commit requires --id ID (the staging release bootstrap extracted)\n')
      return 64
    }
    const note = flags.get('note')
    const result = await runLifecycle('commit', { protectedReleases: [id] }, async (): Promise<string> => {
      const final = join(root, 'releases', id)
      try {
        await readFile(join(final, 'gh-release.json'), 'utf8')
        throw new Error(`release ${id} is already installed; releases are immutable`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const staged = join(root, 'releases', `${STAGING_PREFIX}${id}`)
      if (await releaseEntry(staged) === null) {
        throw new Error(`no staged release at ${staged}; bootstrap extracts there before committing`)
      }
      await readFile(join(staged, 'gh-release.json'), 'utf8')
      await rename(staged, final)
      const switched = await useRelease(root, id)
      if (!switched.ok) throw new Error(switched.reason)
      if (note !== undefined) {
        const manifest = join(final, 'gh-release.json')
        const parsed = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>
        await writeFile(manifest, `${JSON.stringify({ ...parsed, note }, null, 2)}\n`)
      }
      return id
    })
    if (!result.ok) return result.code
    process.stdout.write(`${result.value}\n`)
    return 0
  }
  if (verb === 'use') {
    const [releaseId] = verbArgs
    if (releaseId === undefined) {
      process.stderr.write('use requires a release id\n')
      return 64
    }
    const result = await runLifecycle('use', {}, async () => useRelease(root, releaseId))
    if (!result.ok) return result.code
    if (!result.value.ok) {
      process.stderr.write(`gh-remote-supervisor: ${result.value.reason}\n`)
      return 64
    }
    process.stdout.write(`${JSON.stringify(result.value)}\n`)
    return 0
  }
  if (verb === 'gc') {
    const result = await runLifecycle('gc', {}, async () => {
      const protect = new Map<string, string>()
      const identity = await readIdentity(paths)
      const owner = await probeLock(paths)
      if (identity?.releaseId !== null && identity?.releaseId !== undefined && (isPidAlive(identity.pid) || owner.locked)) {
        protect.set(identity.releaseId, 'service or supervisor still owns the release')
      }
      for (const [id, reason] of await lifecycleProtectedReleases(root)) protect.set(id, reason)
      return await gcReleases(root, protect)
    })
    if (!result.ok) return result.code
    process.stdout.write(`${JSON.stringify(result.value)}\n`)
    return 0
  }
  if (verb === 'uninstall') {
    const purge = verbArgs.includes('--purge')
    const result = await runLifecycle('uninstall', {}, async (): Promise<number> => {
      const stopped = await performStop(root)
      if (stopped !== 0) return stopped
      await uninstallRoot(root, purge)
      return 0
    })
    if (!result.ok) return result.code
    if (result.value !== 0) return result.value
    process.stdout.write(purge ? 'uninstalled (root purged)\n' : 'uninstalled (data kept)\n')
    return 0
  }
  if (verb === 'update' || verb === 'rollback') {
    const { flags } = readFlags(verbArgs)
    let targetId: string
    if (verb === 'update') {
      const from = flags.get('from')
      const release = flags.get('release')
      if (from !== undefined && from !== flags.get('release')) {
        const id = flags.get('id') ?? `r-${Date.now()}-${randomUUID().slice(0, 8)}`
        const note = flags.get('note')
        const installed = await runLifecycle('update-install', { protectedReleases: [id] }, async () => installRelease(root, from, {
          id,
          ...(note === undefined ? {} : { note }),
        }))
        if (!installed.ok) return installed.code
        if (!installed.value.ok) {
          process.stderr.write(`gh-remote-supervisor: ${installed.value.reason}\n`)
          return 69
        }
        targetId = installed.value.releaseId
      } else if (release !== undefined) {
        targetId = release
      } else {
        process.stderr.write('update requires --from DIR or --release ID\n')
        return 64
      }
    } else {
      const current = await readCurrent(root)
      if (current === null || current.previousReleaseId === null) {
        process.stderr.write(`gh-remote-supervisor: no previous release to roll back to at ${root}\n`)
        return 64
      }
      targetId = current.previousReleaseId
    }
    const switched = await runLifecycle(verb, { protectedReleases: [targetId] }, async () => {
      const drain = await drainActivity(readMillis(flags.get('drain-timeout'), 30_000))
      process.stderr.write(`gh-remote-supervisor: ${drain.detail}\n`)
      if (!drain.ok) return 69
      const stopped = await performStop(root)
      if (stopped !== 0) return stopped
      const used = await useRelease(root, targetId)
      if (!used.ok) return 64
      return 0
    })
    if (!switched.ok) return switched.code
    if (switched.value !== 0) return switched.value
    const later = await commandOrRelease([])
    if ('error' in later) {
      process.stderr.write(`${later.error}\n`)
      return 64
    }
    await ensureRuntimeId(root)
    return await supervise({ ...later.command, env: childEnvironment(later.releaseId) }, later.releaseId)
  }
  if (verb === 'run' || verb === 'restart') {
    let later: { command: SupervisorCommand; releaseId: string | null } | { error: string }
    if (verb === 'run') {
      later = await commandOrRelease(verbArgs)
    } else {
      const identity = await readIdentity(paths)
      const [head, ...tail] = identity?.command ?? []
      later = identity !== null && head !== undefined && isPidAlive(identity.pid)
        ? { command: { command: head, args: tail }, releaseId: identity.releaseId ?? null }
        : { error: `no live supervised service at ${root}` }
      if (!('error' in later)) {
        const stopped = await runLifecycle('restart', {}, async () => performStop(root))
        if (!stopped.ok) return stopped.code
        if (stopped.value !== 0) return stopped.value
      }
    }
    if ('error' in later) {
      process.stderr.write(`${later.error}\n`)
      return 64
    }
    await ensureRuntimeId(root)
    return await supervise({ ...later.command, env: childEnvironment(later.releaseId) }, later.releaseId)
  }
  if (verb === 'stop') {
    const { flags } = readFlags(verbArgs)
    const timeout = flags.has('timeout') ? readMillis(flags.get('timeout'), 15_000) : undefined
    const stopped = await runLifecycle('stop', {}, async () => performStop(root, timeout))
    return stopped.ok ? stopped.value : stopped.code
  }
  if (verb === 'status') {
    const identity = await readIdentity(paths)
    const current = await readCurrent(root)
    const lock = await probeLifecycleLock(root)
    const runtimeId = await ensureRuntimeId(root).catch(() => null)
    process.stdout.write(`${JSON.stringify({
      identity,
      current,
      releases: await listReleases(root),
      staging: await listStaging(root),
      liveReleaseHeld: identity?.releaseId !== null && identity?.releaseId !== undefined && isPidAlive(identity.pid)
        ? identity.releaseId
        : null,
      runtimeId,
      runtimeIdPath: runtimeIdPath(root),
      lifecycle: lock.lock === null
        ? null
        : { ...lock.lock, holderAlive: lock.holderAlive, interrupted: !lock.holderAlive },
    })}\n`)
    return 0
  }
  process.stderr.write(`${usage}\n`)
  return 64
}

/**
 * Stop verb body. Stopping the resident service means stopping its
 * supervisor, which owns the lock and drains its own child: SIGTERM the lock
 * holder, escalate to SIGKILL if it wedges, then kill any child a SIGKILLed
 * supervisor left behind (per its identity file), and clear the leftovers.
 */
const performStop = async (root: string, timeoutMs?: number): Promise<number> => {
  const paths = supervisorPaths(root)
  const probed = await probeLock(paths)
  const identity = await readIdentity(paths)
  const holder = probed.locked ? probed.holderPid : null
  // A root is stoppable while either its supervisor or the service a crashed
  // supervisor orphaned is still alive; otherwise stop is a clean no-op.
  const orphaned = identity !== null && isPidAlive(identity.pid) ? identity.pid : null
  if (holder === null && orphaned === null) {
    process.stderr.write(`gh-remote-supervisor: ${root} is not supervised\n`)
    await rm(paths.identityFile, { force: true })
    await rm(paths.lockDir, { recursive: true, force: true })
    return 0
  }
  if (holder !== null && holder !== process.pid) {
    const expected = probed.lock?.processIdentity
    if (!expected || await readProcessIdentity(holder) !== expected) {
      process.stderr.write('gh-remote-supervisor: supervisor process identity is unverified; refusing to signal\n')
      return 69
    }
    try {
      process.kill(holder, 'SIGTERM')
      const deadline = Date.now() + (timeoutMs ?? 15_000)
      while (isPidAlive(holder) && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 100) })
      if (isPidAlive(holder)) {
        if (await readProcessIdentity(holder) !== expected) return 69
        process.kill(holder, 'SIGKILL')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 69
    }
  } else if (holder === process.pid) {
    process.stderr.write('gh-remote-supervisor: stop must run outside the owning supervisor process\n')
    return 69
  }
  if (identity !== null && isPidAlive(identity.pid)) {
    const expected = identity.processIdentity
    if (!expected || await readProcessIdentity(identity.pid) !== expected
      || probed.lock !== null && probed.lock.nonce !== identity.nonce) {
      process.stderr.write('gh-remote-supervisor: service process identity is unverified; refusing to signal\n')
      return 69
    }
    try {
      process.kill(identity.pid, 'SIGTERM')
      const deadline = Date.now() + (timeoutMs ?? 10_000)
      while (isPidAlive(identity.pid) && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 100) })
      if (isPidAlive(identity.pid)) {
        if (await readProcessIdentity(identity.pid) !== expected) return 69
        process.kill(identity.pid, 'SIGKILL')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 69
    }
  }
  await rm(paths.identityFile, { force: true })
  await rm(paths.lockDir, { recursive: true, force: true })
  return 0
}

// CLI entry: this module executing as lib/index.js (or its src twin via tsx) supervises directly.
const invokedAsProgram = typeof process.argv[1] === 'string'
  && (process.argv[1].endsWith('lib/index.js') || process.argv[1].endsWith('remote-supervisor/src/index.ts'))
if (invokedAsProgram) {
  void supervisorCli(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
