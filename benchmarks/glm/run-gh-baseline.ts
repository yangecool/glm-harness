/**
 * GH resource baseline runner (plan E00.4 / E12.1, task GH-002).
 *
 * Run from the repository root with the built CLI in place (`pnpm run build`):
 *
 *   corepack pnpm exec tsx benchmarks/glm/run-gh-baseline.ts seed   --fixture-root <dir>
 *   corepack pnpm exec tsx benchmarks/glm/run-gh-baseline.ts run    --fixture-root <dir> --out <dir> \
 *     [--settle-sec 15] [--measure-sec 60] [--cycles 0] [--sets gh,dsh]
 *
 * `seed` authors the shared synthetic corpus (the benchmarks/session-corpus
 * writer, deterministic shapes from measured quantiles) into one fixture home
 * per product: gh-* profiles for GLM Harness, shipped dsh profiles for the
 * same-carrier upstream comparison. `run` boots the built CLI (`apps/cli/
 * lib/bin.js`, never the tsx source path) per scenario and samples the whole
 * process tree:
 *
 *   idle-empty   boot → ready → settle → measured steady window (no corpus)
 *   idle-corpus  the same over the seeded home; historical bodies stay unopened
 *   adopt        headless adopts the largest ~10k-event Session and fails the
 *                model call explicitly (gh: NO_ADAPTER; dsh: no key); the load
 *                path is measured up to process exit
 *   boot-cycles  N boot→ready→settle→kill cycles for start stability (NOT an
 *                in-process leak verdict; that needs a driving client)
 *
 * Output: memory.csv (raw per-pid ticks), scenarios.json (summaries, raw tree
 * ticks, exit codes, sampler cost), summary.md (tables). Raw numbers only;
 * MEM budget verdicts are not issued here.
 *
 * Fixtures are synthetic only (benchmarks/AGENTS.md): the corpus writer's
 * measured-quantile shapes, never recorded user sessions, and the fixture root
 * is a fresh throwaway directory the caller owns.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { arch, cpus, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { cpuUsage } from 'node:process'
import { pathToFileURL } from 'node:url'
import { percentile, sampleTree, summarizeSeries, type ProcSampleRow, type TreeSeriesSummary, type TreeTick } from './proc-tree-sampler.ts'
import { initGhProfiles } from '../../scripts/gh-init-profiles.ts'
import { anchorShape, ANCHOR_COUNT } from '../session-corpus/corpus-shape.ts'
import { SyntheticCorpusWriter, type WrittenSession } from '../session-corpus/synthetic-corpus.ts'
import { generationLogPath } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

/** The corpus every fixture home shares: 1,000 Sessions over the measured shape table. */
const CORPUS_SESSIONS = 1_000
/** Session anchor adopted by the `adopt` scenario: the ~11.6k-event measured quantile. */
const ADOPT_ANCHOR = 17
/** Seconds a booted server settles after readiness before the measured window starts. */
const DEFAULT_SETTLE_SEC = 15
/** Seconds of steady-state samples per idle scenario. */
const DEFAULT_MEASURE_SEC = 60
/** Sampling period. */
const SAMPLE_INTERVAL_MS = 1_000
/** The adopt scenario's process lives ~1s, so it samples ten times faster. */
const ADOPT_SAMPLE_INTERVAL_MS = 100
/** Hard sample ceiling per scenario, so a wedged child cannot wedge the driver. */
const MAX_TICKS = 3_600
/** Wall-clock ceiling for the adopt scenario; a retry loop gets killed, not waited on. */
const ADOPT_MAX_MS = 600_000
/** Launcher waits this long for the ready URL line before giving up on a boot. */
const BOOT_TIMEOUT_MS = 60_000

/** One seeded fixture home and its facts. */
interface FixtureHome {
  /** Product set name: `gh` or `dsh`. */
  readonly set: string
  /** Harness home served as $DSH_HOME. */
  readonly home: string
  /** Stable empty cwd for launches. */
  readonly workspace: string
}

/** Raw + summarized outcome of one scenario run. */
interface ScenarioResult {
  readonly scenario: string
  readonly set: string
  readonly profile: string
  readonly exitCode: number | null
  readonly signaled: boolean
  readonly bootMs?: number
  readonly summary: TreeSeriesSummary
  /** Raw per-tick tree totals; per-pid rows live in memory.csv. */
  readonly ticks: readonly TreeTick[]
  readonly note?: string
}

