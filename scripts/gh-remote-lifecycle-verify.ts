/**
 * GH-006-E acceptance for release lifecycle over the REAL supervisor CLI:
 * installs are immutable, `update` drains the live service's activity before
 * switching the current pointer (a real gh-remote running a real turn on the
 * streaming loopback GLM fixture), the switched service runs from the new
 * release and `rollback` returns to the previous one, garbage collection
 * keeps the current, rollback-target, and live-pinned releases, interrupted
 * installs stay diagnosable through `status`, and uninstall separates
 * removing the runtimes from deleting the data root. Usage:
 *   node --import tsx/esm scripts/gh-remote-lifecycle-verify.ts [--report out.json]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { existsSync } from 'node:fs'
import { initGhProfiles } from './gh-init-profiles.ts'

interface CaseResult { name: string; passed: boolean; detail: string }

/** A tiny ready-line runtime: the fake child the supervisor contract needs. */
const FAKE_RUNTIME = (marker: string): string => [
  `console.log('gh-remote ready: http://127.0.0.1:1/token#${marker}')`,
  'process.on(\'SIGTERM\', () => { process.exit(0) })',
  'setInterval(() => {}, 1 << 30)',
  '',
].join('\n')

/** Streaming loopback GLM: one slow text turn per request, with abort tracking. */
function streamingFixture(): { server: ReturnType<typeof createServer>; portPromise: Promise<number>; aborted: boolean[] } {
  const aborted: boolean[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    let bodyReady!: () => void
    const bodyArrived = new Promise<void>((resolveBody) => { bodyReady = resolveBody })
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { bodyReady() })
    const serve = async (): Promise<void> => {
      await bodyArrived
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let index = 0; index < 16; index += 1) {
        await new Promise(resolveTick => setTimeout(resolveTick, 200))
        // Only the writable side proves the caller went away: an incoming
        // request reads as destroyed once its body fully ends.
        if (response.destroyed) return
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `tick-${index} ` } }] })}\n\n`)
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    }
    const entry = aborted.length
    aborted.push(false)
    request.on('aborted', () => { aborted[entry] = true })
    response.on('close', () => { if (!response.writableEnded) aborted[entry] = true })
    void serve().catch(() => { response.destroy() })
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  return { server, portPromise, aborted }
}

interface Identity { pid: number; readyUrl: string | null; releaseId: string | null }

async function awaitReleaseIdentity(
  identityPath: string,
  predicate: (identity: Identity) => boolean,
  timeoutMs: number,
): Promise<Identity> {
  for (let attempt = 0; attempt < Math.ceil(timeoutMs / 300); attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(identityPath, 'utf8')) as { pid?: unknown; readyUrl?: unknown; releaseId?: unknown }
      const identity: Identity = {
        pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
        readyUrl: typeof parsed.readyUrl === 'string' ? parsed.readyUrl : null,
        releaseId: typeof parsed.releaseId === 'string' ? parsed.releaseId : null,
      }
      if (identity.pid > 0 && predicate(identity)) return identity
    } catch { /* not yet */ }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 300))
  }
  throw new Error(`identity predicate timed out after ${String(timeoutMs)}ms: ${identityPath}`)
}

/** Run one supervisor CLI verb to completion, capturing its output. */
async function runCli(supervisorCli: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string; err: string }> {
  const child = spawn(process.execPath, [supervisorCli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk })
  const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
  const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  clearTimeout(timer)
  return { code: code ?? -1, out, err }
}

/** A long-running CLI verb (it becomes the resident supervisor); its stderr stays readable while it runs. */
interface Resident {
  child: ReturnType<typeof spawn>
  readonly err: { text: string }
}

const spawnCli = (supervisorCli: string, args: string[]): Resident => {
  const child = spawn(process.execPath, [supervisorCli, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  const err = { text: '' }
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err.text += chunk })
  return { child, err }
}

/** Kill every resident verb still alive; each `stop` already asked them to drain. */
const killResidents = (residents: readonly Resident[]): void => {
  for (const resident of residents) {
    if (resident.child.exitCode === null && resident.child.signalCode === null) resident.child.kill('SIGKILL')
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { report: { type: 'string' } } })
  const root = resolve(import.meta.dirname, '..')
  const supervisorCli = join(root, 'packages', 'glm', 'remote-supervisor', 'lib', 'index.js')
  const cases: CaseResult[] = []
  const note = (name: string, passed: boolean, detail: string): void => {
    cases.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }

  // --- Fake-runtime root: version mechanics. ---
  const fakeRoot = await mkdtemp(join(tmpdir(), 'gh-lifecycle-fake-'))
  const makeRuntime = async (marker: string): Promise<string> => {
    const dir = join(fakeRoot, `src-${marker}`)
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'lib', 'bin.js'), FAKE_RUNTIME(marker))
    return dir
  }
  const residents: Resident[] = []
  try {
    const alpha = await makeRuntime('alpha')
    const beta = await makeRuntime('beta')
    const extra = await makeRuntime('extra')
    const identityPath = join(fakeRoot, 'run', 'service.json')

    const installed = await runCli(supervisorCli, ['--root', fakeRoot, 'install', '--from', alpha, '--id', 'r-alpha'])
    note('install-sealed', installed.code === 0 && installed.out.trim() === 'r-alpha', `stdout=${installed.out.trim()}`)
    const again = await runCli(supervisorCli, ['--root', fakeRoot, 'install', '--from', alpha, '--id', 'r-alpha'])
    note('install-immutable', again.code === 69 && again.err.includes('immutable'), `exit=${String(again.code)} ${again.err.trim()}`)

    // Run from the current release; the identity must carry the release id.
    await runCli(supervisorCli, ['--root', fakeRoot, 'use', 'r-alpha'])
    residents.push(spawnCli(supervisorCli, ['--root', fakeRoot, 'run']))
    const first = await awaitReleaseIdentity(identityPath, identity => identity.releaseId === 'r-alpha', 30_000)
    note('run-from-current-release', first.pid > 0 && first.releaseId === 'r-alpha',
      `identity.releaseId=${String(first.releaseId)} pid=${String(first.pid)}`)

    // update: drains (nothing live after the stop below switches immediately),
    // installs r-beta, and restarts from it under a new child.
    await runCli(supervisorCli, ['--root', fakeRoot, 'stop'])
    const updater = spawnCli(supervisorCli, ['--root', fakeRoot, 'update', '--from', beta, '--id', 'r-beta', '--drain-timeout', '1000'])
    residents.push(updater)
    const second = await awaitReleaseIdentity(identityPath, identity => identity.releaseId === 'r-beta', 60_000)
    note('update-switches-release', second.pid > 0 && second.pid !== first.pid && second.releaseId === 'r-beta',
      `releaseId=${String(second.releaseId)} pid ${String(first.pid)}→${String(second.pid)}`)

    // rollback returns to r-alpha and keeps r-beta as the rollback target.
    await runCli(supervisorCli, ['--root', fakeRoot, 'stop'])
    const rollbacker = spawnCli(supervisorCli, ['--root', fakeRoot, 'rollback', '--drain-timeout', '1000'])
    residents.push(rollbacker)
    const third = await awaitReleaseIdentity(identityPath, identity => identity.releaseId === 'r-alpha', 60_000)
    note('rollback-returns-previous', third.releaseId === 'r-alpha' && third.pid !== second.pid,
      `releaseId=${String(third.releaseId)} pid ${String(second.pid)}→${String(third.pid)}`)

    // gc: install an unused release; it disappears while current, rollback
    // target, and the live-pinned release survive.
    await runCli(supervisorCli, ['--root', fakeRoot, 'install', '--from', extra, '--id', 'r-extra'])
    const gc = await runCli(supervisorCli, ['--root', fakeRoot, 'gc'])
    const gcReport = JSON.parse(gc.out) as { removedReleases: string[]; kept: Record<string, string> }
    note('gc-keeps-pinned-releases',
      gc.code === 0 && gcReport.removedReleases.includes('r-extra')
        && gcReport.kept['r-alpha'] !== undefined && gcReport.kept['r-beta'] !== undefined,
      `removed=${JSON.stringify(gcReport.removedReleases)} kept=${JSON.stringify(gcReport.kept)}`)

    // Unverified staging may still belong to an installer; GC retains it for explicit recovery.
    await mkdir(join(fakeRoot, 'releases', '.staging-r-torn'), { recursive: true })
    const status = await runCli(supervisorCli, ['--root', fakeRoot, 'status'])
    const statusReport = JSON.parse(status.out) as { staging: string[]; current: { releaseId: string } | null }
    const cleaned = await runCli(supervisorCli, ['--root', fakeRoot, 'gc'])
    const cleanedReport = JSON.parse(cleaned.out) as { removedStaging: string[]; kept: Record<string, string> }
    note('interrupted-install-diagnosable',
      statusReport.staging.includes('.staging-r-torn') && statusReport.current?.releaseId === 'r-alpha'
        && cleanedReport.removedStaging.length === 0
        && cleanedReport.kept['.staging-r-torn']?.includes('ownership is unverified') === true
        && existsSync(join(fakeRoot, 'releases', '.staging-r-torn')),
      `status staging=${JSON.stringify(statusReport.staging)} gc removed=${JSON.stringify(cleanedReport.removedStaging)}`)

    // uninstall keeps data; the purge variant lives in the unit suite.
    await runCli(supervisorCli, ['--root', fakeRoot, 'stop'])
    const keepFile = join(fakeRoot, 'sessions', 'durable.json')
    await mkdir(join(fakeRoot, 'sessions'), { recursive: true })
    await writeFile(keepFile, 'durable')
    const uninstall = await runCli(supervisorCli, ['--root', fakeRoot, 'uninstall'])
    const kept = await readFile(keepFile, 'utf8').catch(() => 'MISSING')
    note('uninstall-keeps-data', uninstall.code === 0 && kept === 'durable', `out=${uninstall.out.trim()} data=${kept}`)
  } catch (error) {
    note('fake-root-driver', false, error instanceof Error ? error.message : String(error))
  } finally {
    killResidents(residents)
    await rm(fakeRoot, { recursive: true, force: true })
  }

  // --- Real-service root: activity drain guards the switch. ---
  const fixture = await mkdtemp(join(tmpdir(), 'gh-lifecycle-real-'))
  const loopback = streamingFixture()
  const port = await loopback.portPromise
  try {
    const home = join(fixture, 'home')
    const workspace = join(fixture, 'workspace')
    const dataRoot = join(fixture, 'data')
    await mkdir(workspace, { recursive: true })
    initGhProfiles(home)
    const identityPath = join(dataRoot, 'run', 'service.json')
    const childEnv = {
      ...process.env,
      DSH_HOME: home,
      GLM_API_KEY: 'synthetic-lifecycle-key',
      GLM_BASE_URL: `http://127.0.0.1:${port}`,
      GH_PERMISSION_MODE: 'yolo',
    }
    const supervisor = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'run', '--',
      process.execPath, join(root, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: workspace, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'],
    })
    const supervisorExited = once(supervisor, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
    let supervisorErr = ''
    supervisor.stderr.setEncoding('utf8').on('data', (chunk: string) => { supervisorErr += chunk })
    try {
      const ready = await awaitReleaseIdentity(identityPath, identity => identity.readyUrl !== null, 120_000)
      const origin = new URL(ready.readyUrl as string).origin
      const exchange = await fetch(ready.readyUrl as string, { redirect: 'manual' })
      const cookie = exchange.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ')
      const call = async (endpoint: string, args: Record<string, unknown>): Promise<unknown> => {
        const response = await fetch(new URL(`/api/${endpoint}`, origin), {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method: endpoint, payload: { args } }),
        })
        return (await response.json() as { result?: { value?: unknown } }).result?.value
      }
      const created = await call('session/create', { request: { cwd: workspace } }) as { sessionId: string }
      const activity = await call('ghRemote/activity', {}) as { runningAgents: number; agents: number }
      note('activity-rpc-idle', activity.runningAgents === 0 && activity.agents >= 1,
        `activity=${JSON.stringify(activity)}`)

      // A long turn holds the drain; the update waits it out, then switches.
      await call('session/prompt', {
        request: {
          requestId: `lifecycle-${Date.now()}`, sessionId: created.sessionId, mode: 'queue',
          content: [{ type: 'text', text: 'run a long turn while the supervisor updates' }],
        },
      })
      const tinyRuntime = join(fixture, 'tiny-release')
      await mkdir(join(tinyRuntime, 'lib'), { recursive: true })
      await writeFile(join(tinyRuntime, 'lib', 'bin.js'), FAKE_RUNTIME('post-update'))
      const updater = spawnCli(supervisorCli, ['--root', dataRoot, 'update', '--from', tinyRuntime, '--id', 'r-post', '--drain-timeout', '30000'])
      const switched = await awaitReleaseIdentity(identityPath, identity => identity.releaseId === 'r-post' && identity.readyUrl !== null, 90_000)
      const busyDuringDrain = updater.err.text.includes('activity idle before switch')
      const turnNotAborted = !loopback.aborted.some(Boolean)
      note('update-drains-activity', switched.releaseId === 'r-post' && busyDuringDrain && turnNotAborted,
        `drain line seen=${String(busyDuringDrain)} noFixtureAbort=${String(turnNotAborted)} releaseId=${String(switched.releaseId)} updaterErr=${updater.err.text.slice(0, 300)}`)
      await runCli(supervisorCli, ['--root', dataRoot, 'stop'])
      await supervisorExited
    } catch (error) {
      note('real-root-driver', false, error instanceof Error ? error.message : String(error))
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
      loopback.server.close()
      loopback.server.closeAllConnections()
      void supervisorErr
    }
  } catch (error) {
    note('real-root-setup', false, error instanceof Error ? error.message : String(error))
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }

  if (values.report !== undefined) {
    const summary = {
      scope: 'release lifecycle over the real supervisor CLI; fake ready-line runtimes for version mechanics, the real gh-remote profile with a streaming loopback GLM fixture for the activity drain, synthetic credentials',
      cases,
      passed: cases.length > 0 && cases.every(entry => entry.passed),
    }
    await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify({ passed: summary.passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
  }
  process.exit(cases.length > 0 && cases.every(entry => entry.passed) ? 0 : 1)
}

if (import.meta.main) await main()
