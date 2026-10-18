/**
 * The data root's persistent runtime identity: a UUID minted once on first
 * boot and never regenerated, so clients and supervisors can pin the runtime
 * across service restarts, supervisor crashes, and release switches. Plain
 * Node, no framework imports.
 * @module @glm-harness/gh-remote-supervisor/runtime-id
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The identity file's address inside a data root.
 * @param root - the supervisor data root.
 * @returns the runtime id file's absolute path.
 */
export const runtimeIdPath = (root: string): string => join(root, 'runtime-id')

/** A plausible runtime id: uuid-shaped, so a corrupted file re-mints. */
const isRuntimeId = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)

/**
 * Read the root's persistent runtime identity, minting it on first boot.
 * A first mint is create-exclusive, so a racing writer's id wins for both;
 * a corrupted file is replaced, because garbage must not pose as identity.
 * @param root - the supervisor data root.
 * @returns the runtime id.
 */
export const ensureRuntimeId = async (root: string): Promise<string> => {
  const path = runtimeIdPath(root)
  const existing = await readFile(path, 'utf8').then(raw => raw.trim()).catch(() => null)
  if (existing !== null && isRuntimeId(existing)) return existing
  const minted = randomUUID()
  // Replacing a corrupted file is safe: whatever lands is a valid identity,
  // and the re-read converges both this caller and any racing writer.
  await writeFile(path, `${minted}\n`, { mode: 0o600 }).catch(() => undefined)
  const settled = await readFile(path, 'utf8').then(raw => raw.trim()).catch(() => minted)
  if (isRuntimeId(settled)) return settled
  throw new Error(`runtime id file at ${path} is unreadable`)
}
