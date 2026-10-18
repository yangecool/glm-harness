/** Versioned archive metadata and file integrity checks for GH remote runtime releases. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { z } from 'zod'

/** Install targets the GH remote bootstrap accepts; mac/win remote hosts arrive with E04.6. */
export const GH_REMOTE_TARGETS = ['linux-x64', 'linux-arm64'] as const
/** One qualified OS and architecture pair for a relocatable GH runtime archive. */
export type GhRemoteTarget = typeof GH_REMOTE_TARGETS[number]

const payloadPath = z.string().min(1).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'invalid payload path')

/** Parser for the metadata embedded beside a runtime payload; files excludes manifest.json itself. */
export const artifactManifestSchema = z.object({
  format: z.literal(1),
  product: z.literal('gh-remote-runtime'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  dirty: z.boolean(),
  target: z.enum(GH_REMOTE_TARGETS),
  nodeVersion: z.string().regex(/^v\d+\./),
  entry: z.literal('bootstrap.sh'),
  files: z.array(z.object({
    path: payloadPath, sha256: z.string().regex(/^[a-f0-9]{64}$/), mode: z.number().int().min(0).max(0o777),
  }).strict()).min(1),
}).strict()

/** Parsed release metadata for an unpacked GH remote runtime. */
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>

/**
 * Enumerate an owned payload without following links outside its directory.
 * @param root - unpacked payload directory.
 * @returns sorted POSIX relative file paths, excluding manifest.json.
 */
export async function payloadFiles(root: string): Promise<string[]> {
  const paths: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`GH remote payload contains a symbolic link: ${path}`)
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) paths.push(relative(root, path).split(sep).join('/'))
      else throw new Error(`GH remote payload contains a non-regular file: ${path}`)
    }
  }
  await visit(root)
  return paths.filter(path => path !== 'manifest.json').sort()
}

/**
 * Hash the exact file bytes used for installation or publication.
 * @param path - regular file path.
 * @returns lowercase SHA-256.
 */
export async function fileDigest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Verify all payload bytes and permissions before an unpacked release is activated.
 * @param directory - unpacked payload root.
 * @returns the validated metadata; missing, duplicate, extra, or altered files reject.
 */
export async function verifyPayload(directory: string): Promise<ArtifactManifest> {
  const manifest = artifactManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
  const declared = manifest.files.map(file => file.path).sort()
  if (new Set(declared).size !== declared.length) {
    throw new Error('GH remote payload file inventory differs from manifest.json')
  }
  for (const required of ['bootstrap.sh', 'bin/node', 'runtime/lib/bin.js', 'home-template/profiles/gh-headless/package.json']) {
    if (!declared.includes(required)) throw new Error(`GH remote payload omits required runtime files: ${required}`)
  }
  const actual = await payloadFiles(directory)
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error('GH remote payload file inventory differs from manifest.json')
  }
  for (const file of manifest.files) {
    const path = join(directory, file.path)
    if (await fileDigest(path) !== file.sha256) throw new Error(`GH remote payload digest differs: ${file.path}`)
    if (((await lstat(path)).mode & 0o777) !== file.mode) throw new Error(`GH remote payload permissions differ: ${file.path}`)
  }
  return manifest
}

/**
 * Read the release identity of an unpacked or activated payload without digest work.
 * @param directory - payload root containing manifest.json.
 * @returns the parsed metadata.
 */
export async function readManifest(directory: string): Promise<ArtifactManifest> {
  return artifactManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
}
