/**
 * GH-006-B acceptance for the remote supervisor over the REAL resident
 * `gh-remote` service: the built supervisor CLI owns the service's data root,
 * publishes its identity, serves a full session turn over the supervised
 * child, refuses a second supervisor on the same root, restarts the service
 * after a SIGKILL (fresh pid, fresh ready URL, RPC works again), and the
 * `status`/`stop` verbs report and drain the resident pair. Usage:
 *   node --import tsx/esm scripts/gh-remote-supervisor-verify.ts [--report out.json]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { initGhProfiles } from './gh-init-profiles.ts'

interface CaseResult { name: string; passed: boolean; detail: string }

interface Identity {
  pid: number
  readyUrl: string | null
  readyAt: number | null
  restarts: number
}

/** The subset the driver waits for: a ready identity with its URL in hand. */
interface ReadyIdentity {
  pid: number
  readyUrl: string
  restarts: number
}

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
    result?: { ok: boolean; value?: unknown; error?: { message: string } }
  }
  if (envelope.type !== 'server-response' || envelope.rpcId !== `verify-${client.rpcId}`) {
    throw new Error(`rpc envelope mismatch for ${endpoint}: ${JSON.stringify(envelope).slice(0, 200)}`)
  }
  if (envelope.result?.ok !== true) throw new Error(`rpc ${endpoint} failed: ${envelope.result?.error?.message ?? 'unknown'}`)
  return envelope.result.value
}

