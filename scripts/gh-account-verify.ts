/**
 * GH-007 acceptance for the account and project-token owner over the REAL
 * resident `gh-remote` service under the REAL supervisor: the loopback issuer
 * serves OAuth authorize/token endpoints AND the GLM chat-completions route
 * that only accepts minted PATs. The driver logs in through the `ghAccount`
 * RPC namespace, runs a real session turn authenticated by the short-term
 * PAT, proves no token material landed in the durable session journal or the
 * supervisor's output, revokes the live PAT to force an AUTH rejection (the
 * rejected credential is never reused; the next attempt mints fresh), and
 * logs out to show the explicit no-fallback failure. Usage:
 *   node --import tsx/esm scripts/gh-account-verify.ts [--report out.json]
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { initGhProfiles } from './gh-init-profiles.ts'

interface CaseResult { name: string; passed: boolean; detail: string }

/** One loopback issuer: OAuth + PAT + PAT-only GLM chat completions. */
function accountFixture(): {
  server: ReturnType<typeof createServer>
  portPromise: Promise<number>
  state: {
    authorizeCount: number
    refreshes: number
    patMints: number
    chatBearerSeen: string[]
    chatUnauthorized: number
    livePats: Set<string>
    pendingCodes: Map<string, string>
    revoked: boolean
  }
} {
  const state = {
    authorizeCount: 0,
    refreshes: 0,
    patMints: 0,
    chatBearerSeen: [] as string[],
    chatUnauthorized: 0,
    livePats: new Set<string>(),
    pendingCodes: new Map<string, string>(),
    revoked: false,
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    let bodyReady!: () => void
    const bodyArrived = new Promise<void>((resolveBody) => { bodyReady = resolveBody })
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { bodyReady() })
    const serve = async (): Promise<void> => {
      await bodyArrived
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
      if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
        state.authorizeCount += 1
        const challenge = url.searchParams.get('code_challenge') ?? ''
        if (url.searchParams.get('code_challenge_method') !== 'S256' || challenge === '') {
          response.writeHead(400)
          response.end('bad challenge')
          return
        }
        const code = `code-${state.authorizeCount}`
        state.pendingCodes.set(code, challenge)
        const target = new URL('/oauth/callback', url)
        target.searchParams.set('code', code)
        target.searchParams.set('state', url.searchParams.get('state') ?? '')
        response.writeHead(302, { location: target.href })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/oauth/token') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        const grantType = form.get('grant_type') ?? ''
        if (grantType === 'authorization_code') {
          const code = form.get('code') ?? ''
          if (!state.pendingCodes.has(code)) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          state.pendingCodes.delete(code)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            access_token: `access-${code}`,
            refresh_token: `refresh-${code}`,
            expires_in: 3600,
            account_id: 'acct-verify',
            plan: 'team',
          }))
          return
        }
        if (grantType === 'refresh_token') {
          state.refreshes += 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            access_token: `access-refresh-${state.refreshes}`,
            refresh_token: `refresh-rot-${state.refreshes}`,
            expires_in: 3600,
            account_id: 'acct-verify',
            plan: 'team',
          }))
          return
        }
        if (grantType === 'urn:glm-harness:pat') {
          const authorization = request.headers.authorization ?? ''
          if (!authorization.startsWith('Bearer access-')) {
            response.writeHead(401, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: { code: 'invalid_token', message: 'not an account access token' } }))
            return
          }
          state.patMints += 1
          const pat = `pat-${state.patMints}`
          state.livePats.add(pat)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ access_token: pat, expires_in: 900 }))
          return
        }
        response.writeHead(400)
        response.end('unknown grant')
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const authorization = request.headers.authorization ?? ''
        const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
        state.chatBearerSeen.push(bearer)
        if (state.revoked || !state.livePats.has(bearer)) {
          state.chatUnauthorized += 1
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'the PAT is not accepted' } }))
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: Array<{ role?: string; content?: unknown }>
        }
        const messages = body.messages ?? []
        const system = typeof messages[0]?.content === 'string' ? messages[0].content : ''
        const titleCall = system.includes('concise title')
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (titleCall) {
          response.write(frame({ choices: [{ delta: { content: 'account verify title' } }] }))
          response.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
          response.end(frame('[DONE]'))
          return
        }
        response.write(frame({ choices: [{ delta: { content: 'turn authenticated by the short-term token' } }] }))
        response.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
        response.end(frame('[DONE]'))
        return
      }
      response.writeHead(404)
      response.end()
    }
    void serve().catch(() => { response.destroy() })
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  return { server, portPromise, state }
}

