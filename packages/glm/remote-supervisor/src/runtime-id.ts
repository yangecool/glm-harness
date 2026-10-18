/**
 * The data root's persistent runtime identity: a UUID minted once on first
 * boot and never regenerated, so clients and supervisors can pin the runtime
 * across service restarts, supervisor crashes, and release switches. Plain
 * Node, no framework imports.
 * @module @glm-harness/gh-remote-supervisor/runtime-id
 */

import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The identity file's address inside a data root.
 * @param root - the supervisor data root.
 * @returns the runtime id file's absolute path.
 */
export const runtimeIdPath = (root: string): string => join(root, 'runtime-id')

/** Runtime ids use the UUID representation written on first installation. */
const isRuntimeId = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)

/**
 * Read the root's persistent runtime identity, minting it on first boot.
 * A first mint is create-exclusive, so a racing writer's id wins for both;
 * a corrupted or unreadable file rejects without changing the recorded identity.
 * @param root - the supervisor data root.
 * @returns the runtime id.
 */
export const ensureRuntimeId = async (root: string): Promise<string> => {
  const path = runtimeIdPath(root)
  const read = async (): Promise<string | null> => {
    let raw: string
    try { raw = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const value = raw.trim()
    if (!isRuntimeId(value)) throw new Error(`runtime id file at ${path} is invalid; restore the recorded identity before continuing`)
    return value
  }
  const existing = await read()
  if (existing !== null) return existing
  await mkdir(root, { recursive: true })
  const staging = `${path}.create-${randomUUID()}`
  await writeFile(staging, `${randomUUID()}\n`, { flag: 'wx', mode: 0o600 })
  try {
    try { await link(staging, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    await unlink(staging)
  }
  const settled = await read()
  if (settled === null) throw new Error(`runtime id file at ${path} disappeared before publication`)
  return settled
}
