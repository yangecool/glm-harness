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

it.each(['busy', 'missing-count', 'unavailable', 'auth-refused', 'transport-failed', 'late-idle', 'legacy'])('leaves the live service and current release intact when drain is %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'gh-drain-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'])
  const exited = once(child, 'exit')
  onTestFinished(async () => { child.kill('SIGKILL'); await exited })
  await once(child, 'spawn')
  let admission = 'open'
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server = createServer((request, response) => {
    if (request.url === '/') {
      if (mode === 'transport-failed') { request.socket.destroy(); return }
      if (mode === 'auth-refused') { response.writeHead(403); response.end(); return }
      response.writeHead(303, { 'set-cookie': 'fixture=ok; HttpOnly', location: '/' })
      response.end()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/ghRemote/describe') {
      response.end(JSON.stringify({ result: { ok: true, value: { admission, capabilities: mode === 'legacy' ? [] : ['admission-close'] } } }))
      return
    }
    if (request.url === '/api/ghRemote/admission') {
      let raw = ''
      request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      request.on('end', () => {
        const body = JSON.parse(raw) as { payload: { args: { request: { action: string } } } }
        admission = body.payload.args.request.action === 'close' ? 'closed' : 'open'
        response.end(JSON.stringify({ result: { ok: true, value: { admission } } }))
      })
      return
    }
    if (mode === 'late-idle') {
      const timer = setTimeout(() => {
        timers.delete(timer)
        response.end(JSON.stringify({ result: { ok: true, value: { runningAgents: 0, ownedActivity: 0 } } }))
      }, 1000)
      timers.add(timer)
      return
    }
    response.end(JSON.stringify(mode === 'unavailable' ? { result: { ok: false } }
      : { result: { ok: true, value: mode === 'busy' ? { runningAgents: 0, ownedActivity: 1 } : mode === 'legacy' ? { runningAgents: 0, ownedActivity: 0 } : { runningAgents: 0 } } }))
  })
  onTestFinished(async () => {
    for (const timer of timers) clearTimeout(timer)
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
  expect(admission).toBe('open')
})
