/**
 * GH-006-E release lifecycle under a supervisor data root: immutable versioned
 * runtime directories, a rename-atomic current pointer, staged installs whose
 * leftovers diagnose interrupted transactions, garbage collection that keeps
 * every release a live service still pins, and an uninstall that separates
 * removing the runtimes from deleting the root's data. Pure Node, no
 * framework imports, mirroring the supervision module it extends.
 * @module @glm-harness/gh-remote-supervisor/releases
 */

import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
// Dirent names the readdir results below; copyFile/symlink carry install trees.
import { join } from 'node:path'

/** Pointer file naming the release a `run` without an explicit command uses. */
export interface CurrentReleaseFile {
  /** Schema discriminator. */
  kind: 'gh-remote-current-release'
  /** The release directory name under `releases/`. */
  releaseId: string
  /** Epoch milliseconds the pointer switched. */
  switchedAt: number
  /** The release this one replaced — `rollback`'s target. */
  previousReleaseId: string | null
}

/** Manifest sealing one installed release directory. */
export interface ReleaseManifest {
  /** Schema discriminator. */
  kind: 'gh-remote-release'
  /** The release directory name under `releases/`. */
  id: string
  /** Epoch milliseconds the install completed. */
  installedAt: number
  /** Free-form provenance recorded at install. */
  note?: string
}

/** Staging directory prefix; any leftover is an interrupted install. */
export const STAGING_PREFIX = '.staging-'

/** Manifest file name inside a release directory. */
export const RELEASE_MANIFEST = 'gh-release.json'

/**
 * Read a root's current-release pointer.
 * @param root - the supervisor data root.
 * @returns the parsed pointer, or null when absent or malformed (diagnose via `releasesReport`).
 */
export const readCurrent = async (root: string): Promise<CurrentReleaseFile | null> => {
  let raw: string
  try {
    raw = await readFile(join(root, 'releases', 'current.json'), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<CurrentReleaseFile>
    if (candidate.kind !== 'gh-remote-current-release' || typeof candidate.releaseId !== 'string') return null
    return parsed as CurrentReleaseFile
  } catch {
    return null
  }
}

/** Installed release ids, lexically sorted; staging leftovers excluded. */
export const listReleases = async (root: string): Promise<string[]> => {
  let entries: Dirent[]
  try {
    entries = await readdir(join(root, 'releases'), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith(STAGING_PREFIX))
    .map(entry => entry.name)
    .sort()
}

/** Leftover staging directory names: interrupted installs, safe to diagnose and remove. */
export const listStaging = async (root: string): Promise<string[]> => {
  let entries: Dirent[]
  try {
    entries = await readdir(join(root, 'releases'), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter(entry => entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))
    .map(entry => entry.name)
    .sort()
}

/**
 * Copy a directory tree recursively, preserving symlinks as symlinks.
 * @param from - source directory.
 * @param to - destination directory (created).
 */
export const copyTree = async (from: string, to: string): Promise<void> => {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(source), target)
      continue
    }
    if (entry.isDirectory()) {
      await copyTree(source, target)
      continue
    }
    if (entry.isFile()) {
      await copyFile(source, target)
    }
  }
}

