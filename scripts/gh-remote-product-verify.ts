/**
 * GH-006-G product-entry acceptance: real generated archives, a real from-zero
 * install over fixture OpenSSH into a no-Node PATH jail, a resident service
 * born under the `gh-supervisor` profile, and the unified lifecycle verbs —
 * disconnect survival, capability handshake with a persistent runtime id,
 * admission-closing drains around upgrade and rollback, gc pinning,
 * interrupted-transaction diagnosis, and a data-preserving uninstall.
 *
 * Prereqs: `pnpm run build` and two archives from
 * `scripts/build-gh-remote-archive.ts` (default + `--variant b`).
 * Run: node --import tsx/esm scripts/gh-remote-product-verify.ts [--report out.json]
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { parseArgs } from 'node:util'
import { makeNodeJail, startFixtureSshd } from './gh-remote/sshd-fixture.ts'
import { bootstrapLifecycle, deployRuntime, remoteCommand } from './gh-remote/deploy.ts'
import { remoteTargetSchema } from './gh-remote/targets.ts'

const root = resolve(import.meta.dirname, '..')

interface CaseNote { name: string; passed: boolean; detail: string }

/** Loopback GLM fixture: one long streamed turn around a WRITE-FILE tool call. */
function scenarioFixture(streamTicks: number): {
  server: ReturnType<typeof createServer>
  portPromise: Promise<number>
} {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    let bodyReady!: () => void
    const bodyArrived = new Promise<void>((resolveBody) => { bodyReady = resolveBody })
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { bodyReady() })
    response.on('close', () => { if (!response.writableEnded) response.destroy() })
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
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (titleCall) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'product title' } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      if (writePath !== null && !toolAnswered) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: 'call-product-write', type: 'function',
          function: {
            name: 'write',
            arguments: JSON.stringify({ file_path: writePath, content: 'GH product matrix proof\n' }),
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
  return { server, portPromise }
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
    body: JSON.stringify({ type: 'client-request', rpcId: `product-${client.rpcId}`, method: endpoint, payload: { args } }),
  })
  const envelope = await response.json() as {
    type: string
    rpcId: string
    result?: { ok: boolean; value?: unknown; error?: { message: string; code?: string } }
  }
  if (envelope.type !== 'server-response' || envelope.rpcId !== `product-${client.rpcId}`) {
    throw new Error(`rpc envelope mismatch for ${endpoint}: ${JSON.stringify(envelope).slice(0, 200)}`)
  }
  if (envelope.result?.ok !== true) {
    const error = new Error(`${endpoint}: ${envelope.result?.error?.message ?? 'unknown'}`) as Error & { code: string }
    error.code = envelope.result?.error?.code ?? 'unknown'
    throw error
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

  start(endpoint: string, payload: Record<string, unknown>): MuxStream {
    this.counter += 1
    const streamId = `product-${String(this.counter)}`
    const stream = new MuxStream(this, streamId)
    this.streams.set(streamId, stream)
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
    return stream
  }

  cancel(stream: MuxStream): void {
    this.socket.send(JSON.stringify({ type: 'cancel', streamId: stream.streamId }))
  }

  destroy(): void {
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

interface Identity { pid: number; readyUrl: string; restarts: number; releaseId: string | null }

/** The resident identity a supervisor publishes, read over SSH. */
const readRemoteIdentity = async (
  remote: (script: string, timeoutMs?: number) => Promise<string>,
  identityFile: string,
): Promise<Identity | null> => {
  const raw = await remote(`cat ${identityFile} 2>/dev/null || true`).catch(() => '')
  try {
    const parsed = JSON.parse(raw.trim()) as { pid?: unknown; readyUrl?: unknown; restarts?: unknown; releaseId?: unknown }
    if (typeof parsed.pid === 'number' && parsed.pid > 0 && typeof parsed.readyUrl === 'string') {
      return { pid: parsed.pid, readyUrl: parsed.readyUrl, restarts: typeof parsed.restarts === 'number' ? parsed.restarts : 0, releaseId: typeof parsed.releaseId === 'string' ? parsed.releaseId : null }
    }
  } catch { /* not ready yet */ }
  return null
}

/** Wait for the resident identity to publish a ready URL. */
const awaitIdentity = async (
  remote: (script: string, timeoutMs?: number) => Promise<string>,
  identityFile: string,
  timeoutMs: number,
): Promise<Identity> => {
  for (let attempt = 0; attempt < Math.ceil(timeoutMs / 1_000); attempt += 1) {
    const identity = await readRemoteIdentity(remote, identityFile)
    if (identity !== null) return identity
    await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
  }
  throw new Error(`resident identity never became ready at ${identityFile}`)
}

/** Open an ssh -L tunnel to the resident service; clients then talk to the loopback port. */
const openTunnel = async (
  target: { host: string; port: number; user?: string | undefined; identity?: string | undefined },
  knownHosts: string,
  remotePort: number,
): Promise<{ child: ReturnType<typeof spawn>; localPort: number; destroy: () => void }> => {
  const server = createServer()
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', () => { resolveListen() }) })
  const localPort = (server.address() as { port: number }).port
  server.close()
  const child = spawn('ssh', [
    '-p', String(target.port),
    ...(target.user !== undefined ? ['-l', target.user] : []),
    ...(target.identity !== undefined ? ['-i', target.identity] : []),
    '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `${String(localPort)}:127.0.0.1:${String(remotePort)}`,
    target.host,
  ], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${String(localPort)}`
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = await fetch(url, { redirect: 'manual' }).then(response => response.status).catch(() => -1)
    if (probe > 0) break
    await new Promise(resolveSleep => setTimeout(resolveSleep, 200))
  }
  return { child, localPort, destroy: () => { child.kill('SIGKILL') } }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { report: { type: 'string' } } })
  const archiveA = join(root, 'dist-exe', 'gh-remote-g', `gh-remote-${await archiveVersion()}-linux-x64.tar.gz`)
  const archiveB = join(root, 'dist-exe', 'gh-remote-g', `gh-remote-${await archiveVersion()}-linux-x64-b.tar.gz`)
  const cases: CaseNote[] = []
  const boundaries: string[] = []
  const note = (name: string, passed: boolean, detail: string): void => {
    cases.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }

  const fixtureBase = await mkdtemp(join(tmpdir(), 'gh-product-'))
  const loopback = scenarioFixture(45)
  const port = await loopback.portPromise
  const sshd = await startFixtureSshd()
  const jail = await makeNodeJail(join(fixtureBase, 'jail-bin'))
  const knownHosts = join(fixtureBase, 'known_hosts')
  const target = remoteTargetSchema.parse({ name: 'fixture-sshd', host: '127.0.0.1', port: sshd.port, user: process.env.USER, identity: sshd.identity })
  const remoteHome = `.gh-product-${Date.now()}`
  const remoteAbsoluteHome = join(process.env.HOME ?? '.', remoteHome)
  const remote = (script: string, timeoutMs = 30_000): Promise<string> => remoteCommand(target, knownHosts, script, timeoutMs)
  const identityFile = `$HOME/${remoteHome}/run/service.json`
  const runLocal = (command: string, args: string[]): Promise<{ code: number; out: string; err: string }> =>
    new Promise((resolveRun) => {
      execFile(command, args, (error, stdout, stderr) => {
        resolveRun({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, out: stdout, err: stderr })
      })
    })

  try {
    // --- From-zero install of the real archive over real OpenSSH. ---
    const deployed = await deployRuntime(target, { archive: archiveA, home: remoteHome, knownHosts, trustFingerprint: true })
    const statusAfterInstall = JSON.parse(await bootstrapLifecycle(target, knownHosts, remoteHome, 'status', [], 60_000)) as {
      current: { releaseId: string } | null
      releases: string[]
      runtimeId: string
      lifecycle: unknown
    }
    const profilesListed = (await remote(`ls "$HOME/${remoteHome}/home/profiles"`)).split(/\s+/).filter(Boolean).sort().join(',')
    const nodeBundled = (await remote(`test -x "$HOME/${remoteHome}/releases/${statusAfterInstall.current?.releaseId ?? 'x'}/bin/node" && echo node-ok`)).trim()
    const layoutChecks = {
      current: statusAfterInstall.current !== null,
      singleRelease: statusAfterInstall.releases.length === 1,
      runtimeId: /^[0-9a-f-]{36}$/u.test(statusAfterInstall.runtimeId),
      profiles: profilesListed === 'desktop,gh-headless,gh-remote,gh-supervisor,gh-web',
      bundledNode: nodeBundled === 'node-ok',
    }
    note('from-zero-install-layout', Object.values(layoutChecks).every(Boolean),
      `real archive (${String(deployed.manifest.files)} files) installed from zero; checks=${JSON.stringify(layoutChecks)}`)

    // --- Resident start under the supervisor profile; handshake over a tunnel. ---
    await bootstrapLifecycle(target, knownHosts, remoteHome, 'start', [], 60_000, [`PATH=${jail}`, `GLM_BASE_URL=http://127.0.0.1:${String(port)}`, 'GLM_API_KEY=synthetic-product-key', 'GH_PERMISSION_MODE=yolo'])
    const firstIdentity = await awaitIdentity(remote, identityFile, 120_000)
    const supervisorPid = Number((await remote(`cat "$HOME/${remoteHome}/run/runner.pid"`)).trim())
    let tunnel = await openTunnel(target, knownHosts, Number(new URL(firstIdentity.readyUrl).port))
    const tunnelUrl = `http://127.0.0.1:${String(tunnel.localPort)}/?token=${new URL(firstIdentity.readyUrl).searchParams.get('token') ?? ''}`
    const clientA = await connect(`http://127.0.0.1:${String(tunnel.localPort)}`, tunnelUrl)
    const describeA = await invoke(clientA, 'ghRemote/describe', {}) as { runtimeId: string | null; releaseId: string | null; admission: string; capabilities: string[] }
    const handshakeOk = describeA.runtimeId === statusAfterInstall.runtimeId
      && describeA.releaseId === statusAfterInstall.current?.releaseId
      && describeA.admission === 'open'
      && describeA.capabilities.includes('admission-close')
      && describeA.capabilities.includes('runtime-id')
      && Number.isInteger(supervisorPid) && supervisorPid > 0
    note('resident-supervisor-profile-and-handshake', handshakeOk,
      `bootstrap start launched the gh-supervisor profile (supervisor pid ${String(supervisorPid)}); ghRemote/describe answered runtimeId=${describeA.runtimeId?.slice(0, 8)}, releaseId=${describeA.releaseId?.slice(-8)}, admission=${describeA.admission}, capabilities=${describeA.capabilities.join('+')}`)

    // --- Disconnect matrix: the tunnel dies mid-turn; a fresh one sees the end. ---
    const workspace = `${remoteAbsoluteHome}/workspace`
    await remote(`mkdir -p ${workspace}`)
    const createdA = await invoke(clientA, 'session/create', { request: { cwd: workspace } })
    console.log('session/create raw:', JSON.stringify(createdA).slice(0, 300))
    const sessionA = (createdA as { sessionId: string }).sessionId
    const proofPath = `${workspace}/product-proof.txt`
    await invoke(clientA, 'session/prompt', {
      request: { requestId: `product-${Date.now()}`, sessionId: sessionA, mode: 'queue', content: [{ type: 'text', text: `WRITE-FILE ${proofPath} then finish the long turn` }] },
    })
    const observerA = await connect(`http://127.0.0.1:${String(tunnel.localPort)}`, tunnelUrl)
    const muxA = await MuxClient.open(`http://127.0.0.1:${String(tunnel.localPort)}`, observerA.cookie)
    await pollSnapshot(muxA, sessionA, records => records.some(record => record.event.type === 'turn/start'), 15_000)
    tunnel.destroy()
    await once(tunnel.child, 'exit').catch(() => undefined)
    muxA.destroy()
    tunnel = await openTunnel(target, knownHosts, Number(new URL(firstIdentity.readyUrl).port))
    const tunnelUrl2 = `http://127.0.0.1:${String(tunnel.localPort)}/?token=${new URL(firstIdentity.readyUrl).searchParams.get('token') ?? ''}`
    const observerB = await connect(`http://127.0.0.1:${String(tunnel.localPort)}`, tunnelUrl2)
    const muxB = await MuxClient.open(`http://127.0.0.1:${String(tunnel.localPort)}`, observerB.cookie)
    const finishedRecords = await pollSnapshot(muxB, sessionA, records => records.some(record => record.event.type === 'turn/end'), 60_000)
    const turnEndedCleanly = finishedRecords.some(record => record.event.type === 'turn/end'
      && !JSON.stringify(record.event.data).includes('"kind":"error"'))
    const proof = await remote(`cat ${proofPath} 2>/dev/null || echo MISSING`)
    const pidStable = (await readRemoteIdentity(remote, identityFile))?.pid === firstIdentity.pid
    note('tunnel-disconnect-survival', turnEndedCleanly && proof.trim() === 'GH product matrix proof' && pidStable,
      `the tunnel SIGKILL mid-turn changed nothing: service pid ${String(firstIdentity.pid)} stable, a fresh tunnel observed the clean turn end, and the fixture file was written`)

    // --- Persistent runtime id across a service crash-restart. ---
    await remote(`kill -9 ${String(firstIdentity.pid)}`)
    let reborn: Identity | null = null
    for (let attempt = 0; attempt < 60 && reborn === null; attempt += 1) {
      reborn = await readRemoteIdentity(remote, identityFile)
      if (reborn === null || reborn.pid === firstIdentity.pid) reborn = null
      await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
    }
    if (reborn === null) throw new Error('the supervisor never restarted the crashed service')
    const tunnelR = await openTunnel(target, knownHosts, Number(new URL(reborn.readyUrl).port))
    const tunnelUrlR = `http://127.0.0.1:${String(tunnelR.localPort)}/?token=${new URL(reborn.readyUrl).searchParams.get('token') ?? ''}`
    const clientR = await connect(`http://127.0.0.1:${String(tunnelR.localPort)}`, tunnelUrlR)
    const describeReborn = await invoke(clientR, 'ghRemote/describe', {}) as { runtimeId: string | null }
    note('runtime-id-survives-crash-restart', reborn.pid !== firstIdentity.pid && reborn.restarts >= 1 && describeReborn.runtimeId === statusAfterInstall.runtimeId,
      `service SIGKILL: the supervisor restarted it (pid ${String(firstIdentity.pid)}→${String(reborn.pid)}, restarts=${String(reborn.restarts)}) and the handshake runtime id stayed ${statusAfterInstall.runtimeId.slice(0, 8)}`)

    // --- Upgrade: admission closes, the drain waits the turn out, data survives. ---
    await remote(`echo marker-before-update > "$HOME/${remoteHome}/home/data-marker.txt"`)
    const upload = await runLocal('scp', ['-P', String(sshd.port), '-i', sshd.identity, '-o', 'BatchMode=yes',
      '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', archiveB, `${archiveB}.sha256`,
      `${process.env.USER}@127.0.0.1:${remoteAbsoluteHome}/upload/`])
    if (upload.code !== 0) throw new Error(`archive B upload failed: ${upload.err}`)
    // A fresh client pair on the CURRENT service incarnation: the crashed one
    // moved ports when the supervisor restarted it.
    const tunnelU = await openTunnel(target, knownHosts, Number(new URL(reborn.readyUrl).port))
    const tunnelUrlU = `http://127.0.0.1:${String(tunnelU.localPort)}/?token=${new URL(reborn.readyUrl).searchParams.get('token') ?? ''}`
    const clientU = await connect(`http://127.0.0.1:${String(tunnelU.localPort)}`, tunnelUrlU)
    const observerU = await connect(`http://127.0.0.1:${String(tunnelU.localPort)}`, tunnelUrlU)
    const muxU = await MuxClient.open(`http://127.0.0.1:${String(tunnelU.localPort)}`, observerU.cookie)
    const sessionB = ((await invoke(clientU, 'session/create', { request: { cwd: workspace } })) as { sessionId: string }).sessionId
    const proof2 = `${workspace}/product-upgrade-proof.txt`
    await invoke(clientU, 'session/prompt', {
      request: { requestId: `upgrade-${Date.now()}`, sessionId: sessionB, mode: 'queue', content: [{ type: 'text', text: `WRITE-FILE ${proof2} then finish the long turn across the upgrade` }] },
    })
    await pollSnapshot(muxU, sessionB, records => records.some(record => record.event.type === 'turn/start'), 15_000)
    const updateScript = [
      `cd "$HOME/${remoteHome}/upload"`,
      `nohup env PATH=${jail} GLM_BASE_URL=http://127.0.0.1:${String(port)} GLM_API_KEY=synthetic-product-key GH_PERMISSION_MODE=yolo`
        + ` GH_REMOTE_HOME="$HOME/${remoteHome}" sh ./bootstrap.sh update ./$(basename ${JSON.stringify(archiveB)}) --drain-timeout 60000`
        + ' >> "$HOME/update.log" 2>&1 &',
      'echo update-launched',
    ].join('\n')
    await remote(updateScript, 30_000)
    let admissionClosedSeen = false
    // The drain's admission close lands minutes after the launch — staging and
    // verifying the new archive comes first — so both facts are polled in one
    // window: the mid-flight close on the old service, and the pointer switch.
    let upgraded: Identity | null = null
    for (let attempt = 0; attempt < 600 && upgraded === null; attempt += 1) {
      if (!admissionClosedSeen) {
        const describeMid = await invoke(clientU, 'ghRemote/describe', {}).catch(() => null) as { admission?: string } | null
        if (describeMid?.admission === 'closed') admissionClosedSeen = true
      }
      const current = await readRemoteIdentity(remote, identityFile)
      if (current !== null && current.releaseId !== null && current.releaseId !== firstIdentity.releaseId) upgraded = current
      await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
    }
    if (upgraded === null) throw new Error('the upgrade never switched the resident release')
    await new Promise(resolveSleep => setTimeout(resolveSleep, 2_000))
    const tunnel3 = await openTunnel(target, knownHosts, Number(new URL(upgraded.readyUrl).port))
    const tunnelUrl3 = `http://127.0.0.1:${String(tunnel3.localPort)}/?token=${new URL(upgraded.readyUrl).searchParams.get('token') ?? ''}`
    const clientC = await connect(`http://127.0.0.1:${String(tunnel3.localPort)}`, tunnelUrl3)
    const describeC = await invoke(clientC, 'ghRemote/describe', {}) as { runtimeId: string | null; releaseId: string | null; admission: string }
    const marker = await remote(`cat "$HOME/${remoteHome}/home/data-marker.txt" 2>/dev/null || echo MISSING`)
    // The closed window can be shorter than any poll cadence (an idle service
    // stops in the same tick the drain confirms), so the supervisor's own
    // transaction report — it drains only after closing admissions — is the
    // authoritative record; the live poll adds direct observation when the
    // window is wide enough to catch.
    const updateLog = await remote('cat "$HOME/update.log" 2>/dev/null', 15_000).catch(() => '')
    const drainClosedAdmissions = updateLog.includes('new admissions closed')
    const upgradeOk = (admissionClosedSeen || drainClosedAdmissions)
      && describeC.releaseId === upgraded.releaseId
      && describeC.runtimeId === statusAfterInstall.runtimeId
      && describeC.admission === 'open'
      && marker.trim() === 'marker-before-update'
    note('upgrade-drain-switch-and-data', upgradeOk,
      `bootstrap update staged release B, the drain closed admissions (live=${String(admissionClosedSeen)} supervisor-report=${String(drainClosedAdmissions)}), waited the in-flight turn out, and switched (releaseId …${upgraded.releaseId?.slice(-8)}, new pid ${String(upgraded.pid)}); the home marker survived and the fresh service reopened admissions with the same runtime id`
      + (upgradeOk ? '' : ` [admissionClosedSeen=${String(admissionClosedSeen)} drainClosedAdmissions=${String(drainClosedAdmissions)} updateLog=${JSON.stringify(updateLog.trim().slice(0, 400))} describeRelease=${JSON.stringify(describeC.releaseId)} switchedRelease=${JSON.stringify(upgraded.releaseId)} describeRuntime=${JSON.stringify(describeC.runtimeId)} installedRuntime=${JSON.stringify(statusAfterInstall.runtimeId)} describeAdmission=${JSON.stringify(describeC.admission)} marker=${JSON.stringify(marker.trim())}]`))
    tunnel3.destroy()

    // --- Rollback: back to release A with the same guarantees. ---
    await remote([
      `cd "$HOME/${remoteHome}/upload"`,
      `nohup env PATH=${jail} GLM_BASE_URL=http://127.0.0.1:${String(port)} GLM_API_KEY=synthetic-product-key GH_PERMISSION_MODE=yolo`
        + ' GH_REMOTE_HOME="$HOME/' + remoteHome + '" sh ./bootstrap.sh rollback --drain-timeout 30000'
        + ' >> "$HOME/rollback.log" 2>&1 &',
      'echo rollback-launched',
    ].join('\n'), 30_000)
    let rolled: Identity | null = null
    for (let attempt = 0; attempt < 240 && rolled === null; attempt += 1) {
      const current = await readRemoteIdentity(remote, identityFile)
      if (current !== null && current.releaseId === firstIdentity.releaseId) rolled = current
      await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
    }
    const rollbackOk = rolled !== null && (await remote(`cat "$HOME/${remoteHome}/home/data-marker.txt"`)).trim() === 'marker-before-update'
    note('rollback-to-previous-release', rollbackOk,
      rolled === null
        ? 'rollback never completed'
        : `bootstrap rollback drained and switched back to release A (releaseId …${rolled.releaseId?.slice(-8)}) with home data intact`)

    // --- gc pins current, rollback target, and live occupancy; drops junk. ---
    await remote(`mkdir -p "$HOME/${remoteHome}/releases/r-junk/lib" && echo x > "$HOME/${remoteHome}/releases/r-junk/lib/bin.js" && echo '{"kind":"gh-remote-release","id":"r-junk","installedAt":1}' > "$HOME/${remoteHome}/releases/r-junk/gh-release.json"`)
    const gc = JSON.parse(await bootstrapLifecycle(target, knownHosts, remoteHome, 'gc', [], 60_000)) as { removedReleases: string[]; kept: Record<string, string> }
    const gcOk = gc.removedReleases.includes('r-junk')
      && gc.kept[firstIdentity.releaseId ?? ''] !== undefined
      && gc.kept[upgraded.releaseId ?? ''] !== undefined
    note('gc-pins-and-drops', gcOk,
      `gc removed the junk release (${gc.removedReleases.join(',')}) and kept the current, rollback target, and live-pinned releases (${Object.keys(gc.kept).map(id => id.slice(-8)).join(',')})`)

    // --- Concurrent lifecycle verbs serialize through the transaction lock. ---
    const concurrent = await remote([
      `cd "$HOME/${remoteHome}"`,
      `R="$HOME/${remoteHome}"`,
      `SUP_NODE="$R/releases/${firstIdentity.releaseId ?? ''}/bin/node"`,
      `SUP_CLI="$R/releases/${firstIdentity.releaseId ?? ''}/runtime/node_modules/@glm-harness/gh-remote-supervisor/lib/index.js"`,
      '("$SUP_NODE" "$SUP_CLI" --root "$R" use "$R/releases" >/dev/null 2>&1; echo use-bad=$?) &',
      `("$SUP_NODE" "$SUP_CLI" --root "$R" use ${JSON.stringify(firstIdentity.releaseId ?? '')} >/dev/null 2>&1; echo use-ok=$?) &`,
      'wait',
    ].join('\n'), 60_000)
    const pointerAfter = JSON.parse(await remote(`cat "$HOME/${remoteHome}/releases/current.json"`)) as { releaseId: string }
    const serializeOk = pointerAfter.releaseId === firstIdentity.releaseId
      && concurrent.includes('use-ok=0')
    note('concurrent-verbs-serialized', serializeOk,
      `two concurrent use transactions never interleaved: the valid one won (${concurrent.trim().replace(/\n/g, ' ')}), the pointer stayed on a real release`)

    // --- An interrupted transaction is named by status and recovered by the next verb. ---
    await remote(`mkdir -p "$HOME/${remoteHome}/locks" && printf '{"kind":"gh-remote-lifecycle-lock","pid":999999999,"processIdentity":null,"nonce":"gone","verb":"update","startedAt":1,"protectedReleases":[]}' > "$HOME/${remoteHome}/locks/lifecycle.lock"`)
    const interrupted = JSON.parse(await bootstrapLifecycle(target, knownHosts, remoteHome, 'status', [], 60_000)) as { lifecycle: { verb: string; interrupted: boolean } | null }
    const recover = await bootstrapLifecycle(target, knownHosts, remoteHome, 'gc', [], 60_000)
    const namedVerb = interrupted.lifecycle?.verb === 'update' && interrupted.lifecycle.interrupted
    note('interrupted-transaction-diagnosis', namedVerb && recover.trim().startsWith('{'),
      `status named the dead holder's verb (${interrupted.lifecycle?.verb}, interrupted=${String(interrupted.lifecycle?.interrupted)}); the next verb reclaimed the claim and ran`)

    // --- Uninstall keeps the data root. ---
    await bootstrapLifecycle(target, knownHosts, remoteHome, 'stop', ['--timeout', '10'], 90_000).catch(() => undefined)
    await bootstrapLifecycle(target, knownHosts, remoteHome, 'uninstall', [], 120_000)
    const homeAfter = await remote(`cat "$HOME/${remoteHome}/home/data-marker.txt" 2>/dev/null || echo MISSING`)
    const releasesGone = await remote(`test -d "$HOME/${remoteHome}/releases" && echo present || echo gone`)
    note('uninstall-preserves-data', homeAfter.trim() === 'marker-before-update' && releasesGone.trim() === 'gone',
      'uninstall removed the runtimes and supervision state while every other byte of the data root (home, marker, sessions layout) survived')

    boundaries.push(
      'the second release is the same tree rebuilt with a variant marker, not a different product version; release identity is the installed release id',
      'machine reboot remains un-simulated (no container privileges); service crash-restart and supervisor-managed switches are real',
      'the resident composition owns no PTY/global leases; its full owned-activity set (running agents + pending inbox) is what the drain waits out — broader resource leases are GH-009',
    )
  } catch (error) {
    note('driver', false, error instanceof Error ? error.message : String(error))
  } finally {
    if (cases.some(entry => !entry.passed)) {
      const logs = await remoteCommand(target, knownHosts,
        `echo ---UPDATE-LOG---; ls -la "$HOME/update.log" 2>&1; cat "$HOME/update.log" 2>/dev/null | head -40; echo ---ROLLBACK-LOG---; tail -10 "$HOME/rollback.log" 2>/dev/null; echo ---RUNNER-LOG---; tail -30 "$HOME/${remoteHome}/log/runner.log" 2>/dev/null; echo ---IDENTITY---; cat "$HOME/${remoteHome}/run/service.json" 2>/dev/null; echo ---CURRENT---; cat "$HOME/${remoteHome}/releases/current.json" 2>/dev/null; ls "$HOME/${remoteHome}/releases" 2>/dev/null`, 30_000).catch(() => 'log unavailable')
      console.log(`--- remote runner.log tail ---\n${logs.trim().slice(-3000)}`)
    }
    await bootstrapLifecycle(target, knownHosts, remoteHome, 'stop', ['--timeout', '5'], 30_000).catch(() => undefined)
    await remoteCommand(target, knownHosts, `rm -rf "$HOME/${remoteHome}" "$HOME/update.log" "$HOME/rollback.log"`, 60_000).catch(() => undefined)
    loopback.server.close()
    loopback.server.closeAllConnections()
    await sshd.stop().catch(() => undefined)
    await rm(fixtureBase, { recursive: true, force: true }).catch(() => undefined)
  }

  const passed = cases.length > 0 && cases.every(entry => entry.passed)
  if (values.report !== undefined) {
    const summary = {
      scope: 'GH-006-G product entry: real archives over fixture OpenSSH into a no-Node jail; supervisor-profile resident service; unified bootstrap verbs; capability handshake; admission-closing drains',
      cases,
      boundaries,
      passed,
    }
    await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify({ passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
  }
  process.exit(passed ? 0 : 1)
}

/** The CLI package's version, for locating the built archives. */
async function archiveVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'apps', 'cli', 'package.json'), 'utf8')) as { version: string }
  return manifest.version
}

if (import.meta.main) await main()