function usage(): never {
  console.error('usage: run-gh-baseline.ts seed --fixture-root <dir>\n'
    + '       run-gh-baseline.ts run --fixture-root <dir> --out <dir> [--settle-sec N] [--measure-sec N] [--cycles N] [--sets gh,dsh]')
  process.exit(2)
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index !== -1 ? process.argv[index + 1] : undefined
  return value !== undefined && value !== '' ? value : undefined
}

function fixtureHome(fixtureRoot: string, set: string): FixtureHome {
  const workspace = join(fixtureRoot, set, 'workspace')
  mkdirSync(workspace, { recursive: true })
  return { set, home: join(fixtureRoot, set, 'home'), workspace }
}

/** Author the shared corpus once and link it into every set's sessions root. */
async function seedFixture(fixtureRoot: string): Promise<void> {
  const started = Date.now()
  const corpus = fixtureHome(fixtureRoot, 'corpus')
  const sessionsRoot = join(corpus.home, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const writer = new SyntheticCorpusWriter()
  for (let anchor = 0; anchor < ANCHOR_COUNT; anchor++) await writer.author(anchor)
  const written = await writer.writeCorpus(sessionsRoot, CORPUS_SESSIONS)
  const adoptRank = written.sessions.findIndex(session => session.anchor === ADOPT_ANCHOR)
  if (adoptRank === -1) throw new Error(`no rank maps to anchor ${String(ADOPT_ANCHOR)} at count ${String(CORPUS_SESSIONS)}`)
  const adopt = written.sessions[adoptRank]
  if (adopt === undefined) throw new Error('adopt candidate missing')
  const facts = { ...written.facts, adoptSessionId: adopt.header.id, adoptAnchor: adopt.anchor, adoptShape: anchorShape(adopt.anchor) }
  writeFileSync(join(corpus.home, 'corpus-facts.json'), `${JSON.stringify(facts, undefined, 2)}\n`)
  // Every product set links the same corpus bytes: identical data, identical machine.
  for (const set of ['gh', 'dsh']) {
    const target = fixtureHome(fixtureRoot, set)
    mkdirSync(join(target.home, 'sessions'), { recursive: true })
    symlinkTree(sessionsRoot, join(target.home, 'sessions'))
    await reheaderAdoptSession(join(target.home, 'sessions'), adopt, target.workspace)
    writeFileSync(join(target.home, 'corpus-facts.json'),
      `${JSON.stringify({ ...facts, adoptCwd: target.workspace }, undefined, 2)}\n`)
  }
  initGhProfiles(join(fixtureRoot, 'gh', 'home'))
  console.log(`seed: ${String(written.facts.sessions)} sessions (${String(written.facts.distinctBodies)} distinct bodies), `
    + `adopt ${String(facts.adoptSessionId)} (anchor ${String(adopt.anchor)}, ${String(anchorShape(adopt.anchor).events)}+ events), `
    + `${String((Date.now() - started) / 1000)}s`)
}

/**
 * Replace one set's adopt-Session symlink with a real file whose header cwd is
 * that set's workspace: the headless runner refuses to adopt a Session whose
 * recorded cwd differs from the process cwd, and corpus headers carry a
 * synthetic `/bench/project-N` cwd. Only the header frame is rewritten; the
 * event body frames are copied byte-for-byte, and the file moves to the path
 * the format prescribes for the new cwd.
 */
async function reheaderAdoptSession(sessionsRoot: string, adopt: WrittenSession, workspace: string): Promise<void> {
  const originalPath = generationLogPath(sessionsRoot, adopt.header.cwd, adopt.header.id, SESSION_FORMAT_VERSION, 'zstd')
  const physical = readFileSync(originalPath)
  const firstFrame = scanZstdFrames(physical, 1).frames[0]
  if (firstFrame === undefined || firstFrame.start !== 0) throw new Error(`adopt session file has no leading zstd frame: ${originalPath}`)
  const headerLine = (await decompressZstdFrame(physical.subarray(0, firstFrame.end))).toString('utf8')
  const line = JSON.parse(headerLine) as { id?: string; cwd?: string }
  if (line.id !== adopt.header.id) throw new Error(`adopt header id mismatch: ${String(line.id)}`)
  line.cwd = workspace
  const rewritten = Buffer.concat([
    await compressZstdFrame(`${JSON.stringify(line)}\n`),
    physical.subarray(firstFrame.end),
  ])
  const rehostedPath = generationLogPath(sessionsRoot, workspace, adopt.header.id, SESSION_FORMAT_VERSION, 'zstd')
  mkdirSync(dirname(rehostedPath), { recursive: true })
  writeFileSync(rehostedPath, rewritten)
  rmSync(originalPath)
}

/** Populate a destination directory with per-entry symlinks to a source directory. */
function symlinkTree(source: string, destination: string): void {
  for (const entry of readdirSync(source)) {
    const from = join(source, entry)
    const to = join(destination, entry)
    if (existsSync(to)) continue
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true })
      symlinkTree(from, to)
    } else {
      symlinkSync(from, to)
    }
  }
}

