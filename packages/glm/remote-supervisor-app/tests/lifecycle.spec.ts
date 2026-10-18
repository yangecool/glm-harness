/** Supervisor plugin disposal owns boot settlement, child exit, and lock release. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { isPidAlive, readIdentity, supervisorPaths } from '@glm-harness/gh-remote-supervisor'
import { expect, it, onTestFinished } from 'vitest'
import { GhSupervisorAppService } from '../src/index.ts'

it('does not settle disposal until its resident child has exited and its lock is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gh-supervisor-plugin-'))
  const ctx = new Context()
  let childPid: number | undefined
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (childPid !== undefined && isPidAlive(childPid)) process.kill(childPid, 'SIGKILL')
    await rm(root, { recursive: true, force: true })
  })
  const release = join(root, 'releases', 'test')
  await mkdir(join(release, 'lib'), { recursive: true })
  const stopped = join(root, 'child-stopped')
  await writeFile(join(release, 'lib', 'bin.js'), `
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {
  setTimeout(() => { writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); }, 100);
});
process.stdout.write('gh-remote ready: http://127.0.0.1:1/token#test\\n');
setInterval(() => {}, 60000);
`)
  await writeFile(join(root, 'releases', 'current.json'), JSON.stringify({
    kind: 'gh-remote-current-release', releaseId: 'test', switchedAt: 1, previousReleaseId: null,
  }))
  const service = new GhSupervisorAppService(ctx, {
    root, home: '', childProfile: 'gh-remote', host: '127.0.0.1', port: '0',
    readyTimeoutMs: 5000, baseBackoffMs: 10, maxBackoffMs: 100,
    drainTimeoutMs: 2000, crashThreshold: 2, crashWindowMs: 10000,
  })
  await service.booted
  await expect.poll(async () => {
    const identity = await readIdentity(supervisorPaths(root))
    if (identity !== null && identity.readyAt !== null) childPid = identity.pid
    return childPid !== undefined
  }, { timeout: 5000 }).toBe(true)
  await ctx.fiber.dispose()
  expect(await readFile(stopped, 'utf8')).toBe('stopped')
  expect(isPidAlive(childPid ?? -1)).toBe(false)
  expect(await readIdentity(supervisorPaths(root))).toBeNull()
})
