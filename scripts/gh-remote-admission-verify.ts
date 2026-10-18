/**
 * GH-006-C acceptance for durable prompt admission over the REAL resident
 * `gh-remote` service under the GH-006-B supervisor: an acknowledged prompt
 * is durable (queryable by requestId), duplicates reconcile idempotently over
 * an independent connection, a different payload on the same requestId is a
 * conflict, and after a SIGKILL crash + supervisor restart the admission is
 * still queryable, still idempotent, and still conflict-checked from the
 * recovered log. Usage:
 *   node --import tsx/esm scripts/gh-remote-admission-verify.ts [--report out.json]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { initGhProfiles } from './gh-init-profiles.ts'

interface CaseResult { name: string; passed: boolean; detail: string }

interface RpcClient {
  origin: string
  cookie: string
  rpcId: number
}

async function connect(origin: string, authenticatedUrl: string): Promise<RpcClient> {
  const response = await fetch(authenticatedUrl, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ')
  if (cookies === '') throw new Error(`token exchange set no cookie (status ${response.status})`)
  return { origin, cookie: cookies, rpcId: 0 }
}

class RpcFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function invoke(client: RpcClient, namespace: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  client.rpcId += 1
  const endpoint = `${namespace}/${method}`
  const response = await fetch(new URL(`/api/${endpoint}`, client.origin).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `verify-${client.rpcId}`, method: endpoint, payload: { args } }),
  })
  const envelope = await response.json() as {
    type: string
    rpcId: string
    result?: { ok: boolean; value?: unknown; error?: { message: string; code?: string } }
  }
  if (envelope.type !== 'server-response' || envelope.rpcId !== `verify-${client.rpcId}`) {
    throw new Error(`rpc envelope mismatch for ${endpoint}: ${JSON.stringify(envelope).slice(0, 200)}`)
  }
  if (envelope.result?.ok !== true) {
    throw new RpcFailure(envelope.result?.error?.code ?? 'unknown', `${endpoint}: ${envelope.result?.error?.message ?? 'unknown'}`)
  }
  return envelope.result.value
}

/** The loopback GLM endpoint never answers: this driver measures admission, not turns. */
function holdingFixture(): { server: ReturnType<typeof createServer>; portPromise: Promise<number> } {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // Intentionally never ending: the held model stream outlives this script.
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  return { server, portPromise }
}

/** A ready identity with its URL narrowed to a string. */
interface ReadyIdentity { pid: number; readyUrl: string }

async function awaitReadyIdentity(identityPath: string, notPid?: number): Promise<ReadyIdentity> {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(identityPath, 'utf8')) as { pid?: unknown; readyUrl?: unknown }
      if (typeof parsed.pid === 'number' && typeof parsed.readyUrl === 'string' && parsed.pid !== notPid) {
        return { pid: parsed.pid, readyUrl: parsed.readyUrl }
      }
    } catch { /* not yet */ }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 500))
  }
  throw new Error(`supervised service never became ready: ${identityPath}`)
}

