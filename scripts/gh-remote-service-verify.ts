/**
 * GH-006-A acceptance for the resident `gh-remote` service profile: boots the
 * real profile headless (`--no-open --host 127.0.0.1 --port 0`), observes the
 * readiness announce line, and drives the service over its actual HTTP RPC:
 * no static client payload, token-cookie authentication, ghRemote/identity,
 * one real session turn against the loopback GLM fixture writing into the
 * session workspace, and a second independent connection attaching to the
 * same session. Usage:
 *   node --import tsx/esm scripts/gh-remote-service-verify.ts [--report out.json]
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
        response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'service_write', type: 'function', function: {
          name: 'write', arguments: JSON.stringify({ file_path: target, content: 'GH remote service turn\n' }),
        } }] } }] }))
        response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
      } else {
        response.write(frame({ choices: [{ index: 0, delta: { content: 'GH_REMOTE_SERVICE_DONE' } }] }))
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
  const fixture = await mkdtemp(join(tmpdir(), 'gh-remote-service-'))
  const home = join(fixture, 'home')
  const workspace = join(fixture, 'workspace')
  await mkdir(workspace, { recursive: true })
  initGhProfiles(home)
  const turnTarget = join(workspace, 'service-turn.txt')
  const loopback = loopbackFixture(turnTarget)
  const port = await loopback.portPromise
  const cases: CaseResult[] = []
  const note = (name: string, passed: boolean, detail: string): void => {
    cases.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }
  const child = spawn(process.execPath, [join(root, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: home,
      GLM_API_KEY: 'synthetic-service-key',
      GLM_BASE_URL: `http://127.0.0.1:${port}`,
      GH_PERMISSION_MODE: 'yolo',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  try {
    const readyLine = await new Promise<string>((resolveReady, rejectReady) => {
      const deadline = setTimeout(() => {
        rejectReady(new Error(`service never announced readiness: ${stdout.slice(-500)} ${stderr.slice(-500)}`))
      }, 90_000)
      const poll = setInterval(() => {
        const match = /gh-remote ready: (\S+)/.exec(stdout)
        if (match !== null) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolveReady(match[1] as string)
        }
      }, 250)
    })
    const authenticatedUrl = new URL(readyLine)
    const origin = authenticatedUrl.origin
    note('service-ready-line', true, readyLine)

    const rootResponse = await fetch(origin, { redirect: 'manual' })
    const rootBody = await rootResponse.text().catch(() => '')
    note('no-static-client', rootResponse.status === 401 && !/<html/i.test(rootBody), `unauthenticated GET / -> ${rootResponse.status}, ${rootBody.length} bytes`)

    const client = await connect(origin, authenticatedUrl.href)
    const identity = await invoke(client, 'ghRemote', 'identity', {}) as Record<string, unknown>
    note('identity-rpc', identity.product === 'GLM Harness' && identity.profile === 'gh-remote' && identity.pid === child.pid,
      `product=${String(identity.product)} profile=${String(identity.profile)} pid=${String(identity.pid)} node=${String(identity.node)}`)

    const created = await invoke(client, 'session', 'create', { request: { cwd: workspace } }) as { sessionId: string }
    const sessionId = created.sessionId
    await invoke(client, 'session', 'prompt', {
      request: {
        requestId: `verify-${Date.now()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Write the service verify file and finish.' }],
      },
    })
    let fileSeen = false
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (existsSync(turnTarget)) { fileSeen = true; break }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 500))
    }
    const written = fileSeen ? await readFile(turnTarget, 'utf8') : ''
    note('session-turn-writes', written === 'GH remote service turn\n', fileSeen ? written.trim() : 'file never appeared')

    const second = await connect(origin, authenticatedUrl.href)
    const listed = await invoke(second, 'session', 'list', { _request: {} }) as { items: Array<{ sessionId?: string }> }
    const found = listed.items.some(item => item.sessionId === sessionId)
    note('second-connection-same-session', found, `session/list over a fresh connection reports ${listed.items.length} session(s), target ${found ? 'present' : 'absent'}`)

    child.kill('SIGTERM')
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null]
    note('clean-shutdown', code === 0 && signal === null, `exit=${String(code)} signal=${String(signal)}`)
  } catch (error) {
    note('driver', false, error instanceof Error ? error.message : String(error))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  } finally {
    loopback.server.close()
    loopback.server.closeAllConnections()
    await rm(fixture, { recursive: true, force: true })
    if (values.report !== undefined) {
      const summary = {
        scope: 'resident gh-remote profile over real HTTP RPC, loopback GLM fixture, synthetic credentials',
        cases,
        stdoutTail: stdout.slice(-1500),
        stderrTail: stderr.slice(-1500),
        passed: cases.length > 0 && cases.every(entry => entry.passed),
      }
      await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(JSON.stringify({ passed: summary.passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
    }
  }
}

if (import.meta.main) await main()