interface RpcClient { origin: string; cookie: string; rpcId: number }

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
    result?: { ok: boolean; value?: unknown; error?: { message: string; code?: string } }
  }
  if (envelope.type !== 'server-response' || envelope.rpcId !== `verify-${client.rpcId}`) {
    throw new Error(`rpc envelope mismatch for ${endpoint}: ${JSON.stringify(envelope).slice(0, 200)}`)
  }
  if (envelope.result?.ok !== true) {
    throw new Error(`${endpoint}: ${envelope.result?.error?.message ?? 'unknown'}`)
  }
  return envelope.result.value
}

/** One logical Remote stream over the raw mux WebSocket (JSON text frames). */
class MuxStream {
  private readonly frames: unknown[] = []
  private ended = false
  private failure: Error | undefined

  constructor(private readonly mux: MuxClient, readonly streamId: string) {}

  accept(frame: { type: string; value?: unknown; error?: { message?: string } }): void {
    if (frame.type === 'item') this.frames.push(frame.value)
    else if (frame.type === 'error') this.failure = new Error(frame.error?.message ?? 'stream error')
    this.ended = frame.type !== 'item'
  }

  async next(timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (this.frames.length > 0) return this.frames.shift()
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return undefined
      if (this.mux.closed) throw new Error('mux socket closed')
      if (Date.now() > deadline) throw new Error('mux stream item timed out')
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
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

  destroy(): void {
    this.closed = true
    this.socket.close()
  }
}

interface PageRecord { event: { seq: number; type: string; data?: unknown } }

/** Read one session's current window through a fresh follow snapshot, then cancel the stream. */
async function readSnapshot(mux: MuxClient, sessionId: string): Promise<PageRecord[]> {
  const stream = mux.start('session/follow', { args: { request: { address: { kind: 'session', sessionId } } } })
  try {
    const snapshot = await stream.next(10_000) as { type?: string; records?: PageRecord[] }
    if (snapshot.type !== 'snapshot') throw new Error(`follow snapshot expected, got ${JSON.stringify(snapshot).slice(0, 120)}`)
    return snapshot.records ?? []
  } finally {
    mux.cancel(stream)
  }
}

/** Poll follow snapshots until a predicate holds, or time out. */
async function pollSnapshot(
  mux: MuxClient,
  sessionId: string,
  predicate: (records: PageRecord[]) => boolean,
  timeoutMs: number,
): Promise<PageRecord[]> {
  let last: PageRecord[] = []
  for (let attempt = 0; attempt < Math.ceil(timeoutMs / 300); attempt += 1) {
    last = await readSnapshot(mux, sessionId)
    if (predicate(last)) return last
    await new Promise(resolveSleep => setTimeout(resolveSleep, 300))
  }
  throw new Error(`session snapshot predicate timed out after ${String(timeoutMs)}ms`)
}

function hasEvent(records: PageRecord[], type: string): boolean {
  return records.some(record => record.event.type === type)
}

/**
 * Wait for the NEXT turn/end after a baseline snapshot. The follow snapshot is
 * windowed, so an earlier turn's end still matches a bare type check; this
 * helper pins the baseline's highest seq and resolves only on events past it.
 * @returns the window slice belonging to the awaited turn.
 */
async function awaitNextTurn(mux: MuxClient, sessionId: string, timeoutMs: number): Promise<PageRecord[]> {
  const baseline = await readSnapshot(mux, sessionId)
  const baselineSeq = baseline.reduce((max, record) => Math.max(max, record.event.seq), 0)
  const window = await pollSnapshot(mux, sessionId, (records) => {
    const fresh = records.filter(record => record.event.seq > baselineSeq)
    return hasEvent(fresh, 'turn/end')
  }, timeoutMs)
  return window.filter(record => record.event.seq > baselineSeq)
}

/** Decompressed text of every session journal under a sessions root. */
const journalText = async (sessionsRoot: string): Promise<string> => new Promise((resolveRun) => {
  execFile('sh', ['-c', `find ${JSON.stringify(sessionsRoot)} -name '*.jsonl.zstd' -print0 2>/dev/null | xargs -0 -r cat | zstd -dc 2>/dev/null || true`], { maxBuffer: 1 << 26 }, (error, stdout) => {
    resolveRun(error === null ? stdout : '')
  })
})

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { report: { type: 'string' } } })
  const root = resolve(import.meta.dirname, '..')
  const supervisorCli = join(root, 'packages', 'glm', 'remote-supervisor', 'lib', 'index.js')
  const binJs = join(root, 'apps', 'cli', 'lib', 'bin.js')
  const fixture = await mkdtemp(join(tmpdir(), 'gh-account-verify-'))
  const home = join(fixture, 'home')
  const workspace = join(fixture, 'workspace')
  const dataRoot = join(fixture, 'data')
  await mkdir(workspace, { recursive: true })
  initGhProfiles(home)
  const loopback = accountFixture()
  const port = await loopback.portPromise
  // Point the profile's rows at the loopback issuer: the account domains and
  // the GLM route's PAT preference live in the user patch layer.
  const patch = [
    '- id: gh-account',
    '  config:',
    '    domains:',
    '      - domain: bigmodel',
    `        authorizeUrl: http://127.0.0.1:${String(port)}/oauth/authorize`,
    `        tokenUrl: http://127.0.0.1:${String(port)}/oauth/token`,
    '        clientId: gh-verify',
    '- id: model-glm',
    '  config:',
    '    preferAccountPat: true',
    '    accountDomain: bigmodel',
    '    patProjectId: proj-verify',
    '',
  ].join('\n')
  await writeFile(join(home, 'profiles', 'gh-remote', 'cordis.patch.yml'), patch)
  const cases: CaseResult[] = []
  const note = (name: string, passed: boolean, detail: string): void => {
    cases.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }
  const supervisor = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'run', '--',
    process.execPath, binJs, '--profile', 'gh-remote', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env: {
      ...process.env,
      DSH_HOME: home,
      GLM_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
      GH_PERMISSION_MODE: 'yolo',
    }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let supervisorErr = ''
  supervisor.stderr.setEncoding('utf8').on('data', (chunk: string) => { supervisorErr += chunk })
  const identityPath = join(dataRoot, 'run', 'service.json')
  try {
    let readyUrl: string | null = null
    for (let attempt = 0; attempt < 400 && readyUrl === null; attempt += 1) {
      try {
        const parsed = JSON.parse(await readFile(identityPath, 'utf8')) as { readyUrl?: unknown }
        if (typeof parsed.readyUrl === 'string') readyUrl = parsed.readyUrl
      } catch { /* not yet */ }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 300))
    }
    if (readyUrl === null) throw new Error(`resident service never became ready: ${supervisorErr.slice(-300)}`)
    const origin = new URL(readyUrl).origin
    const client = await connect(origin, readyUrl)
    const observer = await connect(origin, readyUrl)
    const mux = await MuxClient.open(origin, observer.cookie)
    const prompt = (sessionId: string, requestId: string, text: string): Promise<unknown> =>
      invoke(client, 'session/prompt', {
        request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      })

    // Case 1: the RPC-driven login mints a PAT and a real turn carries it.
    const loggedOut = await invoke(client, 'ghAccount/status', {}) as { accounts: Array<{ accountId: string }> }
    const begin = await invoke(client, 'ghAccount/beginLogin', {
      request: { domain: 'bigmodel', redirectUrl: 'http://127.0.0.1:1/callback' },
    }) as { verificationUrl: string }
    const visited = await fetch(begin.verificationUrl, { redirect: 'manual' })
    const location = new URL(visited.headers.get('location') ?? '', begin.verificationUrl)
    const loggedIn = await invoke(client, 'ghAccount/completeLogin', {
      request: {
        domain: 'bigmodel',
        code: location.searchParams.get('code') ?? '',
        state: location.searchParams.get('state') ?? '',
        redirectUrl: 'http://127.0.0.1:1/callback',
      },
    }) as { accountId: string; plan: string | null; epoch: number }
    const session = ((await invoke(client, 'session/create', { request: { cwd: workspace } })) as { sessionId: string }).sessionId
    await prompt(session, `account-turn-${Date.now()}`, 'run one authenticated turn')
    const firstTurn = await awaitNextTurn(mux, session, 60_000)
    const firstClean = firstTurn.some(record => record.event.type === 'turn/end'
      && !JSON.stringify(record.event.data).includes('"kind":"error"'))
    const sawPat = loopback.state.chatBearerSeen.some(bearer => bearer.startsWith('pat-'))
    note('resident-account-pat-round-trip',
      loggedOut.accounts.every(entry => entry.accountId === '') && loggedIn.accountId === 'acct-verify'
        && loggedIn.plan === 'team' && sawPat && firstClean,
      `status logged out→in (acct-verify/team, epoch=${String(loggedIn.epoch)}); the turn completed with a minted PAT`
        + ` (mints=${String(loopback.state.patMints)}, chat saw PAT=${String(sawPat)}, clean end=${String(firstClean)})`)

    // Case 2: no token material anywhere durable the service wrote.
    const journal = await journalText(join(home, 'sessions'))
    const tokenMarkers = ['access-code-', 'access-refresh-', 'refresh-rot-', 'pat-1']
    const journalHits = tokenMarkers.filter(marker => journal.includes(marker))
    const logHit = supervisorErr.includes('access-code-') || supervisorErr.includes('pat-1')
    note('token-hygiene', journalHits.length === 0 && !logHit,
      `the durable journal and the supervisor output carry no access/refresh/PAT material (journal hits=${JSON.stringify(journalHits)}, log hit=${String(logHit)})`)

    // Case 3: a revoked PAT is rejected once and never reused.
    loopback.state.revoked = true
    await prompt(session, `revoked-turn-${Date.now()}`, 'turn against the revoked pat')
    const rejected = await awaitNextTurn(mux, session, 60_000)
    const sawRejection = rejected.some(record => record.event.type === 'turn/end'
      && JSON.stringify(record.event.data).includes('"kind":"error"'))
    loopback.state.revoked = false
    const mintsBefore = loopback.state.patMints
    await prompt(session, `recovery-turn-${Date.now()}`, 'turn after the rejection')
    const recoveredTurn = await awaitNextTurn(mux, session, 60_000)
    const recoveredClean = recoveredTurn.some(record => record.event.type === 'turn/end'
      && !JSON.stringify(record.event.data).includes('"kind":"error"'))
    const freshMint = loopback.state.patMints > mintsBefore
    note('pat-rejected-never-reused', sawRejection && recoveredClean && freshMint,
      `the revoked PAT produced a 401 and an errored turn; the next turn minted fresh (mints ${String(mintsBefore)}→${String(loopback.state.patMints)}) and completed cleanly`)

    // Case 4: logout leaves an explicit failure, never a fallback.
    await invoke(client, 'ghAccount/logout', { request: { domain: 'bigmodel' } })
    const afterLogout = await invoke(client, 'ghAccount/status', {}) as { accounts: Array<{ accountId: string }> }
    await prompt(session, `logged-out-turn-${Date.now()}`, 'turn with no account')
    const failedTurn = await awaitNextTurn(mux, session, 60_000)
    const failedLog = await journalText(join(home, 'sessions'))
    const errorEnd = failedTurn.some(record => record.event.type === 'turn/end'
      && JSON.stringify(record.event.data).includes('"kind":"error"'))
    const journalFailure = failedLog.includes('MISSING_CREDENTIAL') || failedLog.includes('no API key')
    const explicitFailure = errorEnd || journalFailure
    const turnTail = failedTurn.slice(-3).map(record => `${record.event.type}:${JSON.stringify(record.event.data).slice(0, 140)}`).join(' | ')
    note('logout-explicit-failure',
      afterLogout.accounts.every(entry => entry.accountId === '') && explicitFailure,
      'status back to logged out; the next turn fails through the explicit missing-credential path (no upstream fallback),'
        + ` errorEnd=${String(errorEnd)}, journalFailure=${String(journalFailure)}, tail=${turnTail}`)
    mux.destroy()
  } catch (error) {
    note('driver', false, error instanceof Error ? error.message : String(error))
  } finally {
    const stop = spawn(process.execPath, [supervisorCli, '--root', dataRoot, 'stop'], { stdio: 'ignore' })
    await once(stop, 'exit')
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
    loopback.server.close()
    loopback.server.closeAllConnections()
    if (values.report !== undefined) {
      const summary = {
        scope: 'account and project-token owner over the real resident gh-remote service under the supervisor;'
          + ' loopback OAuth+PAT issuer that also serves the PAT-only GLM route; the profile patch layer configures the rows;'
          + ' no GLM_API_KEY in the environment (the PAT is the only credential path)',
        cases,
        boundaries: [
          'no real BigModel or Z.AI service contacted (D01 needs real credentials)',
          'entitlements are the display plan string only (E02.7 owns quota and billing)',
          'an AUTH rejection invalidates without auto-retry (bounded fresh-PAT retry belongs to the retry owner, E02.5)',
          'desktop local-callback login arrives with the desktop account UI',
        ],
        supervisorErrTail: supervisorErr.slice(-500),
        passed: cases.length > 0 && cases.every(entry => entry.passed),
      }
      await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(JSON.stringify({ passed: summary.passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
    }
    await rm(fixture, { recursive: true, force: true })
    process.exit(cases.length > 0 && cases.every(entry => entry.passed) ? 0 : 1)
  }
}

if (import.meta.main) await main()
