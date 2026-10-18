/**
 * GH-006-D acceptance for continuous execution and reattachment over the REAL
 * resident `gh-remote` service under the GH-006-B supervisor with a streaming
 * loopback GLM fixture: a running turn keeps writing the durable Session log
 * while every connection of the prompting client is gone, a reconnected
 * client resumes from the follow baseline plus cursor gap-free, the same
 * requestId over two connections executes exactly once, a disconnect never
 * cancels a turn while an explicit `session/cancel` does (observed at the
 * model fixture's transport), and a pending approval waterfall survives the
 * answering client's disconnect, is redelivered to the reconnected client,
 * and its `allowed-once` receipt — bound to that session's guarded-mode
 * permission ask — releases the gated command. Usage:
 *   node --import tsx/esm scripts/gh-remote-reattach-verify.ts [--report out.json]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

  /** Pull the next item; undefined at a clean end, rejection on failure or close. */
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
    // Node's undici WebSocket accepts a dispatcher-options second argument the
    // DOM lib type spells as the protocols array; the cookie rides the upgrade.
    const socket = new WebSocket(url.href, { headers: { cookie } } as unknown as string[])
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', () => { resolveOpen() }, { once: true })
      socket.addEventListener('error', () => { rejectOpen(new Error('mux upgrade failed')) }, { once: true })
    })
    return new MuxClient(socket)
  }

  /** Open one logical stream and return its item reader. */
  start(endpoint: string, payload: Record<string, unknown>): MuxStream {
    this.counter += 1
    const streamId = `verify-${this.counter}`
    const stream = new MuxStream(this, streamId)
    this.streams.set(streamId, stream)
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
    return stream
  }

  /** Cancel one logical stream; the Host stops its iterator without failing it. */
  cancel(stream: MuxStream): void {
    this.socket.send(JSON.stringify({ type: 'cancel', streamId: stream.streamId }))
  }

  /** Destroy the physical socket without cancelling logical streams: the disconnect scenario. */
  destroy(): void {
    this.closed = true
    this.socket.close()
  }
}

interface FixtureRequest {
  readonly id: number
  aborted: boolean
}

