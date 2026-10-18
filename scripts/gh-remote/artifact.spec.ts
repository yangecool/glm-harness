import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { create as createTar } from 'tar'
import { artifactManifestSchema, fileDigest, payloadFiles, verifyPayload } from './artifact.ts'
import { renderBootstrapScript } from './bootstrap.ts'

const run = promisify(execFile)

interface MiniPayload {
  root: string
  payload: string
  archive: string
  manifestPath: string
}

/** Build a complete miniature gh-remote payload and archive with a valid manifest. */
async function miniPayload(options: { commit?: string; nodeBody?: string } = {}): Promise<MiniPayload> {
  const root = await mkdtemp(join(tmpdir(), 'gh-remote-archive-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const payload = join(root, 'gh-remote')
  await mkdir(join(payload, 'bin'), { recursive: true })
  await mkdir(join(payload, 'runtime', 'lib'), { recursive: true })
  await mkdir(join(payload, 'home-template', 'profiles', 'gh-headless'), { recursive: true })
  await writeFile(join(payload, 'bootstrap.sh'), renderBootstrapScript())
  await chmod(join(payload, 'bootstrap.sh'), 0o755)
  await writeFile(join(payload, 'bin', 'node'), options.nodeBody ?? '#!/bin/sh\nexit 0\n')
  await chmod(join(payload, 'bin', 'node'), 0o755)
  await writeFile(join(payload, 'runtime', 'lib', 'bin.js'), '// stub cli entry\n')
  await writeFile(join(payload, 'home-template', 'profiles', 'gh-headless', 'package.json'), '{}\n')
  const metadata = artifactManifestSchema.parse({
    format: 1, product: 'gh-remote-runtime', version: '0.2.1-rc.1',
    commit: options.commit ?? 'a'.repeat(40), dirty: false, target: 'linux-x64',
    nodeVersion: process.version, entry: 'bootstrap.sh',
    files: await Promise.all((await payloadFiles(payload)).map(async path => ({
      path, sha256: await fileDigest(join(payload, path)), mode: (await lstat(join(payload, path))).mode & 0o777,
    }))),
  })
  const manifestPath = join(payload, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`)
  const archive = join(root, 'gh-remote-test.tar.gz')
  await createTar({ cwd: root, file: archive, gzip: true, portable: true }, ['gh-remote'])
  await writeFile(`${archive}.sha256`, `${await fileDigest(archive)}  gh-remote-test.tar.gz\n`)
  return { root, payload, archive, manifestPath }
}

it('validates the exact unpacked inventory and rejects altered bytes', async () => {
  const test = await miniPayload()
  const verified = await verifyPayload(test.payload)
  expect(verified.target).toBe('linux-x64')
  await writeFile(join(test.payload, 'runtime', 'lib', 'bin.js'), '// tampered\n')
  await expect(verifyPayload(test.payload)).rejects.toThrow('digest differs')
})

it('rejects missing, undeclared, and duplicate payload files', async () => {
  const test = await miniPayload()
  await writeFile(join(test.payload, 'undeclared.txt'), '')
  await expect(verifyPayload(test.payload)).rejects.toThrow('inventory')
  await rm(join(test.payload, 'undeclared.txt'))
  const parsed = JSON.parse(await readFile(test.manifestPath, 'utf8')) as { files: unknown[] }
  parsed.files.push(parsed.files[0])
  await writeFile(test.manifestPath, JSON.stringify(parsed))
  await expect(verifyPayload(test.payload)).rejects.toThrow('inventory')
})

it('requires the runtime essentials in every manifest', async () => {
  const test = await miniPayload()
  await rm(join(test.payload, 'bin', 'node'))
  const parsed = JSON.parse(await readFile(test.manifestPath, 'utf8')) as { files: Array<{ path: string }> }
  parsed.files = parsed.files.filter(file => file.path !== 'bin/node')
  await writeFile(test.manifestPath, JSON.stringify(parsed))
  await expect(verifyPayload(test.payload)).rejects.toThrow('omits required runtime files')
})

it('rejects manifests naming paths outside the payload', () => {
  expect(() => artifactManifestSchema.parse({
    format: 1, product: 'gh-remote-runtime', version: '1.0.0', commit: 'b'.repeat(40),
    dirty: false, target: 'linux-arm64', nodeVersion: 'v22.1.0', entry: 'bootstrap.sh',
    files: [{ path: '../escape', sha256: 'c'.repeat(64), mode: 0o644 }],
  })).toThrow('invalid payload path')
})

it('renders a bootstrap that POSIX sh accepts syntactically', async () => {
  const script = renderBootstrapScript()
  await run('sh', ['-n', '-c', script])
})
