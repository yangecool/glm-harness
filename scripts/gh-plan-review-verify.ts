/**
 * GH-008-B acceptance for the plan-review ledger over the REAL resident
 * `gh-remote` service under the GH-006-B supervisor with a streaming loopback
 * GLM fixture. Cases: entering plan mode through the real `commands/execute`
 * remote and approving the `exit_plan_mode` review through the relayed
 * `user-questions/request` waterfall writes the exact approved text to the
 * deterministic `.glm/plans` plan file and records the `gh-plan/submitted`
 * plus `gh-plan/approved` events; declining with feedback records the
 * annotation without any file; and a user edit of the plan file between
 * approvals is preserved (the later approval records `fileWritten: false`
 * instead of clobbering). Usage:
 *   node --import tsx/esm scripts/gh-plan-review-verify.ts --report out.json
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

async function invoke(client: RpcClient, endpoint: string, args: Record<string, unknown>): Promise<unknown> {
  client.rpcId += 1
  const response = await fetch(new URL(`/api/${endpoint}`, client.origin).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `verify-${client.rpcId}`, method: endpoint, payload: { args } }),
  })
  const envelope = await response.json() as {
    type: string
    rpcId: string
    result?: { ok: boolean; value?: unknown; error?: { message?: string; code?: string } }
  }
  if (envelope.type !== 'server-response' || envelope.rpcId !== `verify-${client.rpcId}`) {
    throw new Error(`rpc envelope mismatch for ${endpoint}: ${JSON.stringify(envelope).slice(0, 200)}`)
  }
  if (envelope.result?.ok !== true) {
    throw new Error(`${endpoint}: ${envelope.result?.error?.message ?? 'unknown failure'}`)
  }
  return envelope.result.value
}

/** One logical Remote stream over the raw mux WebSocket (JSON text frames). */
class MuxStream {
  private readonly frames: unknown[] = []
  private wake: (() => void) | undefined
  private ended = false
  private failure: Error | undefined

  constructor(private readonly mux: MuxClient, readonly streamId: string) {}

  accept(frame: { type: string; value?: unknown; error?: { message?: string } }): void {
    if (frame.type === 'item') this.frames.push(frame.value)
    else if (frame.type === 'error') this.failure = new Error(frame.error?.message ?? 'stream error')
    this.ended = frame.type !== 'item'
    const resume = this.wake
    this.wake = undefined
    resume?.()
  }

  async next(timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (this.frames.length > 0) return this.frames.shift()
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return undefined
      if (this.mux.closed) throw new Error('mux socket closed')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('mux stream item timed out')
      await new Promise<void>((resolveWait) => {
        this.wake = resolveWait
        setTimeout(resolveWait, Math.min(remaining, 200))
      })
    }
  }
}

/** Minimal client half of the `/api/remote.mux` logical-stream WebSocket. */
class MuxClient {
  private readonly socket: WebSocket
  private readonly streams = new Map<string, MuxStream>()
  private counter = 0
  closed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; streamId: string; value?: unknown; error?: { message?: string } }
      this.streams.get(frame.streamId)?.accept(frame)
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const stream of this.streams.values()) stream.accept({ type: 'error', error: { message: 'mux socket closed' } })
    })
  }

  static async open(origin: string, cookie: string): Promise<MuxClient> {
    const url = new URL('/api/remote.mux', origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url.href, { headers: { cookie } } as unknown as string[])
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', () => { resolveOpen() }, { once: true })
      socket.addEventListener('error', () => { rejectOpen(new Error('mux upgrade failed')) }, { once: true })
    })
    return new MuxClient(socket)
  }

  start(endpoint: string, payload: Record<string, unknown>): MuxStream {
    this.counter += 1
    const streamId = `verify-${this.counter}`
    const stream = new MuxStream(this, streamId)
    this.streams.set(streamId, stream)
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
    return stream
  }

  cancel(stream: MuxStream): void {
    this.socket.send(JSON.stringify({ type: 'cancel', streamId: stream.streamId }))
  }
}

