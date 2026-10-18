/** Version changes refuse busy, unavailable, or malformed activity instead of killing owned work. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { isPidAlive, readProcessIdentity, supervisorCli, supervisorPaths } from '../src/index.ts'
import { installRelease, readCurrent, useRelease } from '../src/releases.ts'

it.each(['busy', 'missing-count', 'unavailable'])('leaves the live service and current release intact when drain is %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'gh-drain-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'])
  const exited = once(child, 'exit')
  onTestFinished(async () => { child.kill('SIGKILL'); await exited })
  await once(child, 'spawn')
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(303, { 'set-cookie': 'fixture=ok; HttpOnly', location: '/' })
      response.end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(mode === 'unavailable' ? { result: { ok: false } }
      : { result: { ok: true, value: mode === 'busy' ? { runningAgents: 0, ownedActivity: 1 } : { runningAgents: 0 } } }))
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => {
      if (error) reject(error)
      else resolve()
    }) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback listener')
  const source = join(root, 'source')
  await mkdir(join(source, 'lib'), { recursive: true })
  await writeFile(join(source, 'lib', 'bin.js'), 'process.exit(0)\n')
  await installRelease(root, source, { id: 'r-before' })
  await useRelease(root, 'r-before')
  await mkdir(join(root, 'run'), { recursive: true })
  const paths = supervisorPaths(root)
  const identity = JSON.stringify({
    kind: 'gh-remote-supervisor-identity', pid: child.pid, nonce: 'drain-fixture',
    processIdentity: await readProcessIdentity(child.pid ?? -1), readyUrl: `http://127.0.0.1:${address.port}/`,
  })
  await writeFile(paths.identityFile, identity)
  expect(await supervisorCli(['--root', root, 'update', '--from', source, '--id', 'r-after', '--drain-timeout', '200'])).toBe(69)
  expect((await readCurrent(root))?.releaseId).toBe('r-before')
  expect(await readFile(paths.identityFile, 'utf8')).toBe(identity)
  expect(isPidAlive(child.pid ?? -1)).toBe(true)
})