/** Buffered stdio capture, trimmed per line with a hard cap per stream. */
class LogCapture {
  private static readonly maxLines = 400
  private static readonly maxLineChars = 500
  private readonly buffers = new Map<string, { pending: string; lines: string[] }>()

  private sink(key: string, chunk: Buffer): void {
    const entry = this.buffers.get(key) ?? { pending: '', lines: [] }
    this.buffers.set(key, entry)
    if (entry.lines.length >= LogCapture.maxLines) {
      entry.pending = ''
      return
    }
    entry.pending += chunk.toString('utf8')
    const parts = entry.pending.split('\n')
    entry.pending = parts.pop() ?? ''
    for (const line of parts) {
      if (entry.lines.length >= LogCapture.maxLines) break
      entry.lines.push(line.slice(0, LogCapture.maxLineChars))
    }
  }

  private flush(key: string): void {
    const entry = this.buffers.get(key)
    if (entry !== undefined && entry.pending !== '' && entry.lines.length < LogCapture.maxLines) {
      entry.lines.push(entry.pending.slice(0, LogCapture.maxLineChars))
      entry.pending = ''
    }
  }

  pipe(child: ReturnType<typeof spawn>, label: string): void {
    child.stdout?.on('data', (chunk: Buffer) => this.sink(`${label}#out`, chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.sink(`${label}#err`, chunk))
    child.stdout?.once('end', () => this.flush(`${label}#out`))
    child.stderr?.once('end', () => this.flush(`${label}#err`))
  }

  lines(label: string, stream: 'stdout' | 'stderr'): readonly string[] {
    return this.buffers.get(`${label}#${stream === 'stdout' ? 'out' : 'err'}`)?.lines ?? []
  }
}

function launch(bin: string, args: readonly string[], fixture: FixtureHome, label: string, log: LogCapture): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: fixture.workspace,
    env: { ...process.env, DSH_HOME: fixture.home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  log.pipe(child, label)
  if (child.pid === undefined) throw new Error(`${label}: spawn failed`)
  return child
}

/** Receives every tick's rows as they are sampled, so the CSV never rewinds. */
type TickSink = (tick: TreeTick, rows: readonly ProcSampleRow[]) => void

function csvRowSink(rows: string[], scenario: string, set: string): TickSink {
  let firstT: number | undefined
  return (tick, tickRows) => {
    if (firstT === undefined) firstT = tick.t
    for (const row of tickRows) {
      rows.push([scenario, set, String(tick.t - firstT), String(row.pid), String(row.ppid), row.comm.replace(/,/g, ';'),
        String(row.rssKb), String(row.pssKb), String(row.privateKb), String(row.swapKb)].join(','))
    }
  }
}

/** Collect tree ticks until `until` settles, streaming each tick to `sink`. */
async function collect(rootPid: number, until: Promise<unknown>, sink?: TickSink, intervalMs = SAMPLE_INTERVAL_MS): Promise<{ ticks: readonly TreeTick[]; finalRows: readonly ProcSampleRow[] }> {
  const ticks: TreeTick[] = []
  let finalRows: readonly ProcSampleRow[] = []
  let done = false
  const finished = until.finally(() => {
    done = true
  })
  while (!done && ticks.length < MAX_TICKS) {
    const { rows, tick } = sampleTree(rootPid)
    ticks.push(tick)
    if (rows.length > 0) finalRows = rows
    sink?.(tick, rows)
    if (!done) await new Promise(resolveMs => setTimeout(resolveMs, intervalMs))
  }
  await finished
  return { ticks, finalRows }
}

/** Boot a server profile, wait for its ready URL line, and settle+measure. */
async function idleScenario(
  bin: string, profile: string, fixture: FixtureHome, emptyHome: string | undefined,
  settleSec: number, measureSec: number, log: LogCapture, csvRows: string[],
): Promise<ScenarioResult> {
  const variant = emptyHome === undefined ? 'corpus' : 'empty'
  const effective: FixtureHome = emptyHome === undefined ? fixture : { ...fixture, home: emptyHome }
  const label = `idle-${fixture.set}-${profile}-${variant}`
  const child = launch(bin, ['--profile', profile], effective, label, log)
  const exited = new Promise<number | null>(resolveExit => {
    child.once('exit', code => resolveExit(code))
  })
  const bootStarted = Date.now()
  let bootMs: number | undefined
  try {
    const ready = new Promise<void>(resolveReady => {
      const check = () => {
        if (log.lines(label, 'stdout').some(line => line.includes('http://'))) {
          bootMs = Date.now() - bootStarted
          resolveReady()
          return
        }
        setTimeout(check, 100)
      }
      check()
    })
    let bootTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolveTimeout, reject) => {
      bootTimer = setTimeout(() => reject(new Error(`${label}: no ready URL within ${String(BOOT_TIMEOUT_MS / 1000)}s`)), BOOT_TIMEOUT_MS)
    })
    try {
      await Promise.race([ready, timeout])
    } finally {
      clearTimeout(bootTimer)
    }
    await new Promise(resolveMs => setTimeout(resolveMs, settleSec * 1_000))
    const samplerCpuStart = cpuUsage()
    const { ticks, finalRows } = await collect(child.pid ?? 0, (async () => {
      await new Promise(resolveMs => setTimeout(resolveMs, measureSec * 1_000))
      child.kill('SIGTERM')
    })(), csvRowSink(csvRows, `idle-${variant}`, fixture.set))
    const samplerCpu = cpuUsage(samplerCpuStart)
    const exitCode = await exited
    return {
      scenario: `idle-${variant}`,
      set: fixture.set,
      profile,
      exitCode,
      signaled: exitCode === null,
      ...(bootMs !== undefined ? { bootMs } : {}),
      summary: summarizeSeries(ticks[0]?.t ?? 0, ticks, finalRows),
      ticks,
      note: `sampler driver CPU over the measured window: user ${String(Math.round(samplerCpu.user / 1000))}ms `
        + `sys ${String(Math.round(samplerCpu.system / 1000))}ms; stderr tail: ${log.lines(label, 'stderr').slice(-2).join(' | ').slice(0, 200)}`,
    }
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

/** Run headless adoption of the seeded large Session until process exit. */
async function adoptScenario(
  bin: string, profile: string, fixture: FixtureHome, log: LogCapture, csvRows: string[],
): Promise<ScenarioResult> {
  const facts = readCorpusFacts(fixture.home)
  const sessionId = facts.adoptSessionId
  if (sessionId === undefined) throw new Error(`${fixture.home} has no seeded corpus; run seed first`)
  if (facts.adoptCwd !== undefined && facts.adoptCwd !== fixture.workspace) {
    throw new Error(`${fixture.home} adopt cwd ${String(facts.adoptCwd)} is not this set's workspace; re-seed the fixture`)
  }
  const label = `adopt-${fixture.set}`
  const child = launch(bin, ['--profile', profile, '--session-id', sessionId, 'continue'], fixture, label, log)
  const started = Date.now()
  let deadlineHit = false
  const exited = new Promise<number | null>(resolveExit => {
    const timer = setTimeout(() => {
      deadlineHit = true
      child.kill('SIGKILL')
      resolveExit(null)
    }, ADOPT_MAX_MS)
    child.once('exit', code => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
  const { ticks, finalRows } = await collect(child.pid ?? 0, exited, csvRowSink(csvRows, 'adopt', fixture.set), ADOPT_SAMPLE_INTERVAL_MS)
  const exitCode = await exited
  return {
    scenario: 'adopt',
    set: fixture.set,
    profile,
    exitCode,
    signaled: exitCode === null,
    bootMs: Date.now() - started,
    summary: summarizeSeries(ticks[0]?.t ?? 0, ticks, finalRows),
    ticks,
    note: `adopt session ${sessionId}; expected explicit model-failure exit${deadlineHit ? ' (KILLED at deadline)' : ''}. `
      + `stdout tail: ${log.lines(label, 'stdout').slice(-1).join('').slice(0, 160)}; `
      + `stderr tail: ${log.lines(label, 'stderr').slice(-2).join(' | ').slice(0, 200)}`,
  }
}

/** Boot→ready→settle→kill cycles; reports start stability, not leak verdicts. */
async function bootCyclesScenario(
  bin: string, profile: string, fixture: FixtureHome, cycles: number, log: LogCapture,
): Promise<ScenarioResult> {
  const perCycle: { bootMs: number; steadyPssKb: number }[] = []
  for (let index = 0; index < cycles; index++) {
    const bootStarted = Date.now()
    const label = `cycle-${fixture.set}-${String(index)}`
    const child = launch(bin, ['--profile', profile], fixture, label, log)
    const readyLine = await new Promise<boolean>(resolveReady => {
      const deadline = Date.now() + BOOT_TIMEOUT_MS
      const check = () => {
        if (log.lines(label, 'stdout').some(line => line.includes('http://'))) {
          resolveReady(true)
          return
        }
        if (Date.now() > deadline) {
          resolveReady(false)
          return
        }
        setTimeout(check, 100)
      }
      check()
    })
    const bootMs = Date.now() - bootStarted
    if (!readyLine) {
      child.kill('SIGKILL')
      throw new Error(`cycle ${String(index)} of ${profile} failed to become ready`)
    }
    await new Promise(resolveMs => setTimeout(resolveMs, 2_000))
    perCycle.push({ bootMs, steadyPssKb: sampleTree(child.pid ?? 0).tick.pssKb })
    child.kill('SIGTERM')
    await new Promise<void>(resolveExit => {
      child.once('exit', () => resolveExit())
    })
  }
  const boots = perCycle.map(cycle => cycle.bootMs).sort((a, b) => a - b)
  const steady = perCycle.map(cycle => cycle.steadyPssKb).sort((a, b) => a - b)
  return {
    scenario: 'boot-cycles',
    set: fixture.set,
    profile,
    exitCode: 0,
    signaled: false,
    bootMs: boots[0] ?? 0,
    summary: {
      samples: perCycle.length,
      durationMs: 0,
      pssKb: { p50: percentile(steady, 50), p95: percentile(steady, 95), max: steady[steady.length - 1] ?? 0 },
      rssKb: { p50: 0, p95: 0, max: 0 },
      privateKb: { p50: 0, max: 0 },
      swapKb: { max: 0 },
      finalPids: [],
    },
    ticks: [],
    note: `boot ms p50 ${String(Math.round(percentile(boots, 50)))} p95 ${String(Math.round(percentile(boots, 95)))} `
      + `max ${String(boots[boots.length - 1] ?? 0)}; steady tree PSS at +2s per cycle; ${String(perCycle.length)} cycles`,
  }
}

function readCorpusFacts(home: string): { adoptSessionId?: string } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'corpus-facts.json'), 'utf8')) as { adoptSessionId?: string } & Record<string, unknown>
}