/**
 * Streaming loopback GLM: while the driver arms `plan`, the first main
 * request of a turn answers with an `exit_plan_mode` tool call; the
 * tool-result continuation answers with plain text. Title requests and
 * unarmed turns get short text.
 */
function planFixture(): {
  server: ReturnType<typeof createServer>
  portPromise: Promise<number>
  plan: string | null
} {
  const state = { plan: null as string | null }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    let bodyReady!: () => void
    const bodyArrived = new Promise<void>((resolveBody) => { bodyReady = resolveBody })
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { bodyReady() })
    const serve = async (): Promise<void> => {
      await bodyArrived
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        tools?: Array<{ function?: { name?: string } }>
        messages?: Array<{ role?: string; content?: unknown }>
      }
      const main = (body.tools?.length ?? 0) > 0
      const toolAnswered = body.messages?.at(-1)?.role === 'tool'
      const system = typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content : ''
      const titleCall = system.includes('concise title')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (payload: unknown): void => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      if (main && state.plan !== null && !toolAnswered && !titleCall) {
        const plan = state.plan
        state.plan = null
        frame({ choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: 'call-plan-review', type: 'function',
          function: { name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) },
        }] } }] })
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      frame({ choices: [{ index: 0, delta: { content: main ? 'PLAN_REVIEW_DONE' : 'Plan title' } }] })
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      response.write('data: [DONE]\n\n')
      response.end()
    }
    void serve().catch(() => { response.destroy() })
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  return { server, portPromise, get plan() { return state.plan }, set plan(value: string | null) { state.plan = value } }
}

interface ReadyIdentity { pid: number; readyUrl: string }

async function awaitReadyIdentity(identityPath: string): Promise<ReadyIdentity> {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(identityPath, 'utf8')) as { pid?: unknown; readyUrl?: unknown }
      if (typeof parsed.pid === 'number' && typeof parsed.readyUrl === 'string') {
        return { pid: parsed.pid, readyUrl: parsed.readyUrl }
      }
    } catch { /* not yet */ }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 500))
  }
  throw new Error(`supervised service never became ready: ${identityPath}`)
}

interface PageRecord { event: { seq: number; type: string; data?: unknown } }

async function readSnapshot(mux: MuxClient, sessionId: string): Promise<{ records: PageRecord[]; cursor: number }> {
  const stream = mux.start('session/follow', { args: { request: { address: { kind: 'session', sessionId } } } })
  try {
    const snapshot = await stream.next(10_000) as { type?: string; cursor?: number; records?: PageRecord[] }
    if (snapshot.type !== 'snapshot') throw new Error(`follow snapshot expected, got ${JSON.stringify(snapshot).slice(0, 120)}`)
    return { records: snapshot.records ?? [], cursor: typeof snapshot.cursor === 'number' ? snapshot.cursor : -1 }
  } finally {
    mux.cancel(stream)
  }
}

async function pollSnapshot(
  mux: MuxClient,
  sessionId: string,
  predicate: (records: PageRecord[]) => boolean,
  timeoutMs: number,
): Promise<PageRecord[]> {
  let last: PageRecord[] = []
  for (let attempt = 0; attempt < Math.ceil(timeoutMs / 300); attempt += 1) {
    last = (await readSnapshot(mux, sessionId)).records
    if (predicate(last)) return last
    await new Promise(resolveSleep => setTimeout(resolveSleep, 300))
  }
  const tail = last.slice(-24).map(record => `${String(record.event.seq)}:${record.event.type}`).join(', ')
  throw new Error(`session snapshot predicate timed out after ${String(timeoutMs)}ms; last records ${tail}`)
}

function eventOf(records: PageRecord[], type: string): PageRecord | undefined {
  return records.findLast(record => record.event.type === type)
}

interface EventFrame {
  type?: string
  event?: string
  eventId?: string
  request?: {
    questions?: Array<{
      id?: string
      intent?: { kind?: string; approve?: string }
    }>
  }
}