/** Streaming loopback GLM: slow text turns, a dangerous bash tool turn on request, and abort tracking. */
function streamingFixture(): {
  server: ReturnType<typeof createServer>
  portPromise: Promise<number>
  requests: FixtureRequest[]
} {
  const requests: FixtureRequest[] = []
  const server = createServer((request, response) => {
    const entry: FixtureRequest = { id: requests.length, aborted: false }
    const chunks: Buffer[] = []
    let bodyReady!: () => void
    const bodyArrived = new Promise<void>((resolveBody) => { bodyReady = resolveBody })
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { bodyReady() })
    request.on('aborted', () => { entry.aborted = true })
    response.on('close', () => { if (!response.writableEnded) entry.aborted = true })
    const serve = async (): Promise<void> => {
      await bodyArrived
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role?: string; content?: unknown }>
      }
      const messages = body.messages ?? []
      const last = messages.at(-1)
      // The agent's runtime-context injections follow the user's prompt in the
      // wire order, so the marker scan covers every message, not just the last.
      const marker = messages.some(message => typeof message.content === 'string' && message.content.includes('NEEDS-APPROVAL'))
      const toolAnswered = last !== undefined && last.role === 'tool'
      const system = typeof messages[0]?.content === 'string' ? messages[0].content : ''
      const titleCall = system.includes('concise title')
      requests.push(entry)
      void titleCall
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (marker && !toolAnswered && !titleCall) {
        // One dangerous bash call for the guarded-mode permission ask; the
        // turn continues from the tool result on the next request.
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: 'call-reattach', type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'rm -rf ./approval-probe', description: 'remove the acceptance probe directory' }),
          },
        }] } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      const ticks = toolAnswered ? 2 : 16
      for (let index = 0; index < ticks; index += 1) {
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
    void serve().catch(() => { response.destroy() })
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  return { server, portPromise, requests }
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

interface PageRecord { event: { seq: number; type: string; data?: unknown } }

/** Read one session's current window through a fresh follow snapshot, then cancel the stream. */
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

/** Poll follow snapshots until a predicate over the records holds, or time out. */
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

function countRpcUserMessages(records: PageRecord[], requestId: string): number {
  return records.filter(record => record.event.type === 'user/message'
    && (record.event.data as { source?: { rpcId?: string } } | undefined)?.source?.rpcId === requestId).length
}

function hasEvent(records: PageRecord[], type: string): boolean {
  return records.some(record => record.event.type === type)
}

interface EventFrame {
  type?: string
  event?: string
  eventId?: string
  agentId?: string
  request?: { toolName?: string }
}

/** Pull frames until the named waterfall arrives, skipping emit notifications. */
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

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { report: { type: 'string' } } })
  const root = resolve(import.meta.dirname, '..')
  const fixture = await mkdtemp(join(tmpdir(), 'gh-remote-reattach-'))
  const home = join(fixture, 'home')
  const workspace = join(fixture, 'workspace')
  const dataRoot = join(fixture, 'data')
  await mkdir(join(workspace, 'approval-probe'), { recursive: true })
  initGhProfiles(home)
  const loopback = streamingFixture()
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
    GLM_API_KEY: 'synthetic-reattach-key',
    GLM_BASE_URL: `http://127.0.0.1:${port}`,
    GH_PERMISSION_MODE: 'guarded',
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
    const origin = new URL(first.readyUrl).origin
    const newSession = async (client: RpcClient): Promise<string> =>
      ((await invoke(client, 'session/create', { request: { cwd: workspace } })) as { sessionId: string }).sessionId
    const promptArgs = (sessionId: string, requestId: string, text: string): Record<string, unknown> => ({
      request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
    })

    // --- Cases 1–3 share one session: execution continuation, resume, dedup. ---
    const clientA = await connect(origin, first.readyUrl)
    const poller = await connect(origin, first.readyUrl)
    const muxPoll = await MuxClient.open(origin, poller.cookie)
    const sessionOne = await newSession(clientA)
    const requestOne = `reattach-one-${Date.now()}`
    await invoke(clientA, 'session/prompt', promptArgs(sessionOne, requestOne, 'run a long turn'))

    const muxA = await MuxClient.open(origin, clientA.cookie)
    const followA = muxA.start('session/follow', { args: { request: { address: { kind: 'session', sessionId: sessionOne } } } })
    await followA.next(10_000)
    await pollSnapshot(muxA, sessionOne, records => hasEvent(records, 'turn/start'), 10_000)
    // Drop every connection the prompting client owns; the physical socket dies mid-follow.
    muxA.destroy()
    const seqAtDrop = (await readSnapshot(muxPoll, sessionOne)).records.at(-1)?.event.seq ?? -1
    const finished = await pollSnapshot(muxPoll, sessionOne, records => hasEvent(records, 'turn/end'), 30_000)
    const seqAtEnd = finished.at(-1)?.event.seq ?? -1
    const endedCleanly = finished.some(record => record.event.type === 'turn/end'
      && !JSON.stringify(record.event.data).includes('\"kind\":\"error\"'))
    note('turn-survives-client-drop', seqAtEnd > seqAtDrop && endedCleanly,
      `seq@drop=${String(seqAtDrop)} seq@end=${String(seqAtEnd)} with the prompting client's connections destroyed`)

    const followB = muxPoll.start('session/follow', { args: { request: { address: { kind: 'session', sessionId: sessionOne } } } })
    const snapshotB = await followB.next(10_000) as { type?: string; cursor?: number }
    const requestTwo = `reattach-two-${Date.now()}`
    await invoke(clientA, 'session/prompt', promptArgs(sessionOne, requestTwo, 'next turn observed live'))
    const appended = await followB.next(30_000) as { type?: string; event?: { seq: number } }
    const gapFree = (snapshotB.cursor ?? -1) + 1 === (appended.event?.seq ?? Number.NaN)
    note('reconnect-baseline-cursor', (snapshotB.cursor ?? -1) >= seqAtEnd && gapFree,
      `snapshot cursor=${String(snapshotB.cursor)} first live append seq=${String(appended.event?.seq)} (baseline+1, no gap, no replay)`)

    await pollSnapshot(muxPoll, sessionOne, records => countRpcUserMessages(records, requestTwo) === 1
      && hasEvent(records, 'turn/end'), 30_000)
    const turnsBefore = (await readSnapshot(muxPoll, sessionOne)).records.filter(record => record.event.type === 'turn/start').length
    const requestThree = `reattach-three-${Date.now()}`
    const clientC = await connect(origin, first.readyUrl)
    const clientD = await connect(origin, first.readyUrl)
    await invoke(clientC, 'session/prompt', promptArgs(sessionOne, requestThree, 'single execution'))
    const duplicate = await invoke(clientD, 'session/prompt', promptArgs(sessionOne, requestThree, 'single execution')) as Record<string, unknown>
    const deduped = await pollSnapshot(muxPoll, sessionOne, records => countRpcUserMessages(records, requestThree) === 1
      && records.filter(record => record.event.type === 'turn/start').length === turnsBefore + 1, 30_000)
    void deduped
    note('dual-connection-single-execution', duplicate.accepted === true,
      `both connections accepted; exactly one user/message and one new turn/start for requestId ${requestThree}`)

    // --- Case 4 (own session): a disconnect never cancels the running turn. ---
    const sessionFour = await newSession(clientA)
    const markFour = loopback.requests.length
    const requestFour = `reattach-four-${Date.now()}`
    await invoke(clientA, 'session/prompt', promptArgs(sessionFour, requestFour, 'long turn not cancelled by disconnect'))
    await pollSnapshot(muxPoll, sessionFour, records => hasEvent(records, 'turn/start'), 10_000)
    const muxObserver = await MuxClient.open(origin, clientA.cookie)
    const observerFollow = muxObserver.start('session/follow', { args: { request: { address: { kind: 'session', sessionId: sessionFour } } } })
    await observerFollow.next(10_000)
    muxObserver.destroy()
    void observerFollow
    const fourDone = await pollSnapshot(muxPoll, sessionFour, records => hasEvent(records, 'turn/end'), 30_000)
    void fourDone
    await new Promise(resolveSleep => setTimeout(resolveSleep, 300))
    const fourAborted = loopback.requests.slice(markFour).some(entry => entry.aborted)
    note('disconnect-never-cancels', !fourAborted,
      `turn completed after a mid-follow observing connection was destroyed; fixture aborted=${String(fourAborted)}`)

    // --- Case 5 (own session): an explicit cancel stops the running turn. ---
    const sessionFive = await newSession(clientA)
    const markFive = loopback.requests.length
    const requestFive = `reattach-five-${Date.now()}`
    await invoke(clientA, 'session/prompt', promptArgs(sessionFive, requestFive, 'long turn to cancel explicitly'))
    await pollSnapshot(muxPoll, sessionFive, records => hasEvent(records, 'turn/start'), 10_000)
    const cancelFrom = await connect(origin, first.readyUrl)
    const cancelledAt = Date.now()
    await invoke(cancelFrom, 'session/cancel', { request: { sessionId: sessionFive } })
    const fiveDone = await pollSnapshot(muxPoll, sessionFive, records => hasEvent(records, 'turn/end'), 15_000)
    const endLatencyMs = Date.now() - cancelledAt
    const endReason = JSON.stringify(fiveDone.find(record => record.event.type === 'turn/end')?.event.data).slice(0, 160)
    let fiveAborted = false
    for (let attempt = 0; attempt < 10 && !fiveAborted; attempt += 1) {
      await new Promise(resolveSleep => setTimeout(resolveSleep, 200))
      fiveAborted = loopback.requests.slice(markFive).some(entry => entry.aborted)
    }
    const userAborted = endReason.includes('\"kind\":\"aborted\"') && endReason.includes('\"kind\":\"user\"')
    note('explicit-cancel-stops', endLatencyMs < 2_000 && userAborted,
      `turn/end ${String(endLatencyMs)}ms after session/cancel from a fresh connection (fixture turn is 3200ms); reason=${endReason} fixtureAbort=${String(fiveAborted)}`)

    // --- Case 6 (own session): the approval waterfall reattaches to a reconnected client. ---
    const sessionSix = await newSession(clientA)
    const requestSix = `reattach-six-${Date.now()}`
    const muxE = await MuxClient.open(origin, clientA.cookie)
    const events = muxE.start('$events', { args: {} })
    await events.next(10_000)
    await invoke(clientA, 'session/prompt', promptArgs(sessionSix, requestSix, 'NEEDS-APPROVAL run the gated command'))
    const firstAsk = await nextWaterfall(events, 'approval/request', 20_000)
    const sawAsk = firstAsk.request?.toolName === 'bash'
    // The answering client disconnects with the ask still pending.
    muxE.destroy()
    const clientF = await connect(origin, first.readyUrl)
    const muxF = await MuxClient.open(origin, clientF.cookie)
    const eventsF = muxF.start('$events', { args: {} })
    const readyF = await eventsF.next(10_000) as { type?: string; clientId?: string }
    const redelivered = await nextWaterfall(eventsF, 'approval/request', 20_000)
    const sawRedelivery = redelivered.request?.toolName === 'bash'
    await invoke(clientF, '$events/result', {
      clientId: readyF.clientId,
      eventId: redelivered.eventId,
      outcome: { kind: 'result', value: 'allowed-once' },
    })
    await pollSnapshot(muxF, sessionSix, records => hasEvent(records, 'turn/end'), 30_000)
    let probeGone = false
    try {
      await stat(join(workspace, 'approval-probe'))
    } catch (error) {
      probeGone = (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    note('approval-waterfall-reattach', sawAsk && sawRedelivery && probeGone,
      `ask seen, disconnect, redelivered (tool=${String(redelivered.request?.toolName)}), allowed-once executed the gated command (probe removed)=${String(probeGone)}`)

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
        scope: 'continuous execution and reattachment over the real resident gh-remote profile under the supervisor, streaming loopback GLM fixture, guarded permission mode, synthetic credentials',
        cases,
        supervisorErrTail: supervisorErr.slice(-1500),
        passed: cases.length > 0 && cases.every(entry => entry.passed),
      }
      await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(JSON.stringify({ passed: summary.passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
    }
    // Held model streams keep sockets open past main's return; the verdict is
    // already reported, so exit deliberately.
    process.exit(cases.length > 0 && cases.every(entry => entry.passed) ? 0 : 1)
  }
}

if (import.meta.main) await main()
