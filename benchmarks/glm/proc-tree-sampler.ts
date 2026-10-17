/**
 * OS-level process-tree memory sampler for the GH resource baseline.
 *
 * Linux-only by design: the GH baseline's primary metric is the PSS sum of a
 * whole process tree (plan §10.6), read from `/proc/<pid>/smaps_rollup`, with
 * RSS, private, and swap listed alongside. The sampler walks the tree by ppid
 * from one root pid each tick, so processes that appear or exit between ticks
 * contribute exactly the ticks they were alive for.
 *
 * The sampler deliberately holds no history in this module's own state: every
 * tick returns its rows and the caller decides what to keep, so a scenario
 * driver can stream to CSV without doubling the sample in memory. Its own cost
 * is the caller's to report (driver CPU while only sampling), not a claim made
 * here.
 */

import { readdirSync, readFileSync } from 'node:fs'

/** One pid's memory facts at one tick, in KiB as reported by /proc. */
export interface ProcSampleRow {
  /** Milliseconds since the Unix epoch. */
  readonly t: number
  readonly pid: number
  readonly ppid: number
  /** Kernel comm (executable base name), truncated to 32 characters. */
  readonly comm: string
  readonly rssKb: number
  readonly pssKb: number
  /** Private_Clean + Private_Dirty. */
  readonly privateKb: number
  readonly swapKb: number
}

/** Per-tick aggregate of a whole tree. */
export interface TreeTick {
  readonly t: number
  readonly pids: readonly number[]
  /** Sum over the tree; shared pages still counted once per mapping owner. */
  readonly rssKb: number
  readonly pssKb: number
  readonly privateKb: number
  readonly swapKb: number
}

interface ProcStat {
  readonly pid: number
  readonly ppid: number
  readonly comm: string
}

/** Read every process's pid/ppid/comm from /proc in one pass. */
function readProcStats(): Map<number, ProcStat> {
  const stats = new Map<number, ProcStat>()
  for (const entry of readdirSync('/proc')) {
    if (entry.length === 0 || entry < '0' || entry > '9') continue
    const pid = Number(entry)
    if (!Number.isInteger(pid)) continue
    let raw: string
    try {
      raw = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue // exited between readdir and read
    }
    const commEnd = raw.lastIndexOf(')')
    if (commEnd === -1) continue
    const fields = raw.slice(commEnd + 2).split(' ')
    const ppid = Number(fields[1])
    if (!Number.isInteger(ppid)) continue
    stats.set(pid, { pid, ppid, comm: raw.slice(raw.indexOf('(') + 1, commEnd).slice(0, 32) })
  }
  return stats
}

/** Pids that make up `root`'s tree, root included. */
function treePids(stats: ReadonlyMap<number, ProcStat>, root: number): Set<number> {
  const children = new Map<number, number[]>()
  for (const stat of stats.values()) {
    const list = children.get(stat.ppid)
    if (list === undefined) children.set(stat.ppid, [stat.pid])
    else list.push(stat.pid)
  }
  const tree = new Set<number>([root])
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift()
    if (pid === undefined) break
    for (const child of children.get(pid) ?? []) {
      if (tree.has(child)) continue
      tree.add(child)
      queue.push(child)
    }
  }
  return tree
}

/** Parse the numeric field of a smaps_rollup line, in KiB; missing fields are 0. */
function rollupField(text: string, key: string): number {
  const line = text.split('\n', 20).find(candidate => candidate.startsWith(key))
  if (line === undefined) return 0
  const value = Number(line.slice(key.length).trimStart().split(' ', 1)[0])
  return Number.isFinite(value) ? value : 0
}

/** Sample every live member of `root`'s tree once. */
export function sampleTree(root: number): { rows: readonly ProcSampleRow[]; tick: TreeTick } {
  const stats = readProcStats()
  const tree = treePids(stats, root)
  const now = Date.now()
  const rows: ProcSampleRow[] = []
  const totals = { rssKb: 0, pssKb: 0, privateKb: 0, swapKb: 0 }
  for (const pid of tree) {
    let rollup: string
    try {
      rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    } catch {
      continue // exited while sampling; its ticks simply stop
    }
    const stat = stats.get(pid)
    const row: ProcSampleRow = {
      t: now,
      pid,
      ppid: stat?.ppid ?? 0,
      comm: stat?.comm ?? String(pid),
      rssKb: rollupField(rollup, 'Rss:'),
      pssKb: rollupField(rollup, 'Pss:'),
      privateKb: rollupField(rollup, 'Private_Clean:') + rollupField(rollup, 'Private_Dirty:'),
      swapKb: rollupField(rollup, 'Swap:'),
    }
    rows.push(row)
    totals.rssKb += row.rssKb
    totals.pssKb += row.pssKb
    totals.privateKb += row.privateKb
    totals.swapKb += row.swapKb
  }
  const tick: TreeTick = { t: now, pids: [...tree].sort((a, b) => a - b), ...totals }
  return { rows, tick }
}

/** Percentile of sorted ascending values at `p` in [0, 100]; linear interpolation. */
export function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0
  if (sortedValues.length === 1) return sortedValues[0] ?? 0
  const index = (p / 100) * (sortedValues.length - 1)
  const low = Math.floor(index)
  const high = Math.ceil(index)
  const lowValue = sortedValues[low] ?? 0
  const highValue = sortedValues[high] ?? lowValue
  if (low === high) return lowValue
  return lowValue + (highValue - lowValue) * (index - low)
}

/** Aggregate a time series of tree ticks into the report shape the baseline uses. */
export interface TreeSeriesSummary {
  readonly samples: number
  readonly durationMs: number
  readonly pssKb: { readonly p50: number; readonly p95: number; readonly max: number }
  readonly rssKb: { readonly p50: number; readonly p95: number; readonly max: number }
  readonly privateKb: { readonly p50: number; readonly max: number }
  readonly swapKb: { readonly max: number }
  /** Final tick's per-pid breakdown, for attribution. */
  readonly finalPids: readonly { readonly pid: number; readonly comm: string; readonly pssKb: number; readonly rssKb: number }[]
}

/** Summarize collected ticks; the last tick's rows carry the per-pid breakdown. */
export function summarizeSeries(firstTickMs: number, ticks: readonly TreeTick[], finalRows: readonly ProcSampleRow[]): TreeSeriesSummary {
  const pss = ticks.map(tick => tick.pssKb).sort((a, b) => a - b)
  const rss = ticks.map(tick => tick.rssKb).sort((a, b) => a - b)
  const priv = ticks.map(tick => tick.privateKb).sort((a, b) => a - b)
  const swap = ticks.map(tick => tick.swapKb)
  const lastTick = ticks[ticks.length - 1]
  return {
    samples: ticks.length,
    durationMs: lastTick === undefined ? 0 : lastTick.t - firstTickMs,
    pssKb: { p50: percentile(pss, 50), p95: percentile(pss, 95), max: pss[pss.length - 1] ?? 0 },
    rssKb: { p50: percentile(rss, 50), p95: percentile(rss, 95), max: rss[rss.length - 1] ?? 0 },
    privateKb: { p50: percentile(priv, 50), max: priv[priv.length - 1] ?? 0 },
    swapKb: { max: swap.length === 0 ? 0 : Math.max(...swap) },
    finalPids: finalRows.map(row => ({ pid: row.pid, comm: row.comm, pssKb: row.pssKb, rssKb: row.rssKb })),
  }
}