/** Connect with retries: undici may pool a stale keep-alive socket to a killed service. */
async function connectWithRetry(origin: string, authenticatedUrl: string): Promise<RpcClient> {
  let failure: unknown = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await connect(origin, authenticatedUrl)
    } catch (error) {
      failure = error
      await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
    }
  }
  throw failure instanceof Error ? failure : new Error(String(failure))
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { report: { type: 'string' } } })
  const root = resolve(import.meta.dirname, '..')
  const fixture = await mkdtemp(join(tmpdir(), 'gh-remote-admission-'))
  const home = join(fixture, 'home')
  const workspace = join(fixture, 'workspace')
  const dataRoot = join(fixture, 'data')
  await mkdir(workspace, { recursive: true })
  initGhProfiles(home)
  const loopback = holdingFixture()
  const port = await loopback.portPromise
  const cases: CaseResult[] = []
  const note = (name: string, passed: boolean, detail: string): void => {
    cases.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }
  const identityPath = join(dataRoot, 'run', 'service.json')
  const supervisorCli = join(root, 'packages', 'glm', 'remote-supervisor', 'lib', 'index.js')
  const childEnv = {
    ...process.env,
    DSH_HOME: home,
    GLM_API_KEY: 'synthetic-admission-key',
    GLM_BASE_URL: `http://127.0.0.1:${port}`,
    GH_PERMISSION_MODE: 'yolo',
  }
  const spawnSupervised = () => spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'run', '--',
    process.execPath, join(root, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'],
  })
  const supervisor = spawnSupervised()
  const supervisorExited = once(supervisor, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  let supervisorErr = ''
  supervisor.stderr.setEncoding('utf8').on('data', (chunk: string) => { supervisorErr += chunk })
  try {
    const first = await awaitReadyIdentity(identityPath)
    const client = await connect(new URL(first.readyUrl).origin, first.readyUrl)
    const created = await invoke(client, 'session', 'create', { request: { cwd: workspace } }) as { sessionId: string }
    const requestId = `admission-${Date.now()}`
    const promptArgs = (text: string): Record<string, unknown> => ({
      request: { requestId, sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
    })
    await invoke(client, 'session', 'prompt', promptArgs('durable once'))
    note('prompt-ack-durable', true, `requestId=${requestId} acknowledged with flush-before-ACK policy`)

    const second = await connect(new URL(first.readyUrl).origin, first.readyUrl)
    const duplicate = await invoke(second, 'session', 'prompt', promptArgs('durable once')) as Record<string, unknown>
    note('duplicate-idempotent', duplicate.accepted === true, `independent connection retry accepted=${String(duplicate.accepted)}`)

    const status = await invoke(second, 'session', 'admission', { request: { sessionId: created.sessionId, requestId } }) as Record<string, unknown>
    note('admission-query-found', status.found === true && typeof status.fingerprint === 'string' && status.fingerprint.length > 0,
      `found=${String(status.found)} fingerprint=${String(status.fingerprint).slice(0, 16)}…`)

    let conflictCode = ''
    try {
      await invoke(second, 'session', 'prompt', promptArgs('different payload'))
    } catch (error) {
      conflictCode = error instanceof RpcFailure ? error.code : `throw:${String(error)}`
    }
    note('conflict-rejected', conflictCode === 'session/request-conflict', `code=${conflictCode}`)

    // Crash the supervised service after the ACK: the admission must survive.
    process.kill(first.pid, 'SIGKILL')
    const restarted = await awaitReadyIdentity(identityPath, first.pid)
    const fresh = await connectWithRetry(new URL(restarted.readyUrl).origin, restarted.readyUrl)
    const recovered = await invoke(fresh, 'session', 'admission', { request: { sessionId: created.sessionId, requestId } }) as Record<string, unknown>
    note('crash-restart-query', recovered.found === true && restarted.pid !== first.pid,
      `new pid=${restarted.pid} query found=${String(recovered.found)}`)

    const resent = await invoke(fresh, 'session', 'prompt', promptArgs('durable once')) as Record<string, unknown>
    note('crash-restart-idempotent', resent.accepted === true, `post-crash retry accepted=${String(resent.accepted)}`)

    let postCrashConflict = ''
    try {
      await invoke(fresh, 'session', 'prompt', promptArgs('post-crash different'))
    } catch (error) {
      postCrashConflict = error instanceof RpcFailure ? error.code : `throw:${String(error)}`
    }
    note('crash-restart-conflict', postCrashConflict === 'session/request-conflict', `code=${postCrashConflict}`)

    const unknown = await invoke(fresh, 'session', 'admission', { request: { sessionId: created.sessionId, requestId: `absent-${Date.now()}` } }) as Record<string, unknown>
    note('admission-query-absent', unknown.found === false, `found=${String(unknown.found)}`)

    const stop = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'stop'], { stdio: 'ignore' })
    await once(stop, 'exit')
    await supervisorExited
  } catch (error) {
    note('driver', false, error instanceof Error ? error.message : String(error))
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
    loopback.server.close()
    loopback.server.closeAllConnections()
    await rm(fixture, { recursive: true, force: true })
    if (values.report !== undefined) {
      const summary = {
        scope: 'durable prompt admission over the real resident gh-remote profile under the supervisor, loopback GLM fixture that never answers, synthetic credentials',
        cases,
        supervisorErrTail: supervisorErr.slice(-1500),
        passed: cases.length > 0 && cases.every(entry => entry.passed),
      }
      await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(JSON.stringify({ passed: summary.passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
    }
    // The held model streams keep sockets open past main's return; the
    // verdict is already reported, so exit deliberately.
    process.exit(cases.length > 0 && cases.every(entry => entry.passed) ? 0 : 1)
  }
}

if (import.meta.main) await main()
