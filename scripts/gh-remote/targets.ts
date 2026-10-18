/** Saved SSH target records for GH remote deployment; credentials stay key files, never secrets here. */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

/** One saved deployment target: connection coordinates plus optional OpenSSH delegation. */
export const remoteTargetSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1).optional(),
  /** Path to a private key the controller passes to ssh -i; never key material itself. */
  identity: z.string().min(1).optional(),
  /** Delegate connection details to an OpenSSH config alias instead of host/port/user. */
  sshConfigAlias: z.string().min(1).optional(),
  /** Extra literal ssh options, e.g. ProxyJump targets (R03). */
  proxyJump: z.string().min(1).optional(),
}).strict()

/** A saved target as stored on disk. */
export type RemoteTarget = z.infer<typeof remoteTargetSchema>

/** Parsed records file. */
export type RemoteTargetStore = { targets: RemoteTarget[] }

const storeSchema = z.object({ targets: z.array(remoteTargetSchema) }).strict()

/** Default store location follows the GH home convention. */
export function defaultTargetStore(): string {
  return process.env.GH_REMOTE_TARGETS ?? join(homedir(), '.glmh', 'remote-targets.json')
}

/**
 * Load every saved target record.
 * @param path - store file path.
 * @returns parsed records; an absent file is an empty store.
 */
export async function loadTargets(path = defaultTargetStore()): Promise<RemoteTargetStore> {
  if (!existsSync(path)) return { targets: [] }
  return storeSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

/**
 * Persist target records atomically.
 * @param store - complete record set.
 * @param path - store file path.
 */
export async function saveTargets(store: RemoteTargetStore, path = defaultTargetStore()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`)
  await rename(temporary, path)
}

/**
 * Insert or replace one record by name.
 * @param target - validated record.
 * @param path - store file path.
 * @returns the store after the write.
 */
export async function upsertTarget(target: RemoteTarget, path = defaultTargetStore()): Promise<RemoteTargetStore> {
  const store = await loadTargets(path)
  const remaining = store.targets.filter(entry => entry.name !== target.name)
  remaining.push(target)
  remaining.sort((a, b) => a.name.localeCompare(b.name))
  const next = { targets: remaining }
  await saveTargets(next, path)
  return next
}

/**
 * Remove one record by name.
 * @param name - record name.
 * @param path - store file path.
 * @returns whether a record was removed.
 */
export async function removeTarget(name: string, path = defaultTargetStore()): Promise<boolean> {
  const store = await loadTargets(path)
  const remaining = store.targets.filter(entry => entry.name !== name)
  if (remaining.length === store.targets.length) return false
  await saveTargets({ targets: remaining }, path)
  return true
}

/**
 * Resolve a target by saved name, or parse an explicit user@host:port spec.
 * @param reference - saved name or `user@host`, `host:port`, `user@host:port`.
 * @param path - store file path.
 * @returns the resolved target.
 */
export async function resolveTarget(reference: string, path = defaultTargetStore()): Promise<RemoteTarget> {
  const store = await loadTargets(path)
  const saved = store.targets.find(entry => entry.name === reference)
  if (saved !== undefined) return saved
  if (/^[a-z0-9][a-z0-9-]*$/.test(reference)) throw new Error(`gh-remote: no saved target named ${reference}`)
  let rest = reference
  let user: string | undefined
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  let port = 22
  const colon = rest.lastIndexOf(':')
  if (colon >= 0) {
    const parsed = Number.parseInt(rest.slice(colon + 1), 10)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`gh-remote: invalid port in ${reference}`)
    port = parsed
    rest = rest.slice(0, colon)
  }
  if (rest.length === 0) throw new Error(`gh-remote: invalid target ${reference}`)
  const name = `ad-hoc-${`${rest}-${port}`.replaceAll(/[^a-z0-9-]/g, '-')}`
  return remoteTargetSchema.parse({ name, host: rest, port, ...(user === undefined ? {} : { user }) })
}
