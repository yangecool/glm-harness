/**
 * Remote-runtime memory measurement (MEM03/MEM04 evidence collector).
 *
 * Deploys the GH remote runtime to the fixture sshd target, starts the real
 * gh-headless runner detached inside the no-Node PATH jail, and samples the
 * runner's full process tree (Rss/Pss from /proc/<pid>/smaps_rollup) over
 * SSH. Two phases: `ready` holds the first model response open (boot
 * complete, connected, no active work), `task` drives a long tool-call loop
 * sized in rounds; the session log's event count is reported with the peaks.
 * Run: node --import tsx/esm scripts/gh-remote-mem.mjs --archive <path> [--report out.json]
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { makeNodeJail, startFixtureSshd } from './gh-remote/sshd-fixture.ts'
import { bootstrapLifecycle, deployRuntime, remoteCommand } from './gh-remote/deploy.ts'
import { remoteTargetSchema } from './gh-remote/targets.ts'

const TREE_AWK = `
BEGIN { root_pid = root + 0; members[root_pid] = 1; changed = 1 }
{
  pid = FILENAME
  sub(/^.*\\//, "", pid)
  if (pid !~ /^[0-9]+$/) next
  idx = index($0, ")")
  if (idx == 0) next
  rest = substr($0, idx + 2)
  split(rest, f, " ")
  parent[pid] = f[2] + 0
}
END {
  while (changed) {
    changed = 0
    for (pid in parent) if (parent[pid] in members && !(pid in members)) { members[pid] = 1; changed = 1 }
  }
  for (pid in members) print pid
}`

function statistics(values: number[]) {
  if (values.length === 0) return { samples: 0, medianKb: 0, peakKb: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    samples: values.length,
    medianKb: sorted[Math.floor(sorted.length / 2)],
    peakKb: sorted.at(-1),
  }
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    archive: { type: 'string' }, report: { type: 'string' }, home: { type: 'string' },
    rounds: { type: 'string' }, 'ready-seconds': { type: 'string' },
  } })
  if (values.archive === undefined) throw new Error('Use --archive=<GH remote runtime archive>')
  const archive = resolve(values.archive)
  const rounds = Number.parseInt(values.rounds ?? '1000', 10)
  const readySeconds = Number.parseInt(values['ready-seconds'] ?? '25', 10)
  const fixture = await mkdtemp(join(tmpdir(), 'gh-remote-mem-'))
  const remoteHome = values.home ?? `.gh-remote-mem-${Date.now()}`
  const sshd = await startFixtureSshd()
  const jail = await makeNodeJail(join(fixture, 'jail-bin'))
  const knownHosts = join(fixture, 'known_hosts')
  const target = remoteTargetSchema.parse({ name: 'fixture-sshd', host: '127.0.0.1', port: sshd.port, user: process.env.USER, identity: sshd.identity })

  const turnTarget = join(process.env.HOME ?? '.', remoteHome, 'workspace', 'mem-task.txt')
  let phase = 'deploy'
  let requestCount = 0
  let mainSeen = false
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      const body = JSON.parse(raw) as { messages?: Array<{ role: string }>; tools?: unknown[] }
      const toolResult = body.messages?.some(message => message.role === 'tool') ?? false
      const isMain = (body.tools ?? []).length > 0
      requestCount += 1
      const index = requestCount
      const frame = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
      const respond = (): void => {
        if (isMain && mainSeen) phase = 'task'
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (!isMain) {
          response.write(frame({ choices: [{ index: 0, delta: { content: 'GH remote mem session' } }] }))
          response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        } else if (toolResult && index - 1 >= rounds * 2) {
          response.write(frame({ choices: [{ index: 0, delta: { content: 'GH_REMOTE_MEM_DONE' } }] }))
          response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        } else {
          response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `mem_write_${index}`, type: 'function', function: {
            name: 'write', arguments: JSON.stringify({ file_path: turnTarget, content: `GH remote mem round ${index}\n` }),
          } }] } }] }))
          response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
        }
        response.write(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
        response.end(frame('[DONE]'))
      }
      if (isMain && !mainSeen) {
        mainSeen = true
        phase = 'ready'
        setTimeout(respond, readySeconds * 1000)
      } else {
        respond()
      }
    })
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  const port = await portPromise
  const samples: Record<'ready' | 'task', { rss: number[]; pss: number[] }> = { ready: { rss: [], pss: [] }, task: { rss: [], pss: [] } }
  try {
    await deployRuntime(target, { archive, home: remoteHome, knownHosts, trustFingerprint: true })
    await remoteCommand(target, knownHosts, `mkdir -p "$HOME/${remoteHome}/workspace"`, 30_000)
    await bootstrapLifecycle(target, knownHosts, remoteHome, 'start', [
      '--', '--profile', 'gh-headless', 'Run the long scripted task to completion.',
    ], 60_000, [
      `PATH=${jail}`,
      'GLM_API_KEY=synthetic-remote-key',
      `GLM_BASE_URL=http://127.0.0.1:${port}`,
      'GH_PERMISSION_MODE=yolo',
    ])

    let alive = true
    while (alive) {
      const tick = await remoteCommand(target, knownHosts, [
        `pid=$(cat "$HOME/${remoteHome}/run/runner.pid" 2>/dev/null || echo 0)`,
        '[ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null || { echo dead; exit 0; }',
        `pids=$(awk -v root=$pid '${TREE_AWK}' /proc/[0-9]*/stat 2>/dev/null | tr '\\n' ' ')`,
        '[ -n "$pids" ] || { echo nopids; exit 0; }',
        'for p in $pids; do cat /proc/$p/smaps_rollup 2>/dev/null; done | awk \'/^(Rss|Pss):/ { sum[$1] += $2 } END { print "alive", sum["Rss:"]+0, sum["Pss:"]+0 }\'',
      ].join('\n'), 20_000).catch(() => '')
      const parts = tick.trim().split(/\s+/)
      if (parts[0] === 'dead') { alive = false; break }
      if (parts[0] === 'alive' && (phase === 'ready' || phase === 'task')) {
        const [rss, pss] = [Number(parts[1]), Number(parts[2])]
        if (Number.isFinite(rss) && Number.isFinite(pss)) {
          const bucket = phase === 'ready' ? samples.ready : samples.task
          bucket.rss.push(rss)
          bucket.pss.push(pss)
        }
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 1000))
    }

    const logTail = await remoteCommand(target, knownHosts, `tail -5 "$HOME/${remoteHome}/log/runner.log"`, 30_000).catch(() => '')
    const sessionLog = await remoteCommand(target, knownHosts,
      `ls -t "$HOME/${remoteHome}/home/sessions" 2>/dev/null | head -1`, 30_000).catch(() => '')
    let events = -1
    if (sessionLog.trim() !== '') {
      const counted = await remoteCommand(target, knownHosts,
        `find "$HOME/${remoteHome}/home/sessions/${sessionLog.trim()}" -name '*.jsonl.zstd' 2>/dev/null | head -1 | xargs -r zstd -dc 2>/dev/null | wc -l`, 120_000).catch(() => '0')
      events = Number.parseInt(counted.trim(), 10) || 0
    }
    const report = {
      scope: 'real loopback OpenSSH, detached gh-headless runner inside the no-Node PATH jail, loopback GLM fixture',
      archive: basename(archive),
      rounds, readySeconds, requestsSeen: requestCount, sessionEvents: events,
      done: logTail.includes('GH_REMOTE_MEM_DONE'),
      ready: { rss: statistics(samples.ready.rss), pss: statistics(samples.ready.pss) },
      task: { rss: statistics(samples.task.rss), pss: statistics(samples.task.pss) },
      logTail: logTail.trim().split('\n').slice(-3),
    }
    console.log(JSON.stringify(report, null, 2))
    if (values.report !== undefined) await writeFile(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await bootstrapLifecycle(target, knownHosts, remoteHome, 'stop', ['--timeout', '5'], 30_000).catch(() => {})
    server.close()
    server.closeAllConnections()
    await sshd.stop().catch(() => {})
    await rm(join(process.env.HOME ?? tmpdir(), remoteHome), { recursive: true, force: true }).catch(() => {})
    await rm(fixture, { recursive: true, force: true })
  }
}

await main()
