/**
 * The data root's lifecycle transaction lock: one exclusive claim every
 * mutating verb (install, commit, use, update, rollback, gc, uninstall, stop,
 * restart) holds for its whole transaction, so no two lifecycle operations
 * interleave. Plain Node, mirroring the supervision module's discipline: the
 * holder is identified by pid plus kernel boot/start identity and a nonce, a
 * dead holder's claim is reclaimed, and the payload names the verb and the
 * releases it protects so `status` can report an interrupted transaction.
 * @module @glm-harness/gh-remote-supervisor/lifecycle-lock
 */

import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isPidAlive, readProcessIdentity } from './index.ts'

/** Lock file contents — the transaction in flight, or the one that was interrupted. */
export interface LifecycleLockPayload {
  /** Schema discriminator. */
  kind: 'gh-remote-lifecycle-lock'
  /** OS pid of the transaction holder. */
  pid: number
  /** Kernel boot and process-start identity; absent on platforms without /proc. */
  processIdentity?: string | null
  /** Random per-acquisition token. */
  nonce: string
  /** The verb whose transaction holds the lock. */
  verb: string
  /** Epoch milliseconds the transaction started. */
  startedAt: number
  /** Release ids the transaction protects from a concurrent gc pass. */
  protectedReleases: string[]
}

/**
 * The lock file's address inside a data root.
 * @param root - the supervisor data root.
 * @returns the lifecycle lock's absolute path.
 */
export const lifecycleLockPath = (root: string): string => join(root, 'locks', 'lifecycle.lock')

/** Parse raw lock bytes; null when the file is absent. */
const parseLock = (raw: string): LifecycleLockPayload | null => {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed === 'object' && parsed !== null) {
    const candidate = parsed as Partial<LifecycleLockPayload>
    if (candidate.kind === 'gh-remote-lifecycle-lock' && typeof candidate.pid === 'number'
      && typeof candidate.nonce === 'string' && typeof candidate.verb === 'string'
      && Number.isFinite(candidate.startedAt) && Array.isArray(candidate.protectedReleases)) {
      return parsed as LifecycleLockPayload
    }
  }
  return null
}

/** The observed lock state a `status` report names. */
export interface LifecycleLockProbe {
  /** The payload on disk, when one is. */
  lock: LifecycleLockPayload | null
  /** Whether the recorded holder is provably alive. */
  holderAlive: boolean
}

/**
 * Read the lock without claiming it.
 * @param root - the supervisor data root.
 * @returns the payload and liveness, or a null lock when none is recorded.
 */
export const probeLifecycleLock = async (root: string): Promise<LifecycleLockProbe> => {
  let raw: string
  try {
    raw = await readFile(lifecycleLockPath(root), 'utf8')
  } catch {
    return { lock: null, holderAlive: false }
  }
  const lock = parseLock(raw)
  if (lock === null) return { lock: null, holderAlive: false }
  return { lock, holderAlive: lock.pid > 0 && isPidAlive(lock.pid) }
}

/** A held lifecycle transaction; `release` always settles. */
export interface LifecycleTransaction {
  /** The recorded payload. */
  payload: LifecycleLockPayload
  /** Remove the claim; safe to call once. */
  release: () => Promise<void>
}

/** The lock could not be acquired before its budget ran out. */
export class LifecycleLockBusy extends Error {
  constructor(readonly holder: LifecycleLockPayload) {
    super(`a '${holder.verb}' lifecycle transaction (pid ${String(holder.pid)}) holds the root`)
  }
}

/**
 * Claim the root's lifecycle lock for one transaction, waiting out a live
 * holder up to the budget and reclaiming a dead holder's claim.
 * @param root - the supervisor data root.
 * @param verb - the transaction's verb, for diagnostics and status.
 * @param options - budget and release protection; `pollMs` paces the wait.
 * @returns the held transaction.
 */
export const acquireLifecycleLock = async (
  root: string,
  verb: string,
  options: { timeoutMs?: number; pollMs?: number; protectedReleases?: readonly string[]; now?: () => number } = {},
): Promise<LifecycleTransaction> => {
  const timeoutMs = options.timeoutMs ?? 120_000
  const pollMs = options.pollMs ?? 100
  const now = options.now ?? Date.now
  const path = lifecycleLockPath(root)
  await mkdir(join(root, 'locks'), { recursive: true, mode: 0o700 })
  const payload: LifecycleLockPayload = {
    kind: 'gh-remote-lifecycle-lock',
    pid: process.pid,
    processIdentity: await readProcessIdentity(process.pid),
    nonce: randomUUID(),
    verb,
    startedAt: now(),
    protectedReleases: [...options.protectedReleases ?? []],
  }
  const deadline = now() + timeoutMs
  // The claim is create-exclusive over a staging file, then hard-linked into
  // place: `link` fails with EEXIST when a claim already landed, so a racing
  // waiter can never overwrite the winner, and a crash between the two leaves
  // only the staging file, which the next attempt removes.
  const staging = `${path}.acquire-${randomUUID()}`
  for (;;) {
    try {
      await writeFile(staging, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      try {
        await link(staging, path)
      } finally {
        await unlink(staging).catch(() => undefined)
      }
      return {
        payload,
        release: () => rm(path, { force: true }).catch(() => undefined),
      }
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const probed = await probeLifecycleLock(root)
    if (probed.lock !== null && !probed.holderAlive) {
      // A dead holder's claim is an interrupted transaction: take it over.
      await rm(path, { force: true }).catch(() => undefined)
      continue
    }
    if (probed.lock !== null && probed.lock.pid === process.pid) {
      throw new Error('this process already holds the lifecycle lock')
    }
    if (now() >= deadline) {
      throw new LifecycleLockBusy(probed.lock ?? {
        kind: 'gh-remote-lifecycle-lock', pid: -1, processIdentity: null, nonce: '', verb: 'unknown',
        startedAt: 0, protectedReleases: [],
      })
    }
    await new Promise((resolve) => { setTimeout(resolve, pollMs) })
  }
}

/**
 * Every release a live lifecycle transaction protects, for gc passes.
 * @param root - the supervisor data root.
 * @returns release id → the protecting verb.
 */
export const lifecycleProtectedReleases = async (root: string): Promise<Map<string, string>> => {
  const probed = await probeLifecycleLock(root)
  if (probed.lock === null || !probed.holderAlive) return new Map()
  return new Map(probed.lock.protectedReleases.map(id => [id, probed.lock?.verb ?? 'unknown'] as const))
}