function loopbackFixture(target: string): { server: ReturnType<typeof createServer>; portPromise: Promise<number> } {
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      const body = JSON.parse(raw) as { messages?: Array<{ role: string }> }
      const toolResult = body.messages?.some(message => message.role === 'tool') ?? false
      const frame = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!toolResult) {
        response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'supervisor_write', type: 'function', function: {
          name: 'write', arguments: JSON.stringify({ file_path: target, content: 'GH remote supervised turn\n' }),
        } }] } }] }))
        response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
      } else {
        response.write(frame({ choices: [{ index: 0, delta: { content: 'GH_REMOTE_SUPERVISOR_DONE' } }] }))
        response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      }
      response.write(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      response.end(frame('[DONE]'))
    })
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  return { server, portPromise }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { report: { type: 'string' } } })
  const root = resolve(import.meta.dirname, '..')
  const fixture = await mkdtemp(join(tmpdir(), 'gh-remote-supervisor-'))
  const home = join(fixture, 'home')
  const workspace = join(fixture, 'workspace')
  const dataRoot = join(fixture, 'data')
  await mkdir(workspace, { recursive: true })
  initGhProfiles(home)
  const turnTarget = join(workspace, 'supervised-turn.txt')
  const loopback = loopbackFixture(turnTarget)
  const port = await loopback.portPromise
  const cases: CaseResult[] = []
  const note = (name: string, passed: boolean, detail: string): void => {
    cases.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }
  const identityPath = join(dataRoot, 'run', 'service.json')
  const lockPath = join(dataRoot, 'run', 'supervisor.lock')
  const readIdentityFile = async (): Promise<Identity | null> => {
    try {
      const parsed = JSON.parse(await readFile(identityPath, 'utf8')) as Partial<Identity>
      if (typeof parsed.pid !== 'number') return null
      return { pid: parsed.pid, readyUrl: parsed.readyUrl ?? null, readyAt: parsed.readyAt ?? null, restarts: parsed.restarts ?? 0 }
    } catch {
      return null
    }
  }
  const awaitReadyIdentity = async (): Promise<ReadyIdentity> => {
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const identity = await readIdentityFile()
      if (identity !== null && identity.readyUrl !== null && identity.readyAt !== null) {
        return { pid: identity.pid, readyUrl: identity.readyUrl, restarts: identity.restarts }
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 500))
    }
    throw new Error(`supervised service never became ready: ${identityPath}`)
  }
  const supervisorCli = join(root, 'packages', 'glm', 'remote-supervisor', 'lib', 'index.js')
  const childEnv = {
    ...process.env,
    DSH_HOME: home,
    GLM_API_KEY: 'synthetic-service-key',
    GLM_BASE_URL: `http://127.0.0.1:${port}`,
    GH_PERMISSION_MODE: 'yolo',
  }
  const supervisor = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'run', '--',
    process.execPath, join(root, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let supervisorOut = ''
  let supervisorErr = ''
  supervisor.stdout.setEncoding('utf8').on('data', (chunk: string) => { supervisorOut += chunk })
  supervisor.stderr.setEncoding('utf8').on('data', (chunk: string) => { supervisorErr += chunk })
  const supervisorExited = once(supervisor, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  try {
    const first = await awaitReadyIdentity()
    note('supervised-ready', first.pid !== supervisor.pid, `identity pid=${first.pid} supervisor pid=${supervisor.pid} readyUrl=${first.readyUrl}`)

    const client = await connect(new URL(first.readyUrl).origin, first.readyUrl)
    const identity = await invoke(client, 'ghRemote', 'identity', {}) as Record<string, unknown>
    note('identity-rpc-supervised', identity.pid === first.pid && identity.profile === 'gh-remote',
      `profile=${String(identity.profile)} rpc-pid=${String(identity.pid)} identity-pid=${first.pid}`)

    const created = await invoke(client, 'session', 'create', { request: { cwd: workspace } }) as { sessionId: string }
    await invoke(client, 'session', 'prompt', {
      request: {
        requestId: `supervisor-verify-${Date.now()}`,
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Write the supervised verify file and finish.' }],
      },
    })
    let fileSeen = false
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (existsSync(turnTarget)) { fileSeen = true; break }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 500))
    }
    const written = fileSeen ? await readFile(turnTarget, 'utf8') : ''
    note('session-turn-supervised', written === 'GH remote supervised turn\n', fileSeen ? written.trim() : 'file never appeared')

    const second = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'run', '--',
      process.execPath, join(root, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: workspace, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let secondErr = ''
    second.stderr.setEncoding('utf8').on('data', (chunk: string) => { secondErr += chunk })
    const [secondCode] = await once(second, 'exit') as [number | null, NodeJS.Signals | null]
    note('second-supervisor-refused', secondCode === 69, `exit=${String(secondCode)} stderr=${secondErr.trim().slice(-160)}`)

    process.kill(first.pid, 'SIGKILL')
    let restarted: ReadyIdentity | null = null
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const identity = await readIdentityFile()
      if (identity !== null && identity.pid !== first.pid && identity.readyUrl !== null && identity.readyAt !== null) {
        restarted = { pid: identity.pid, readyUrl: identity.readyUrl, restarts: identity.restarts }
        break
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 500))
    }
    note('crash-restart', restarted !== null && restarted.restarts === 1,
      restarted === null ? 'no replacement identity appeared' : `new pid=${restarted.pid} restarts=${restarted.restarts} readyUrl=${restarted.readyUrl}`)

    if (restarted !== null) {
      // undici may pick a stale keep-alive socket pooled to the killed
      // service; a retry lets the dead connection be discarded in favor of a
      // fresh one to the replacement child.
      let fresh: RpcClient | null = null
      let failure: unknown = null
      for (let attempt = 0; attempt < 5 && fresh === null; attempt += 1) {
        try {
          fresh = await connect(new URL(restarted.readyUrl).origin, restarted.readyUrl)
        } catch (error) {
          failure = error
          await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
        }
      }
      if (fresh === null) throw failure instanceof Error ? failure : new Error(String(failure))
      const identityAfter = await invoke(fresh, 'ghRemote', 'identity', {}) as Record<string, unknown>
      note('rpc-after-restart', identityAfter.pid === restarted.pid, `rpc pid=${String(identityAfter.pid)} identity pid=${restarted.pid}`)
    }

    const status = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'status'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let statusOut = ''
    status.stdout.setEncoding('utf8').on('data', (chunk: string) => { statusOut += chunk })
    await once(status, 'exit')
    const statusIdentity = JSON.parse(statusOut) as Identity | null
    note('status-verb', statusIdentity !== null && typeof statusIdentity.pid === 'number', `status reports pid=${String(statusIdentity?.pid)}`)

    const stop = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'stop'], { stdio: ['ignore', 'ignore', 'ignore'] })
    const [stopCode] = await once(stop, 'exit') as [number | null, NodeJS.Signals | null]
    const [supervisorCode] = await supervisorExited
    let serviceDead = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        process.kill(restarted?.pid ?? first.pid, 0)
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250))
      } catch {
        serviceDead = true
        break
      }
    }
    note('stop-verb-drains', stopCode === 0 && supervisorCode === 0 && serviceDead && !existsSync(identityPath) && !existsSync(lockPath),
      `stop exit=${String(stopCode)} supervisor exit=${String(supervisorCode)} service dead=${String(serviceDead)} identity removed=${String(!existsSync(identityPath))} lock removed=${String(!existsSync(lockPath))}`)
  } catch (error) {
    note('driver', false, error instanceof Error ? error.message : String(error))
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
    loopback.server.close()
    loopback.server.closeAllConnections()
    await rm(fixture, { recursive: true, force: true })
    if (values.report !== undefined) {
      const summary = {
        scope: 'built supervisor CLI over the real resident gh-remote profile, loopback GLM fixture, synthetic credentials',
        cases,
        supervisorOutTail: supervisorOut.slice(-1500),
        supervisorErrTail: supervisorErr.slice(-1500),
        passed: cases.length > 0 && cases.every(entry => entry.passed),
      }
      await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(JSON.stringify({ passed: summary.passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
    }
  }
}

if (import.meta.main) await main()