/** Render the per-scenario summary table rows for summary.md. */
function renderSummary(results: readonly ScenarioResult[], meta: Record<string, unknown>): string {
  const mib = (kb: number): string => (kb / 1024).toFixed(1)
  const lines: string[] = [
    '# GH-002 资源基线运行摘要', '',
    `时间:${new Date().toISOString()}`, '',
    '```json',
    JSON.stringify(meta, undefined, 2),
    '```', '',
    '| 场景 | 组 | profile | 退出码 | boot(ms) | PSS p50(MiB) | PSS p95(MiB) | PSS 峰值(MiB) | RSS p95(MiB) | 采样数 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const result of results) {
    lines.push(`| ${result.scenario} | ${result.set} | ${result.profile} | ${String(result.exitCode)} | `
      + `${result.bootMs === undefined ? '—' : String(Math.round(result.bootMs))} | ${mib(result.summary.pssKb.p50)} | ${mib(result.summary.pssKb.p95)} | `
      + `${mib(result.summary.pssKb.max)} | ${mib(result.summary.rssKb.p95)} | ${String(result.summary.samples)} | `
      + `${(result.note ?? '').split('\n')[0]?.slice(0, 120) ?? ''} |`)
  }
  lines.push('', '原始数据:memory.csv(逐 tick 逐 pid);汇总、逐 tick 树总量与进程树:scenarios.json。本运行不发布 MEM 预算结论。')
  return `${lines.join('\n')}\n`
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const fixtureRoot = resolve(argValue('--fixture-root') ?? usage())
  if (command === 'seed') {
    await seedFixture(fixtureRoot)
    return
  }
  if (command !== 'run') usage()
  const outDir = resolve(argValue('--out') ?? usage())
  const settleSec = Number(argValue('--settle-sec') ?? DEFAULT_SETTLE_SEC)
  const measureSec = Number(argValue('--measure-sec') ?? DEFAULT_MEASURE_SEC)
  const cycles = Number(argValue('--cycles') ?? 0)
  const sets = (argValue('--sets') ?? 'gh,dsh').split(',').map(set => set.trim()).filter(set => set !== '')
  for (const set of sets) {
    if (set !== 'gh' && set !== 'dsh') throw new Error(`unknown set ${JSON.stringify(set)}; only gh and dsh exist`)
  }
  mkdirSync(outDir, { recursive: true })

  const bin = resolve('apps/cli/lib/bin.js')
  if (!existsSync(bin)) throw new Error(`built CLI missing at ${bin}; run pnpm run build first`)

  // GH homes need their product profiles; initProfile never touches existing
  // files, so this is idempotent over a seeded home. dsh boots shipped
  // templates, which auto-initialize.
  if (sets.includes('gh')) {
    initGhProfiles(join(fixtureRoot, 'gh', 'home'))
    initGhProfiles(join(fixtureRoot, 'gh', 'home-empty'))
    mkdirSync(join(fixtureRoot, 'gh', 'home-empty'), { recursive: true })
  }
  for (const set of sets) mkdirSync(join(fixtureRoot, set, 'home-empty'), { recursive: true })

  const log = new LogCapture()
  const csvRows: string[] = ['scenario,set,t_offset_ms,pid,ppid,comm,rss_kb,pss_kb,private_kb,swap_kb']
  const results: ScenarioResult[] = []
  for (const set of sets) {
    const fixture = fixtureHome(fixtureRoot, set)
    const profiles = set === 'gh' ? { web: 'gh-web', headless: 'gh-headless' } : { web: 'web', headless: 'headless' }
    results.push(await idleScenario(bin, profiles.web, fixture, join(fixtureRoot, set, 'home-empty'), settleSec, measureSec, log, csvRows))
    results.push(await idleScenario(bin, profiles.web, fixture, undefined, settleSec, measureSec, log, csvRows))
    results.push(await adoptScenario(bin, profiles.headless, fixture, log, csvRows))
    if (cycles > 0) results.push(await bootCyclesScenario(bin, profiles.web, fixture, cycles, log))
  }

  writeFileSync(join(outDir, 'memory.csv'), `${csvRows.join('\n')}\n`)
  const meta = {
    node: process.version,
    bin: 'apps/cli/lib/bin.js (built)',
    os: `${cpus()[0]?.model ?? 'unknown cpu'}, ${String(cpus().length)} cores, ${(totalmem() / 1024 ** 3).toFixed(1)} GiB, ${arch()}`,
    settleSec,
    measureSec,
    cycles,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    fixtureRoot,
    corpus: existsSync(join(fixtureRoot, 'corpus', 'home', 'corpus-facts.json'))
      ? readCorpusFacts(join(fixtureRoot, 'corpus', 'home'))
      : null,
  }
  writeFileSync(join(outDir, 'scenarios.json'), `${JSON.stringify({ meta, results }, undefined, 2)}\n`)
  writeFileSync(join(outDir, 'summary.md'), renderSummary(results, meta))
  console.log(`run: ${String(results.length)} scenarios → ${outDir}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
