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
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
  sleep: (ms: number) => Promise<void>
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
  sleep: (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) }),
}

/** Lock directory contents — the claim a live supervisor holds on a root. */
export interface LockPayload {
  /** Schema discriminator. */
  kind: 'gh-remote-supervisor-lock'
  /** OS pid of the supervisor process. */
  pid: number
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
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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
  private crashTimes: number[] = []
  private running = false
  private stopped = false

  /**
   * @param root - data root to own.
   * @param command - how to launch the supervised service.
   * @param overrides - partial behavior settings over the defaults.
   */
  constructor(root: string, command: SupervisorCommand, overrides?: Partial<SupervisorOptions>) {
    this.paths = supervisorPaths(root)
    this.options = { ...defaultOptions, ...overrides }
    this.command = command
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
    this.nonce = randomUUID()
    const payload: LockPayload = {
      kind: 'gh-remote-supervisor-lock',
      pid: process.pid,
      nonce: this.nonce,
      acquiredAt: this.options.now(),
      command: [this.command.command, ...this.command.args],
    }
    await mkdir(dirname(this.paths.identityFile), { recursive: true })
    // A stale lock (dead owner) keeps its directory; remove it before
    // claiming so the create below is the only acquisition step that can fail.
    if (probed.lock !== null) await rm(this.paths.lockDir, { recursive: true, force: true })
    try {
      await mkdir(this.paths.lockDir)
    } catch (error) {
      // EEXIST races a concurrent acquisition on an empty root; probe-then-
      // create converges for every loser because the winner is immediately live.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'lost the lock race', pid: null }
      throw error
    }
    await writeFile(join(this.paths.lockDir, 'lock.json'), `${JSON.stringify(payload, null, 2)}\n`)
    return { ok: true }
  }

  /** Rewrite the identity file to describe the current child. */
  private async writeIdentity(state: { pid: number; startedAt: number; readyAt?: number; readyUrl?: string }): Promise<void> {
    const nonce = this.nonce
    if (nonce === null) return
    const payload: IdentityPayload = {
      kind: 'gh-remote-supervisor-identity',
      pid: state.pid,
      nonce,
      startedAt: state.startedAt,
      readyAt: state.readyAt ?? null,
      restarts: this.restarts,
      circuitOpen: this.circuitOpen,
      readyUrl: state.readyUrl ?? this.readyUrl,
      command: [this.command.command, ...this.command.args],
    }
    const staging = `${this.paths.identityFile}.tmp-${randomUUID()}`
    await writeFile(staging, `${JSON.stringify(payload, null, 2)}\n`)
    await rename(staging, this.paths.identityFile)
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
    if (child.pid !== undefined) await this.writeIdentity({ pid: child.pid, startedAt })
    const timedOut = await this.awaitReady(child)
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
  private awaitReady(child: ChildProcess): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      let buffer = ''
      const settle = (timedOut: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(timedOut)
      }
      const timer = setTimeout(() => { settle(true) }, this.options.readyTimeoutMs)
      const onStdout = (chunk: string): void => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.startsWith(this.options.readyLinePrefix)) {
            this.readyUrl = line.slice(this.options.readyLinePrefix.length).trim()
            const readyAt = this.options.now()
            void this.writeIdentity({ pid: child.pid ?? -1, startedAt: readyAt, readyAt, readyUrl: this.readyUrl })
            settle(false)
          }
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
    await this.options.sleep(delay)
  }

  /** Request the loop stop and drain the live child. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.running && this.child) await drainChild(this.child, this.options.drainTimeoutMs)
  }

  /** Remove the identity file and the lock directory. */
  private async release(): Promise<void> {
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
  const usage = 'usage: gh-remote-supervisor [--root DIR] (run -- CMD [ARGS…] | stop | restart | status)'
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
  const commandOf = (args: string[]): SupervisorCommand | { error: string } => {
    if (args.length === 0 || args[0] !== '--') return { error: 'run requires `--` before the command' }
    const [command, ...commandArgs] = args.slice(1)
    if (!command) return { error: 'run requires a command after `--`' }
    return { command, args: commandArgs }
  }
  if (verb === 'run' || verb === 'restart') {
    let later: SupervisorCommand | { error: string }
    if (verb === 'run') {
      later = commandOf(verbArgs)
    } else {
      const identity = await readIdentity(paths)
      const [head, ...tail] = identity?.command ?? []
      later = identity !== null && head !== undefined && isPidAlive(identity.pid)
        ? { command: head, args: tail }
        : { error: `no live supervised service at ${root}` }
    }
    if ('error' in later) {
      process.stderr.write(`${later.error}\n`)
      return 64
    }
    if (verb === 'restart') await performStop(root)
    const supervisor = new GhRemoteSupervisor(root, later)
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
  if (verb === 'stop') return await performStop(root)
  if (verb === 'status') {
    const identity = await readIdentity(paths)
    process.stdout.write(`${JSON.stringify(identity)}\n`)
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
const performStop = async (root: string): Promise<number> => {
  const paths = supervisorPaths(root)
  const probed = await probeLock(paths)
  if (!probed.locked) {
    process.stderr.write(`gh-remote-supervisor: ${root} is not supervised\n`)
    return 0
  }
  const identity = await readIdentity(paths)
  const holder = probed.holderPid
  if (holder !== null && holder !== process.pid) {
    try {
      process.kill(holder, 'SIGTERM')
      const deadline = Date.now() + 15_000
      while (isPidAlive(holder) && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 100) })
      if (isPidAlive(holder)) process.kill(holder, 'SIGKILL')
    } catch {
      // The supervisor raced us to death; its own ladder already achieved the goal.
    }
  }
  if (identity !== null && isPidAlive(identity.pid)) {
    try {
      process.kill(identity.pid, 'SIGTERM')
      const deadline = Date.now() + 10_000
      while (isPidAlive(identity.pid) && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 100) })
      if (isPidAlive(identity.pid)) process.kill(identity.pid, 'SIGKILL')
    } catch {
      // The child raced us to death; the drain ladder already achieved the goal.
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
