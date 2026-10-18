/**
 * GH-006-F joint acceptance: the disconnect/crash/restart matrix over the REAL
 * resident `gh-remote` service under the REAL supervisor, plus true resident
 * memory sampling. The matrix covers, each as its own case: a full client
 * process SIGKILL mid-turn (the desktop-exit analog: real Electron exiting
 * against the resident service arrives with the desktop remote UI), a
 * supervisor SIGKILL mid-turn (the orphaned service finishes the turn, a
 * second supervisor is refused while the orphan runs, `stop` drains it), a
 * service SIGKILL mid-turn (the supervisor restarts it, the in-flight
 * admission stays queryable, the session log survives, a new turn runs), a
 * real `systemctl --user` restart of the supervisor unit, and a real OpenSSH
 * deployment: the resident service is installed through the fixture sshd,
 * started detached so it survives the starting session, reached only through
 * an `ssh -L` tunnel, and the tunnel's SIGKILL mid-task leaves the remote
 * turn running to completion for a fresh tunnel to observe. MEM03 samples the
 * idle resident tree (supervisor + service) and MEM04 drives a
 * ten-thousand-event tool loop, samples the peak, then samples the long-term
 * idle recovery. Machine reboot is NOT simulated (needs the physical host or
 * container privileges this environment lacks) and stays a recorded boundary.
 * Usage:
 *   node --import tsx/esm scripts/gh-remote-joint-verify.ts [--report out.json]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { initGhProfiles } from './gh-init-profiles.ts'
import { startFixtureSshd } from './gh-remote/sshd-fixture.ts'
import { bootstrapLifecycle, deployRuntime, remoteCommand } from './gh-remote/deploy.ts'
import { remoteTargetSchema } from './gh-remote/targets.ts'
import { sshArguments } from './gh-remote/probe.ts'

interface CaseResult { name: string; passed: boolean; detail: string }

/** One GLM request as the loopback fixture saw it, with abort tracking. */
interface FixtureRequest { readonly id: number; aborted: boolean }

/**
 * Loopback GLM fixture for the scenario server: slow text turns (the
 * disconnect window), one write-then-stream turn when the prompt names a file,
 * and short title answers. `streamTicks` sizes the long turns.
 */
function scenarioFixture(streamTicks: number): {
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
      const system = typeof messages[0]?.content === 'string' ? messages[0].content : ''
      const titleCall = system.includes('concise title')
      const writeMarker = messages.find(message => typeof message.content === 'string'
        && message.content.includes('WRITE-FILE'))
      const writePath = writeMarker !== undefined
        ? /WRITE-FILE (\S+)/.exec(writeMarker.content as string)?.[1] ?? null
        : null
      const toolAnswered = messages.some(message => message.role === 'tool')
      requests.push(entry)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (titleCall) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'joint title' } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      if (writePath !== null && !toolAnswered) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: 'call-joint-write', type: 'function',
          function: {
            name: 'write',
            arguments: JSON.stringify({ file_path: writePath, content: 'GH joint matrix proof\n' }),
          },
        }] } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      const ticks = toolAnswered ? 4 : streamTicks
      for (let index = 0; index < ticks; index += 1) {
        await new Promise(resolveTick => setTimeout(resolveTick, 200))
        // Only the writable side proves the caller went away.
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

/**
 * Loopback GLM fixture for the MEM task: a write-tool loop of `rounds`
 * rounds to one file (the fixed lightweight tool), then a final text turn.
 */
function memTaskFixture(rounds: number, target: string): {
  server: ReturnType<typeof createServer>
  portPromise: Promise<number>
  requestCount: { value: number }
} {
  const requestCount = { value: 0 }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    let bodyReady!: () => void
    const bodyArrived = new Promise<void>((resolveBody) => { bodyReady = resolveBody })
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { bodyReady() })
    const serve = async (): Promise<void> => {
      await bodyArrived
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role?: string; content?: unknown }>
        tools?: unknown[]
      }
      const warm = body.messages?.some(message => typeof message.content === 'string'
        && message.content.includes('GH-WARM')) ?? false
      const toolResult = body.messages?.some(message => message.role === 'tool') ?? false
      const isMain = (body.tools ?? []).length > 0
      requestCount.value += 1
      const index = requestCount.value
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!isMain || warm) {
        response.write(frame({ choices: [{ delta: { content: 'GH joint mem session' } }] }))
        response.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      } else if (toolResult && index - 1 >= rounds) {
        response.write(frame({ choices: [{ delta: { content: 'GH_JOINT_MEM_DONE' } }] }))
        response.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      } else {
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `joint_mem_${index}`, type: 'function', function: {
          name: 'write',
          arguments: JSON.stringify({ file_path: target, content: `GH joint mem round ${index}\n` }),
        } }] } }] }))
        response.write(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
      }
      response.write(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      response.end(frame('[DONE]'))
    }
    void serve().catch(() => { response.destroy() })
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  return { server, portPromise, requestCount }
}

interface RpcClient { origin: string; cookie: string; rpcId: number }

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

interface Identity { pid: number; readyUrl: string | null; restarts: number }