/** Outcome of one install attempt. */
export type InstallResult =
  | { readonly ok: true; readonly releaseId: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Install one release: copy the source runtime into a staging directory,
 * seal it with a manifest, then rename it into place. The rename is the
 * commit point, so an installed release is complete and immutable — a second
 * install under the same id is refused, and any interrupted attempt leaves
 * only a staging leftover the report surfaces.
 * @param root - the supervisor data root.
 * @param from - the extracted runtime directory to install.
 * @param options - explicit id or install note; id defaults to a unique generated one.
 * @returns the installed release id, or the refusal reason.
 */
export const installRelease = async (
  root: string,
  from: string,
  options: { id?: string; note?: string; now?: () => number } = {},
): Promise<InstallResult> => {
  try {
    await lstat(join(from, 'lib', 'bin.js'))
  } catch {
    return { ok: false, reason: `install source has no lib/bin.js runtime entry: ${from}` }
  }
  const releaseId = options.id ?? `r-${(options.now ?? Date.now)()}-${randomUUID().slice(0, 8)}`
  const releasesDir = join(root, 'releases')
  const staging = join(releasesDir, `${STAGING_PREFIX}${releaseId}`)
  const final = join(releasesDir, releaseId)
  try {
    await lstat(final)
    return { ok: false, reason: `release ${releaseId} is already installed; releases are immutable` }
  } catch { /* absent: proceed */ }
  await rm(staging, { recursive: true, force: true })
  await mkdir(releasesDir, { recursive: true })
  await copyTree(from, staging)
  const manifest: ReleaseManifest = {
    kind: 'gh-remote-release',
    id: releaseId,
    installedAt: (options.now ?? Date.now)(),
    ...(options.note === undefined ? {} : { note: options.note }),
  }
  await writeFile(join(staging, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  try {
    await rename(staging, final)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    return { ok: false, reason: `release rename failed: ${(error as Error).message}` }
  }
  return { ok: true, releaseId }
}

/**
 * Switch the current-release pointer to an installed release.
 * @param root - the supervisor data root.
 * @param releaseId - an installed release directory name.
 * @param now - clock for the switchedAt stamp.
 * @returns the previous release id (rollback's future target), or the refusal reason.
 */
export const useRelease = async (
  root: string,
  releaseId: string,
  now: () => number = Date.now,
): Promise<{ ok: true; previousReleaseId: string | null } | { ok: false; reason: string }> => {
  try {
    await lstat(join(root, 'releases', releaseId, RELEASE_MANIFEST))
  } catch {
    return { ok: false, reason: `release ${releaseId} is not installed` }
  }
  const previous = await readCurrent(root)
  const payload: CurrentReleaseFile = {
    kind: 'gh-remote-current-release',
    releaseId,
    switchedAt: now(),
    previousReleaseId: previous === null ? null : previous.releaseId,
  }
  const target = join(root, 'releases', 'current.json')
  const staging = `${target}.tmp-${randomUUID()}`
  await mkdir(join(root, 'releases'), { recursive: true })
  await writeFile(staging, `${JSON.stringify(payload, null, 2)}\n`)
  await rename(staging, target)
  return { ok: true, previousReleaseId: payload.previousReleaseId }
}

/**
 * Resolve the launcher for a release directory: its bundled `bin/node` when
 * present, otherwise this process's interpreter.
 * @param releaseDir - the installed release directory.
 * @returns the executable path a service spawn uses.
 */
export const launcherFor = async (releaseDir: string): Promise<string> => {
  try {
    await lstat(join(releaseDir, 'bin', 'node'))
    return join(releaseDir, 'bin', 'node')
  } catch {
    return process.execPath
  }
}

/**
 * The conventional service command inside one release: the release's launcher
 * running `lib/bin.js` under the `gh-remote` resident profile.
 * @param releaseDir - the installed release directory.
 * @returns the command a `run` from the current release spawns.
 */
export const serviceCommandFor = async (releaseDir: string): Promise<{ command: string; args: string[] }> => {
  const launcher = await launcherFor(releaseDir)
  return {
    command: launcher,
    args: [join(releaseDir, 'lib', 'bin.js'), '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'],
  }
}

/** Result of one garbage-collection pass. */
export interface GcResult {
  /** Releases removed. */
  readonly removedReleases: readonly string[]
  /** Interrupted-install staging leftovers removed. */
  readonly removedStaging: readonly string[]
  /** Releases kept and why. */
  readonly kept: Readonly<Record<string, string>>
}

/**
 * Remove staging leftovers and every release nothing pins. A release is kept
 * when it is the current pointer, the current pointer's rollback target, or
 * anything the caller protects — the live service's identity names the
 * release it runs, so a task still executing on an old version holds it.
 * @param root - the supervisor data root.
 * @param protect - release ids that must survive beyond current and previous.
 * @returns what the pass removed and kept.
 */
export const gcReleases = async (root: string, protect: ReadonlyMap<string, string> = new Map()): Promise<GcResult> => {
  const current = await readCurrent(root)
  const kept: Record<string, string> = {}
  if (current !== null) {
    kept[current.releaseId] = 'current'
    if (current.previousReleaseId !== null) kept[current.previousReleaseId] = 'rollback target'
  }
  for (const [id, reason] of protect) kept[id] = reason
  const removedReleases: string[] = []
  for (const id of await listReleases(root)) {
    if (kept[id] !== undefined) continue
    await rm(join(root, 'releases', id), { recursive: true, force: true })
    removedReleases.push(id)
  }
  const removedStaging: string[] = []
  for (const id of await listStaging(root)) {
    await rm(join(root, 'releases', id), { recursive: true, force: true })
    removedStaging.push(id)
  }
  return { removedReleases, removedStaging, kept }
}

/**
 * Remove the root's runtimes and service state while keeping every other byte
 * of the data root (sessions, credentials, caches). `purge` deletes the whole
 * root instead: the caller separates keeping data from destroying the target.
 * @param root - the supervisor data root.
 * @param purge - whether to delete the entire root.
 */
export const uninstallRoot = async (root: string, purge: boolean): Promise<void> => {
  if (purge) {
    await rm(root, { recursive: true, force: true })
    return
  }
  await rm(join(root, 'releases'), { recursive: true, force: true })
  await rm(join(root, 'run'), { recursive: true, force: true })
}