async function nextWaterfall(stream: MuxStream, eventName: string, timeoutMs: number): Promise<EventFrame> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`waterfall ${eventName} not delivered within ${String(timeoutMs)}ms`)
    const frame = await stream.next(remaining) as EventFrame | undefined
    if (frame === undefined) throw new Error('event stream ended before the waterfall arrived')
    if (frame.type === 'waterfall' && frame.event === eventName) return frame
  }
}

/** Drive one full plan review in an already-plan-mode session and answer it. */
async function reviewOnce(
  client: RpcClient,
  eventsStream: MuxStream,
  readyClientId: string,
  sessionId: string,
  fixture: ReturnType<typeof planFixture>,
  plan: string,
  answer: { approved: boolean; feedback?: string },
): Promise<void> {
  fixture.plan = plan
  await invoke(client, 'session/prompt', {
    request: {
      requestId: `plan-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'present the plan' }],
    },
  })
  const ask = await nextWaterfall(eventsStream, 'user-questions/request', 30_000)
  const question = ask.request?.questions?.find(item => item.intent?.kind === 'plan-review')
  if (question === undefined || question.id === undefined) throw new Error('plan-review question missing from the ask')
  const selected = answer.approved
    ? [question.intent?.approve ?? 'Approve']
    : ['Keep planning']
  const value = {
    answers: [{
      id: question.id,
      selected,
      ...(answer.feedback === undefined ? {} : { custom: answer.feedback }),
    }],
  }
  await invoke(client, '$events/result', { clientId: readyClientId, eventId: ask.eventId, outcome: { kind: 'result', value } })
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { report: { type: 'string' } } })
  const root = resolve(import.meta.dirname, '..')
  const fixture = await mkdtemp(join(tmpdir(), 'gh-plan-review-'))
  const home = join(fixture, 'home')
  const workspace = join(fixture, 'workspace')
  const dataRoot = join(fixture, 'data')
  await mkdir(workspace, { recursive: true })
  initGhProfiles(home)
  const loopback = planFixture()
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
    GLM_API_KEY: 'synthetic-plan-review-key',
    GLM_BASE_URL: `http://127.0.0.1:${port}`,
  }
  const supervisor = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'run', '--',
    process.execPath, join(root, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'],
  })
  const supervisorExited = once(supervisor, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  let supervisorErr = ''
  supervisor.stderr.setEncoding('utf8').on('data', (chunk: string) => { supervisorErr += chunk })
  try {
    const first = await awaitReadyIdentity(identityPath)
    const origin = new URL(first.readyUrl).origin
    const client = await connect(origin, first.readyUrl)
    const poller = await connect(origin, first.readyUrl)
    const mux = await MuxClient.open(origin, poller.cookie)
    const events = mux.start('$events', { args: {} })
    const ready = await events.next(10_000) as { clientId?: string }
    const clientId = ready.clientId
    if (typeof clientId !== 'string') throw new Error(`$events ready frame has no clientId: ${JSON.stringify(ready).slice(0, 120)}`)
    const newSession = async (): Promise<string> =>
      ((await invoke(client, 'session/create', { request: { cwd: workspace } })) as { sessionId: string }).sessionId
    const enterPlan = async (sessionId: string): Promise<void> => {
      await invoke(client, 'commands/execute', { agentId: sessionId, line: '/plan', submittedAttachments: [] })
    }
    const planPathFor = (sessionId: string): string =>
      join(workspace, '.glm', 'plans', `plan-${sessionId.replace(/[^A-Za-z0-9._-]/g, '-')}.md`)

    // --- Case 1: approval writes the exact plan text and both ledger events. ---
    const sessionOne = await newSession()
    await enterPlan(sessionOne)
    const PLAN_A = '# Ship the ledger\n\n1. Fold gh-plan events\n2. Write the plan file'
    await reviewOnce(client, events, clientId, sessionOne, loopback, PLAN_A, { approved: true })
    const one = await pollSnapshot(mux, sessionOne, records => records.some(record => record.event.type === 'gh-plan/approved')
      && records.some(record => record.event.type === 'turn/end'), 30_000)
    const approvedOne = eventOf(one, 'gh-plan/approved')?.event.data as { revision?: number; fileWritten?: boolean; planPath?: string } | undefined
    const submittedOne = eventOf(one, 'gh-plan/submitted')?.event.data as { revision?: number } | undefined
    const fileOne = await readFile(planPathFor(sessionOne), 'utf8').catch(() => null)
    note('approve-writes-plan-file',
      fileOne === PLAN_A && approvedOne?.revision === 1 && approvedOne.fileWritten === true && submittedOne?.revision === 1,
      `file bytes exact=${String(fileOne === PLAN_A)} submitted@1=${String(submittedOne?.revision === 1)} approved@1 fileWritten=${String(approvedOne?.fileWritten)}`)

    // --- Case 2: declining with feedback records the annotation, no file. ---
    const sessionTwo = await newSession()
    await enterPlan(sessionTwo)
    await reviewOnce(client, events, clientId, sessionTwo, loopback, PLAN_A, {
      approved: false, feedback: 'REVISE: add a rollback step',
    })
    const two = await pollSnapshot(mux, sessionTwo, records => records.some(record => record.event.type === 'gh-plan/rejected')
      && records.some(record => record.event.type === 'turn/end'), 30_000)
    const rejectedTwo = eventOf(two, 'gh-plan/rejected')?.event.data as { outcome?: string; feedback?: string } | undefined
    const fileTwo = await readFile(planPathFor(sessionTwo), 'utf8').catch(() => null)
    note('decline-records-feedback',
      rejectedTwo?.outcome === 'keep-planning' && rejectedTwo.feedback === 'REVISE: add a rollback step' && fileTwo === null,
      `outcome=${String(rejectedTwo?.outcome)} feedback recorded=${String(rejectedTwo?.feedback === 'REVISE: add a rollback step')} file absent=${String(fileTwo === null)}`)

    // --- Case 3: a user edit between approvals is preserved, never clobbered. ---
    const userEdit = '# User rewrite\n\nMy own steps, not the model\'s'
    await writeFile(planPathFor(sessionOne), userEdit, 'utf8')
    await enterPlan(sessionOne)
    const PLAN_B = '# Ship the ledger v2\n\n1. Fold gh-plan events\n2. Write the plan file\n3. Test the fold'
    await reviewOnce(client, events, clientId, sessionOne, loopback, PLAN_B, { approved: true })
    const three = await pollSnapshot(mux, sessionOne, (records) => {
      const approved = records.filter(record => record.event.type === 'gh-plan/approved')
      return approved.length >= 2 && records.some(record => record.event.type === 'turn/end')
    }, 30_000)
    const approvals = three.filter(record => record.event.type === 'gh-plan/approved')
      .map(record => record.event.data as { revision?: number; fileWritten?: boolean })
    const fileThree = await readFile(planPathFor(sessionOne), 'utf8').catch(() => null)
    note('user-edit-wins',
      fileThree === userEdit && approvals.at(-1)?.revision === 2 && approvals.at(-1)?.fileWritten === false,
      `file still the user's text=${String(fileThree === userEdit)} revision2 fileWritten=${String(approvals.at(-1)?.fileWritten)}`)

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
      const report = {
        scope: 'resident gh-remote service / synthetic loopback GLM / real user-questions relay, no real GLM',
        cases,
        supervisorErr: supervisorErr.slice(0, 4000),
      }
      await writeFile(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`)
    }
    console.log(JSON.stringify({ passed: cases.every(entry => entry.passed), cases: cases.map(entry => entry.name) }))
    // The relayed $events WebSocket can outlive the stopped service; a
    // one-shot acceptance driver exits on its own verdict.
    process.exit(cases.every(entry => entry.passed) ? 0 : 1)
  }
}

await main()