async function awaitIdentity(
  identityPath: string,
  predicate: (identity: Identity) => boolean,
  timeoutMs: number,
): Promise<Identity> {
  for (let attempt = 0; attempt < Math.ceil(timeoutMs / 300); attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(identityPath, 'utf8')) as { pid?: unknown; readyUrl?: unknown; restarts?: unknown }
      const identity: Identity = {
        pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
        readyUrl: typeof parsed.readyUrl === 'string' ? parsed.readyUrl : null,
        restarts: typeof parsed.restarts === 'number' ? parsed.restarts : -1,
      }
      if (identity.pid > 0 && predicate(identity)) return identity
    } catch { /* not yet */ }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 300))
  }
  throw new Error(`identity predicate timed out after ${String(timeoutMs)}ms: ${identityPath}`)
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

function hasEvent(records: PageRecord[], type: string): boolean {
  return records.some(record => record.event.type === type)
}

/** One whole-tree memory observation of a local process tree. */
interface TreeSample {
  pids: number[]
  rssKb: number
  pssKb: number
  perProcess: Array<{ pid: number; rssKb: number; pssKb: number; command: string }>
}

/** Sum Rss/Pss over every living descendant of `rootPid` (inclusive) from /proc. */
const sampleTree = async (rootPid: number): Promise<TreeSample> => {
  const entries = await readdir('/proc')
  const parents = await Promise.all(entries
    .filter(entry => /^\d+$/.test(entry))
    .map(async (entry) => {
      try {
        const stat = await readFile(`/proc/${entry}/stat`, 'utf8')
        const close = stat.lastIndexOf(')')
        const fields = stat.slice(close + 2).split(' ')
        const ppid = Number(fields[1])
        return [Number(entry), Number.isFinite(ppid) ? ppid : -1] as const
      } catch {
        return null
      }
    }))
  const parentOf = new Map<number, number>(parents.filter((pair): pair is readonly [number, number] => pair !== null))
  const members = new Set<number>([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, ppid] of parentOf) {
      if (members.has(ppid) && !members.has(pid)) {
        members.add(pid)
        changed = true
      }
    }
  }
  const perProcess: TreeSample['perProcess'] = []
  for (const pid of members) {
    try {
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
      let rss = 0
      let pss = 0
      for (const line of rollup.split('\n')) {
        const match = /^(Rss|Pss):\s+(\d+) kB$/.exec(line)
        if (match === null) continue
        if (match[1] === 'Rss') rss = Number(match[2])
        else pss = Number(match[2])
      }
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[1] ?? ''
      perProcess.push({ pid, rssKb: rss, pssKb: pss, command })
    } catch { /* raced away between discovery and sampling */ }
  }
  return {
    pids: [...members],
    rssKb: perProcess.reduce((sum, each) => sum + each.rssKb, 0),
    pssKb: perProcess.reduce((sum, each) => sum + each.pssKb, 0),
    perProcess,
  }
}

const median = (values: number[]): number => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

/** Count durable session-journal lines under a sessions root (newest tree when unknown). */
const countJournalLines = async (sessionsRoot: string, sessionId: string): Promise<number> => {
  const { execFile } = await import('node:child_process')
  const run = (args: string[]): Promise<string> => new Promise((resolveRun, rejectRun) => {
    execFile('sh', args, (error, stdout) => {
      if (error === null) resolveRun(stdout)
      else rejectRun(error instanceof Error ? error : new Error(JSON.stringify(error)))
    })
  })
  let trees = (await readdir(sessionsRoot).catch(() => []))
    .map(entry => join(sessionsRoot, entry))
  const direct = join(sessionsRoot, sessionId)
  if (await stat(direct).then(() => true).catch(() => false)) trees = [direct]
  if (trees.length === 0) return 0
  let total = 0
  for (const tree of trees) {
    const counted = await run(['-c', `find ${JSON.stringify(tree)} -name '*.jsonl.zstd' -print0 | xargs -0 -r cat | zstd -dc 2>/dev/null | wc -l`]).catch(() => '0')
    total += Number.parseInt(counted.trim(), 10) || 0
  }
  return total
}

