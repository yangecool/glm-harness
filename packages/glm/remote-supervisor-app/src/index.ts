/**
 * @glm-harness/gh-remote-supervisor-app — the `gh-supervisor` profile surface.
 *
 * One Cordis plugin that runs the plain-Node supervision library as a product
 * surface: on boot it claims the data root (minting the persistent runtime id
 * when absent), resolves the current release, spawns the resident `gh-remote`
 * service child from that release under the shared home, and keeps the process
 * alive for exactly as long as the supervision loop runs — an explicit stop,
 * the crash circuit breaker, or a refused lock ends the runner through the
 * launcher's exit path with the loop's own exit code. Every tunable is
 * validated Config, so a deployment changes backoffs, drain budgets, and the
 * child's bind address from the profile patch instead of a rebuild.
 *
 * @module @glm-harness/gh-remote-supervisor-app
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import z from '@deepseek-ai/schemastery'
import {
  GhRemoteSupervisor, ensureRuntimeId, launcherFor, readCurrent, releaseEntry,
} from '@glm-harness/gh-remote-supervisor'

export { GhRemoteSupervisor } from '@glm-harness/gh-remote-supervisor'

/** The plugin's live configuration. */
export interface Config {
  /** Data root to supervise; empty reads GH_REMOTE_ROOT, then ~/.glmh-remote. */
  root: string
  /** DSH_HOME for the supervised child; empty uses `<root>/home` when present. */
  home: string
  /** Profile the supervised child boots. */
  childProfile: string
  /** Bind host the child's web transport listens on. */
  host: string
  /** Bind port the child's web transport listens on; `0` picks a free one. */
  port: string
  /** Wall-clock budget from spawn to the child's ready line. */
  readyTimeoutMs: number
  /** First crash backoff; doubles per restart up to {@link Config.maxBackoffMs}. */
  baseBackoffMs: number
  /** Backoff ceiling. */
  maxBackoffMs: number
  /** Grace period between SIGTERM and SIGKILL while draining the child. */
  drainTimeoutMs: number
  /** Crashes within {@link Config.crashWindowMs} that trip the circuit breaker. */
  crashThreshold: number
  /** Window the crash threshold counts over. */
  crashWindowMs: number
}

export const Config = z.object({
  root: z.string().default(''),
  home: z.string().default(''),
  childProfile: z.string().default('gh-remote'),
  host: z.string().default('127.0.0.1'),
  port: z.string().default('0'),
  readyTimeoutMs: z.number().default(60_000),
  baseBackoffMs: z.number().default(1_000),
  maxBackoffMs: z.number().default(60_000),
  drainTimeoutMs: z.number().default(10_000),
  crashThreshold: z.number().default(5),
  crashWindowMs: z.number().default(300_000),
})

/** The exit code a supervision outcome maps to; mirrors the CLI's contract. */
const exitCodeOf = (reason: 'stopped' | 'circuit-open' | 'lock-refused' | 'spawn-error'): number => {
  if (reason === 'circuit-open') return 75
  if (reason === 'lock-refused') return 69
  if (reason === 'spawn-error') return 76
  return 0
}

/**
 * The supervision surface. Constructed by the plugin entry; {@link booted}
 * settles once the child is spawned (or names why it could not be).
 */
export class GhSupervisorAppService extends Service {
  static inject = ['appExit']

  /** Boot settlement: resolves when the supervision loop is running. */
  readonly booted: Promise<void>

  private disposed = false
  private supervisor?: GhRemoteSupervisor
  private running?: Promise<void>

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'ghSupervisorApp')
    this.booted = this.boot()
    ctx.effect(() => async () => {
      this.disposed = true
      // A failed boot has no running child; apply owns its user-facing error.
      await this.booted.catch(() => undefined)
      await this.supervisor?.stop()
      await this.running
    })
  }

  private async boot(): Promise<void> {
    const root = this.config.root !== ''
      ? this.config.root
      : process.env.GH_REMOTE_ROOT !== undefined && process.env.GH_REMOTE_ROOT !== ''
        ? process.env.GH_REMOTE_ROOT
        : join(homedir(), '.glmh-remote')
    await ensureRuntimeId(root)
    const current = await readCurrent(root)
    if (current === null) {
      throw new Error(`gh-supervisor: no current release at ${root}; install one (bootstrap install) before starting the supervisor profile`)
    }
    const releaseDir = join(root, 'releases', current.releaseId)
    const entry = await releaseEntry(releaseDir)
    if (entry === null) {
      throw new Error(`gh-supervisor: release ${current.releaseId} has no runtime entry`)
    }
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (this.config.home !== '') env.DSH_HOME = this.config.home
    else if (env.DSH_HOME === undefined && existsSync(join(root, 'home'))) env.DSH_HOME = join(root, 'home')
    env.GH_REMOTE_ROOT = root
    env.GH_REMOTE_RELEASE_ID = current.releaseId
    const supervisor = new GhRemoteSupervisor(root, {
      command: await launcherFor(releaseDir),
      args: [entry, '--profile', this.config.childProfile, '--no-open', '--host', this.config.host, '--port', this.config.port],
      env,
    }, {
      readyTimeoutMs: this.config.readyTimeoutMs,
      baseBackoffMs: this.config.baseBackoffMs,
      maxBackoffMs: this.config.maxBackoffMs,
      drainTimeoutMs: this.config.drainTimeoutMs,
      crashThreshold: this.config.crashThreshold,
      crashWindowMs: this.config.crashWindowMs,
    }, current.releaseId)
    if (this.disposed) return
    this.supervisor = supervisor
    this.running = supervisor.run().then((outcome) => {
      if (outcome.reason !== 'stopped') {
        this.ctx.logger.error(`gh-supervisor: ${outcome.reason}: ${outcome.detail}`)
      }
      if (!this.disposed) {
        const exit = this.ctx.get('appExit')
        if (exit !== undefined) exit(exitCodeOf(outcome.reason))
      }
    })
  }
}

export const name = 'gh-remote-supervisor-app'
export const inject = ['appExit']

export function apply(ctx: Context, config: Config): void {
  const service = new GhSupervisorAppService(ctx, config)
  // Boot failures end the runner loudly: this profile composes no logger
  // console sink, so the reason goes to stderr directly.
  void service.booted.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`gh-supervisor: boot failed: ${message}\n`)
    const exit = ctx.get('appExit')
    if (exit !== undefined) exit(70)
  })
}