/** The standalone prompting client whose whole process dies mid-turn. */
const CLIENT_SCRIPT = `
const origin = new URL(process.argv[1]).origin
const main = async () => {
  const exchange = await fetch(process.argv[1], { redirect: 'manual' })
  const cookie = exchange.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ')
  const post = async (endpoint, args) => fetch(origin + '/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method: endpoint, payload: { args } }),
  }).then(response => response.json())
  const created = await post('session/create', { request: { cwd: process.argv[4] } })
  const sessionId = created.result.value.sessionId
  require('node:fs').writeFileSync(process.argv[3], sessionId)
  await post('session/prompt', { request: {
    requestId: process.argv[2], sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'WRITE-FILE ' + process.argv[5] + ' then finish the long turn' }],
  } })
  const socket = new WebSocket(origin.replace('http', 'ws') + '/api/remote.mux', { headers: { cookie } })
  socket.addEventListener('message', () => {})
}
main().catch(error => { console.error(error); process.exit(1) })
setInterval(() => {}, 1 << 30)
`

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { report: { type: 'string' } } })
  const root = resolve(import.meta.dirname, '..')
  const supervisorCli = join(root, 'packages', 'glm', 'remote-supervisor', 'lib', 'index.js')
  const binJs = join(root, 'apps', 'cli', 'lib', 'bin.js')
  const archive = join(root, 'dist-exe', 'gh-remote', 'gh-remote-0.2.1-rc.1-linux-x64.tar.gz')
  const cases: CaseResult[] = []
  const boundaries: string[] = []
  const note = (name: string, passed: boolean, detail: string): void => {
    cases.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }
  const loopback = scenarioFixture(16)
  const port = await loopback.portPromise

  const fixtureBase = await mkdtemp(join(tmpdir(), 'gh-joint-'))

  /** Boot one local resident service under the real supervisor CLI. */
  const bootResident = async (name: string): Promise<{
    supervisor: ReturnType<typeof spawn>
    dataRoot: string
    home: string
    workspace: string
    identityPath: string
  }> => {
    const dir = join(fixtureBase, name)
    const home = join(dir, 'home')
    const workspace = join(dir, 'workspace')
    const dataRoot = join(dir, 'data')
    await mkdir(workspace, { recursive: true })
    initGhProfiles(home)
    const supervisor = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'run', '--',
      process.execPath, binJs, '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: workspace, env: {
        ...process.env,
        DSH_HOME: home,
        GLM_API_KEY: 'synthetic-joint-key',
        GLM_BASE_URL: `http://127.0.0.1:${port}`,
        GH_PERMISSION_MODE: 'yolo',
      }, stdio: ['ignore', 'ignore', 'pipe'],
    })
    return { supervisor, dataRoot, home, workspace, identityPath: join(dataRoot, 'run', 'service.json') }
  }
  const residents: Array<{ supervisor: ReturnType<typeof spawn>; dataRoot: string }> = []
  const stopResident = async (resident: { supervisor: ReturnType<typeof spawn>; dataRoot: string }): Promise<void> => {
    if (resident.supervisor.exitCode === null && resident.supervisor.signalCode === null) {
      resident.supervisor.kill('SIGKILL')
    }
    const stop = spawn(process.execPath, [supervisorCli, '--root', resident.dataRoot, 'stop'], { stdio: 'ignore' })
    await once(stop, 'exit')
  }

  // --- Boot 1: desktop-exit analog, then the supervisor-crash matrix. ---
  try {
    const resident = await bootResident('crash-matrix')
    residents.push(resident)
    const ready = await awaitIdentity(resident.identityPath, identity => identity.readyUrl !== null, 120_000)
    const origin = new URL(ready.readyUrl as string).origin
    const client = await connect(origin, ready.readyUrl as string)
    const observer = await connect(origin, ready.readyUrl as string)
    const muxObserver = await MuxClient.open(origin, observer.cookie)
    const newSession = async (): Promise<string> =>
      ((await invoke(client, 'session/create', { request: { cwd: resident.workspace } })) as { sessionId: string }).sessionId
    const prompt = (sessionId: string, requestId: string, text: string): Promise<unknown> =>
      invoke(client, 'session/prompt', {
        request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      })

    // Case: a full client process (the desktop-exit analog) dies mid-turn.
    const proofFile = join(resident.workspace, 'desktop-exit-proof.txt')
    const sessionNote = join(resident.workspace, 'client-session.txt')
    const childRequest = `desktop-exit-${Date.now()}`
    const childClient = spawn(process.execPath, ['-e', CLIENT_SCRIPT, ready.readyUrl as string, childRequest, sessionNote,
      resident.workspace, proofFile], { stdio: ['ignore', 'ignore', 'pipe'] })
    let childErr = ''
    childClient.stderr.setEncoding('utf8').on('data', (chunk: string) => { childErr += chunk })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(sessionNote)
        break
      } catch {
        await new Promise(resolveSleep => setTimeout(resolveSleep, 200))
      }
    }
    void childErr
    const desktopSession = (await readFile(sessionNote, 'utf8').catch((error: unknown) => {
      throw new Error(`standalone client never reported its session: ${childErr.slice(0, 400)} (${String(error)})`)
    })).trim()
    const markDesktop = loopback.requests.length
    await pollSnapshot(muxObserver, desktopSession, records => hasEvent(records, 'turn/start'), 15_000)
    childClient.kill('SIGKILL')
    await once(childClient, 'exit')
    const desktopDone = await pollSnapshot(muxObserver, desktopSession, records => hasEvent(records, 'turn/end'), 30_000)
    await new Promise(resolveSleep => setTimeout(resolveSleep, 300))
    const desktopAborted = loopback.requests.slice(markDesktop).some(entry => entry.aborted)
    const desktopFile = await readFile(proofFile, 'utf8').catch(() => 'MISSING')
    const desktopEndedCleanly = desktopDone.some(record => record.event.type === 'turn/end'
      && !JSON.stringify(record.event.data).includes('"kind":"error"'))
    note('desktop-client-process-exit', desktopEndedCleanly && desktopFile === 'GH joint matrix proof\n' && !desktopAborted,
      `client process SIGKILLed mid-turn; turn completed (file written=${String(desktopFile !== 'MISSING')}, fixture aborted=${String(desktopAborted)})`)

    // Case: the supervisor dies mid-turn; the orphaned service finishes it.
    const supervisorSession = await newSession()
    const supervisorRequest = `supervisor-crash-${Date.now()}`
    await prompt(supervisorSession, supervisorRequest, 'long turn across the supervisor crash')
    await pollSnapshot(muxObserver, supervisorSession, records => hasEvent(records, 'turn/start'), 15_000)
    resident.supervisor.kill('SIGKILL')
    await once(resident.supervisor, 'exit')
    const crashDone = await pollSnapshot(muxObserver, supervisorSession, records => hasEvent(records, 'turn/end'), 30_000)
    const crashEndedCleanly = crashDone.some(record => record.event.type === 'turn/end'
      && !JSON.stringify(record.event.data).includes('"kind":"error"'))
    const afterCrash = await awaitIdentity(resident.identityPath, () => true, 5_000)
    const orphanAlive = afterCrash.pid > 0 && (await readFile(`/proc/${String(afterCrash.pid)}/stat`).then(() => true).catch(() => false))
    const takeover = spawn(process.execPath, [supervisorCli, '--root', resident.dataRoot, 'run', '--',
      process.execPath, binJs, '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let takeoverErr = ''
    takeover.stderr.setEncoding('utf8').on('data', (chunk: string) => { takeoverErr += chunk })
    const [takeoverCode] = await once(takeover, 'exit') as [number | null, NodeJS.Signals | null]
    const stop = spawn(process.execPath, [supervisorCli, '--root', resident.dataRoot, 'stop'], { stdio: 'ignore' })
    const [stopCode] = await once(stop, 'exit') as [number | null, NodeJS.Signals | null]
    const orphanDead = await readFile(`/proc/${String(afterCrash.pid)}/stat`).then(() => false).catch(() => true)
    const identityCleared = await readFile(resident.identityPath).then(() => false).catch(() => true)
    note('supervisor-crash-orphan-finishes-and-takeover-refused',
      crashEndedCleanly && orphanAlive && takeoverCode === 69 && takeoverErr.includes('still runs')
        && stopCode === 0 && orphanDead && identityCleared,
      `turn completed after supervisor SIGKILL (orphan alive=${String(orphanAlive)}); second run exit=${String(takeoverCode)}`
        + ` (${takeoverErr.trim().slice(0, 90)}); stop cleared the root (orphan dead=${String(orphanDead)})`)
    muxObserver.destroy()
    residents.pop()
  } catch (error) {
    note('crash-matrix-driver', false, error instanceof Error ? error.message : String(error))
  }

  // --- Boot 2: the runtime (service) crash matrix. ---
  try {
    const resident = await bootResident('runtime-crash')
    residents.push(resident)
    const ready = await awaitIdentity(resident.identityPath, identity => identity.readyUrl !== null, 120_000)
    const origin = new URL(ready.readyUrl as string).origin
    const client = await connect(origin, ready.readyUrl as string)
    const observer = await connect(origin, ready.readyUrl as string)
    const muxObserver = await MuxClient.open(origin, observer.cookie)
    const session = ((await invoke(client, 'session/create', { request: { cwd: resident.workspace } })) as { sessionId: string }).sessionId
    const request = `runtime-crash-${Date.now()}`
    await invoke(client, 'session/prompt', {
      request: { requestId: request, sessionId: session, mode: 'queue', content: [{ type: 'text', text: 'long turn across the service crash' }] },
    })
    await pollSnapshot(muxObserver, session, records => hasEvent(records, 'turn/start'), 15_000)
    process.kill(ready.pid, 'SIGKILL')
    const reborn = await awaitIdentity(resident.identityPath, identity => identity.pid !== ready.pid && identity.readyUrl !== null, 60_000)
    const newOrigin = new URL(reborn.readyUrl as string).origin
    const reconnected = await connect(newOrigin, reborn.readyUrl as string)
    const admission = await invoke(reconnected, 'session/admission', { request: { sessionId: session, requestId: request } }) as Record<string, unknown>
    const muxReborn = await MuxClient.open(newOrigin, reconnected.cookie)
    const persisted = (await readSnapshot(muxReborn, session)).records
    const sawStart = hasEvent(persisted, 'turn/start')
    const followUp = `runtime-recovered-${Date.now()}`
    await invoke(reconnected, 'session/prompt', {
      request: { requestId: followUp, sessionId: session, mode: 'queue', content: [{ type: 'text', text: 'a fresh turn on the restarted service' }] },
    })
    const recovered = await pollSnapshot(muxReborn, session, records => hasEvent(records, 'turn/end'), 30_000)
    const recoveredCleanly = recovered.some(record => record.event.type === 'turn/end'
      && !JSON.stringify(record.event.data).includes('"kind":"error"'))
    const admissionAnswered = typeof admission.found === 'boolean'
    note('runtime-crash-restarts-preserves-session',
      reborn.restarts === 1 && admissionAnswered && sawStart && recoveredCleanly,
      `service SIGKILLed mid-turn; supervisor restarted it (pid ${String(ready.pid)}→${String(reborn.pid)}, restarts=${String(reborn.restarts)});`
        + ` admission query answered (found=${String(admission.found)}: the crash hit mid-execution, after the admission had`
        + ' retired into the durable session log); session log kept turn/start; new turn completed')
    muxObserver.destroy()
    muxReborn.destroy()
  } catch (error) {
    note('runtime-crash-driver', false, error instanceof Error ? error.message : String(error))
  }

  // --- Boot 3: a real systemd user service, restarted by systemctl. ---
  const unitName = `gh-joint-verify-${Date.now()}`
  try {
    const dir = join(fixtureBase, 'systemd')
    const home = join(dir, 'home')
    const workspace = join(dir, 'workspace')
    const dataRoot = join(dir, 'data')
    await mkdir(workspace, { recursive: true })
    initGhProfiles(home)
    const { execFile } = await import('node:child_process')
    const runSystemd = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
      new Promise((resolveRun) => {
        execFile('systemctl', ['--user', ...args], (error, stdout, stderr) => {
          resolveRun({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, out: stdout, err: stderr })
        })
      })
    const identityPath = join(dataRoot, 'run', 'service.json')
    const unitStart = await new Promise<{ code: number; err: string }>((resolveRun) => {
      execFile('systemd-run', ['--user', '--collect', `--unit=${unitName}`, '--description=GH joint verify resident service',
        '-p', `WorkingDirectory=${workspace}`,
        '-p', `Environment=DSH_HOME=${home}`,
        '-p', 'Environment=GLM_API_KEY=synthetic-joint-key',
        '-p', `Environment=GLM_BASE_URL=http://127.0.0.1:${port}`,
        '-p', 'Environment=GH_PERMISSION_MODE=yolo',
        process.execPath, supervisorCli, '--root', dataRoot, 'run', '--',
        process.execPath, binJs, '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], (error, _stdout, stderr) => {
        resolveRun({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, err: stderr })
      })
    })
    if (unitStart.code !== 0) throw new Error(`systemd-run failed: ${unitStart.err}`)
    const first = await awaitIdentity(identityPath, identity => identity.readyUrl !== null, 120_000)
    const origin = new URL(first.readyUrl as string).origin
    const client = await connect(origin, first.readyUrl as string)
    const session = ((await invoke(client, 'session/create', { request: { cwd: workspace } })) as { sessionId: string }).sessionId
    await invoke(client, 'session/prompt', {
      request: { requestId: `pre-restart-${Date.now()}`, sessionId: session, mode: 'queue', content: [{ type: 'text', text: 'turn before the unit restart' }] },
    })
    const observer = await connect(origin, first.readyUrl as string)
    const muxObserver = await MuxClient.open(origin, observer.cookie)
    const beforeRestart = await pollSnapshot(muxObserver, session, records => hasEvent(records, 'turn/end'), 30_000)
    const eventsBefore = beforeRestart.length
    await runSystemd(['restart', unitName])
    const second = await awaitIdentity(identityPath, identity => identity.readyUrl !== null && identity.pid !== first.pid, 120_000)
    const newOrigin = new URL(second.readyUrl as string).origin
    const reconnected = await connect(newOrigin, second.readyUrl as string)
    const muxReborn = await MuxClient.open(newOrigin, reconnected.cookie)
    const survived = (await readSnapshot(muxReborn, session)).records.length
    await invoke(reconnected, 'session/prompt', {
      request: { requestId: `post-restart-${Date.now()}`, sessionId: session, mode: 'queue', content: [{ type: 'text', text: 'turn after the unit restart' }] },
    })
    const afterRestart = await pollSnapshot(muxReborn, session, records => records.length > survived && hasEvent(records, 'turn/end'), 30_000)
    void afterRestart
    await runSystemd(['stop', unitName])
    await runSystemd(['reset-failed', unitName]).catch(() => undefined)
    note('user-service-restart-preserves-state',
      second.pid !== first.pid && survived >= eventsBefore,
      `systemctl --user restart: service pid ${String(first.pid)}→${String(second.pid)}; session events survived`
        + ` (${String(survived)}/${String(eventsBefore)} records) and a new turn completed after restart`)
    muxObserver.destroy()
    muxReborn.destroy()
  } catch (error) {
    note('user-service-restart-driver', false, error instanceof Error ? error.message : String(error))
    await import('node:child_process').then(({ execFile }) => execFile('systemctl', ['--user', 'stop', unitName], () => {}))
  }

  // --- Boot 4: MEM03 idle tree, then MEM04 task peak and long-term recovery. ---
  const memTarget = join(fixtureBase, 'mem-target.txt')
  const memLoop = memTaskFixture(2_400, memTarget)
  const memPort = await memLoop.portPromise
  try {
    const dir = join(fixtureBase, 'mem')
    const home = join(dir, 'home')
    const workspace = await (async () => { await mkdir(dir, { recursive: true }); return join(dir, 'workspace') })()
    const dataRoot = join(dir, 'data')
    await mkdir(workspace, { recursive: true })
    initGhProfiles(home)
    const supervisor = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'run', '--',
      process.execPath, binJs, '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: workspace, env: {
        ...process.env,
        DSH_HOME: home,
        GLM_API_KEY: 'synthetic-mem-key',
        GLM_BASE_URL: `http://127.0.0.1:${memPort}`,
        GH_PERMISSION_MODE: 'yolo',
      }, stdio: ['ignore', 'ignore', 'pipe'],
    })
    residents.push({ supervisor, dataRoot })
    const identityPath = join(dataRoot, 'run', 'service.json')
    const ready = await awaitIdentity(identityPath, identity => identity.readyUrl !== null, 120_000)
    const origin = new URL(ready.readyUrl as string).origin
    const client = await connect(origin, ready.readyUrl as string)
    const observer = await connect(origin, ready.readyUrl as string)
    const muxObserver = await MuxClient.open(origin, observer.cookie)
    // Warm every path once, then disconnect every client and let it settle.
    const warm = ((await invoke(client, 'session/create', { request: { cwd: workspace } })) as { sessionId: string }).sessionId
    await invoke(client, 'session/prompt', {
      request: { requestId: `warm-${Date.now()}`, sessionId: warm, mode: 'queue', content: [{ type: 'text', text: 'GH-WARM warm the service' }] },
    })
    await pollSnapshot(muxObserver, warm, records => hasEvent(records, 'turn/end'), 30_000)
    muxObserver.destroy()

    const idleSamples: number[] = []
    for (let index = 0; index < 12; index += 1) {
      if (index === 0) await new Promise(resolveSleep => setTimeout(resolveSleep, 20_000))
      else await new Promise(resolveSleep => setTimeout(resolveSleep, 5_000))
      idleSamples.push((await sampleTree(supervisor.pid ?? -1)).pssKb)
    }
    const idleBreakdown = (await sampleTree(supervisor.pid ?? -1)).perProcess
      .map(each => `${each.pid}:${each.command.split('/').at(-1) ?? ''}=${String(Math.round(each.pssKb / 1024))}MiB`).join(' ')
    const idleMedianKb = median(idleSamples)
    note('mem03-idle-service-tree', idleMedianKb <= 256 * 1024,
      `resident idle tree (supervisor ${String(supervisor.pid)} + service) PSS median ${String(Math.round(idleMedianKb / 1024))} MiB`
        + ` over ${String(idleSamples.length)} samples / 60s idle, budget 256 MiB; breakdown ${idleBreakdown}`)

    // MEM04: one representative ten-thousand-event tool loop, peak sampled every second.
    const taskClient = await connect(origin, ready.readyUrl as string)
    const taskObserver = await connect(origin, ready.readyUrl as string)
    const muxTask = await MuxClient.open(origin, taskObserver.cookie)
    const taskSession = ((await invoke(taskClient, 'session/create', { request: { cwd: workspace } })) as { sessionId: string }).sessionId
    const taskRequest = `mem-task-${Date.now()}`
    const peak = { pssKb: 0, rssKb: 0 }
    void (async (): Promise<void> => {
      while (true) {
        const sample = await sampleTree(supervisor.pid ?? -1)
        peak.pssKb = Math.max(peak.pssKb, sample.pssKb)
        peak.rssKb = Math.max(peak.rssKb, sample.rssKb)
        await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
      }
    })().catch(() => undefined)
    await invoke(taskClient, 'session/prompt', {
      request: { requestId: taskRequest, sessionId: taskSession, mode: 'queue', content: [{ type: 'text', text: 'run the scripted memory task' }] },
    })
    await pollSnapshot(muxTask, taskSession, records => hasEvent(records, 'turn/end'), 600_000)
    // The follow snapshot is a window; the durable journal on disk is the count.
    const journalLines = await countJournalLines(join(home, 'sessions'), taskSession)
    const memArtifact = await readFile(memTarget, 'utf8').catch(() => '')
    const events = journalLines
    const taskPeakKb = peak.pssKb
    // Long-term recovery: two idle minutes after the task.
    const recoverySamples: number[] = []
    for (let index = 0; index < 24; index += 1) {
      if (index > 0) await new Promise(resolveSleep => setTimeout(resolveSleep, 5_000))
      recoverySamples.push((await sampleTree(supervisor.pid ?? -1)).pssKb)
    }
    const recoveryMedianKb = median(recoverySamples)
    const lastRound = Number(/round (\d+)/.exec(memArtifact)?.[1] ?? '0')
    note('mem04-task-peak-and-recovery',
      taskPeakKb <= 512 * 1024 && events >= 10_000 && lastRound >= 2_000,
      `tool-loop task ${String(events)} durable journal lines (${String(memLoop.requestCount.value)} model calls), peak tree PSS`
        + ` ${String(Math.round(taskPeakKb / 1024))} MiB (budget 512), post-task idle median ${String(Math.round(recoveryMedianKb / 1024))} MiB`
        + ` vs pre-task ${String(Math.round(idleMedianKb / 1024))} MiB (growth ${String(Math.round((recoveryMedianKb - idleMedianKb) / 1024))} MiB over 120s idle)`)
    muxTask.destroy()
    await stopResident(residents.pop() as { supervisor: ReturnType<typeof spawn>; dataRoot: string })
  } catch (error) {
    note('mem-driver', false, error instanceof Error ? error.message : String(error))
  } finally {
    memLoop.server.close()
    memLoop.server.closeAllConnections()
  }

  // --- OpenSSH: real deployment, detached resident, tunnel-only client access. ---
  const sshd = await startFixtureSshd()
  const knownHosts = join(fixtureBase, 'known_hosts')
  const target = remoteTargetSchema.parse({ name: 'fixture-sshd', host: '127.0.0.1', port: sshd.port, user: process.env.USER, identity: sshd.identity })
  const remoteHome = `.gh-joint-${Date.now()}`
  const remoteAbsoluteHome = join(process.env.HOME ?? '.', remoteHome)
  try {
    const { execFile } = await import('node:child_process')
    const runLocal = (command: string, args: string[]): Promise<{ code: number; out: string; err: string }> =>
      new Promise((resolveRun) => {
        execFile(command, args, (error, stdout, stderr) => {
          resolveRun({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, out: stdout, err: stderr })
        })
      })
    const deployed = await deployRuntime(target, { archive, home: remoteHome, knownHosts, trustFingerprint: true })
    const remote = (script: string, timeoutMs = 30_000): Promise<string> => remoteCommand(target, knownHosts, script, timeoutMs)
    // The supervisor CLI only self-executes from the product layout `…/lib/index.js`.
    const supervisorDir = `$HOME/${remoteHome}/supervisor/lib`
    await remote(`mkdir -p ${supervisorDir}`)
    const scp = await runLocal('scp', ['-P', String(sshd.port), '-i', sshd.identity, '-o', 'BatchMode=yes',
      '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', supervisorCli,
      `${process.env.USER}@127.0.0.1:${remoteAbsoluteHome}/supervisor/lib/index.js`])
    if (scp.code !== 0) throw new Error(`supervisor upload failed: ${scp.err}`)
    const startScript = [
      `RH="$HOME/${remoteHome}"`,
      'mkdir -p "$RH/workspace" "$RH/data" "$RH/log"',
      `nohup env DSH_HOME="$RH/home" GLM_API_KEY=synthetic-joint-key GLM_BASE_URL=http://127.0.0.1:${port}`
        + ' GH_PERMISSION_MODE=yolo "$RH/current/bin/node" "$RH/supervisor/lib/index.js" --root "$RH/data" run --'
        + ' "$RH/current/bin/node" "$RH/current/runtime/lib/bin.js" --profile gh-remote --no-open --host 127.0.0.1 --port 0'
        + ' >> "$RH/log/supervisor.log" 2>&1 &',
      'echo spawned',
    ].join('\n')
    await remote(startScript)
    const identityFile = `$HOME/${remoteHome}/data/run/service.json`
    let sshIdentity: Identity | null = null
    for (let attempt = 0; attempt < 300 && sshIdentity === null; attempt += 1) {
      const raw = await remote(`cat ${identityFile} 2>/dev/null || true`).catch(() => '')
      try {
        const parsed = JSON.parse(raw.trim()) as { pid?: unknown; readyUrl?: unknown }
        if (typeof parsed.pid === 'number' && parsed.pid > 0 && typeof parsed.readyUrl === 'string') {
          sshIdentity = { pid: parsed.pid, readyUrl: parsed.readyUrl, restarts: 0 }
        }
      } catch { /* not yet */ }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
    }
    if (sshIdentity === null || sshIdentity.readyUrl === null) {
      const diagnostics = await remote(`tail -5 "$HOME/${remoteHome}/log/supervisor.log" 2>/dev/null; echo ---; pgrep -af "supervisor/lib/index.js" || echo no-process`, 15_000).catch(() => 'n/a')
      throw new Error(`remote identity never became ready: ${diagnostics.trim().slice(0, 500)}`)
    }
    const remotePort = Number(new URL(sshIdentity.readyUrl).port)
    const token = new URL(sshIdentity.readyUrl).searchParams.get('token') ?? ''

    const openTunnel = async (): Promise<{ child: ReturnType<typeof spawn>; localPort: number }> => {
      const server = createServer()
      await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', () => { resolveListen() }) })
      const localPort = (server.address() as { port: number }).port
      server.close()
      const child = spawn('ssh', [...sshArguments(target), '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-N',
        '-L', `${String(localPort)}:127.0.0.1:${String(remotePort)}`], { stdio: 'ignore' })
      const tunnelUrl = `http://127.0.0.1:${String(localPort)}/?token=${token}`
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const probe = await fetch(tunnelUrl, { redirect: 'manual' }).then(response => response.status).catch(() => -1)
        if (probe > 0) break
        await new Promise(resolveSleep => setTimeout(resolveSleep, 200))
      }
      return { child, localPort }
    }
    const first = await openTunnel()
    const tunnelUrl = `http://127.0.0.1:${String(first.localPort)}/?token=${token}`
    const client = await connect(`http://127.0.0.1:${String(first.localPort)}`, tunnelUrl)
    const remoteWorkspace = `${remoteAbsoluteHome}/workspace`
    const session = ((await invoke(client, 'session/create', { request: { cwd: remoteWorkspace } })) as { sessionId: string }).sessionId
    const proofPath = `${remoteWorkspace}/openssh-proof.txt`
    const request = `openssh-${Date.now()}`
    await invoke(client, 'session/prompt', {
      request: { requestId: request, sessionId: session, mode: 'queue',
        content: [{ type: 'text', text: `WRITE-FILE ${proofPath} then finish the long turn over the tunnel` }] },
    })
    const observer = await connect(`http://127.0.0.1:${String(first.localPort)}`, tunnelUrl)
    const muxA = await MuxClient.open(`http://127.0.0.1:${String(first.localPort)}`, observer.cookie)
    await pollSnapshot(muxA, session, records => hasEvent(records, 'turn/start'), 15_000)
    // The real OpenSSH connection dies mid-turn: kill the tunnel process.
    first.child.kill('SIGKILL')
    await once(first.child, 'exit')
    muxA.destroy()
    const second = await openTunnel()
    const secondUrl = `http://127.0.0.1:${String(second.localPort)}/?token=${token}`
    const reconnected = await connect(`http://127.0.0.1:${String(second.localPort)}`, secondUrl)
    const muxB = await MuxClient.open(`http://127.0.0.1:${String(second.localPort)}`, reconnected.cookie)
    const finished = await pollSnapshot(muxB, session, records => hasEvent(records, 'turn/end'), 60_000)
    const endedCleanly = finished.some(record => record.event.type === 'turn/end'
      && !JSON.stringify(record.event.data).includes('"kind":"error"'))
    const identityAfter = JSON.parse(await remote(`cat ${identityFile}`)) as { pid: number }
    const proof = await remote(`cat ${remoteWorkspace}/openssh-proof.txt 2>/dev/null || echo MISSING`)
    const pidStable = identityAfter.pid === sshIdentity.pid
    note('openssh-disconnect-matrix',
      deployed.manifest.files > 0 && pidStable && endedCleanly && proof.trim() === 'GH joint matrix proof',
      `deployed over real OpenSSH (${deployed.manifest.files} files), service survived its starting session and the`
        + ` tunnel SIGKILL (pid ${String(sshIdentity.pid)} stable); a fresh tunnel observed the turn complete with the file written`)
    muxB.destroy()
    second.child.kill('SIGKILL')
    await remote(`"$HOME/${remoteHome}/current/bin/node" "$HOME/${remoteHome}/supervisor/lib/index.js" --root "$HOME/${remoteHome}/data" stop`, 60_000)
    const leftover = await remote(`cat ${identityFile} 2>/dev/null || echo gone`)
    const cleaned = leftover.trim() === 'gone'
    note('openssh-stop-cleans-remote-root', cleaned, `remote stop cleared the identity (${leftover.trim().slice(0, 40)})`)
  } catch (error) {
    note('openssh-driver', false, error instanceof Error ? error.message : String(error))
  } finally {
    await bootstrapLifecycle(target, knownHosts, remoteHome, 'stop', ['--timeout', '5'], 30_000).catch(() => undefined)
    await remoteCommand(target, knownHosts, `rm -rf "$HOME/${remoteHome}"`, 60_000).catch(() => undefined)
    await sshd.stop().catch(() => undefined)
  }

  boundaries.push(
    'machine reboot NOT simulated: it needs the physical host or container privileges this environment lacks (docker socket permission denied);'
    + ' user-service restart IS real (systemctl --user over a transient unit)',
    'desktop-exit is exercised as a full standalone client-process SIGKILL over the same HTTP/WS transport;'
    + ' a real Electron desktop exiting against the resident service arrives with the desktop remote-connection UI (GH-012)',
    'MEM03/04 carry no same-carrier ZCode Server baseline on this machine: absolute values are reported against the plan budgets instead',
    'long-term recovery is measured as post-task idle over 120s; session idle dispose and cache budgets are GH-009 work',
  )

  for (const resident of residents) await stopResident(resident)
  loopback.server.close()
  loopback.server.closeAllConnections()
  await rm(fixtureBase, { recursive: true, force: true }).catch(() => undefined)

  if (values.report !== undefined) {
    const summary = {
      scope: 'GH-006-F joint matrix over the real resident gh-remote service under the real supervisor CLI;'
        + ' real fixture OpenSSH deployment with tunnel-only client access, real systemctl --user restart,'
        + ' loopback GLM fixtures, synthetic credentials; whole-tree /proc smaps_rollup memory sampling',
      cases,
      boundaries,
      passed: cases.length > 0 && cases.every(entry => entry.passed),
    }
    await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify({ passed: summary.passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
  }
  process.exit(cases.length > 0 && cases.every(entry => entry.passed) ? 0 : 1)
}

if (import.meta.main) await main()
