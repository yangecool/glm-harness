/** Process-tree memory measurement for the GH desktop app: boots the real
 * Electron shell against a loopback GLM fixture, samples the FULL descendant
 * tree (launcher, Electron main/gpu/renderer/utility, desktop host, and any
 * node children) once per second, drives one scripted turn, and reports idle
 * (MEM01) and post-turn (MEM02) totals split per component class.
 *
 * The sampler walks /proc PPid chains from the spawned launcher, so processes
 * that detach from the direct child pipe are still counted — the flaw that
 * made the historical web measurements undercount.
 *
 * Prereqs: built repo + apps/desktop, an X display, Electron's binary.
 * Run: DISPLAY=:99 node --import tsx/esm scripts/gh-desktop-mem.mjs <out-dir>
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initGhProfiles } from './gh-init-profiles.ts'
import { startFixture } from './gh-desktop-fixture.mjs'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(process.argv[2] ?? '.gh-desktop-mem')
assert(process.env.DISPLAY !== undefined && process.env.DISPLAY !== '', 'DISPLAY must point at an X server')

const IDLE_SECONDS = Number(process.env.GH_MEM_IDLE_SECONDS ?? 30)
const reasoning = '先写入测试文件，再核验结果。'
const expected = 'GH desktop regression\n'
const fixture = await mkdtemp(join(tmpdir(), 'gh-desktop-mem-'))
const home = join(fixture, 'home')
// XDG redirect keeps the app's first-use Documents workspace inside the
// fixture, so the session cwd is hermetic and the scripted relative write
// lands where the workspace-changes recorder observes it.
const docsRoot = join(fixture, 'docs')
const xdgConfig = join(fixture, 'xdg')
await mkdir(xdgConfig, { recursive: true })
await mkdir(outDir, { recursive: true })
await writeFile(join(xdgConfig, 'user-dirs.dirs'), `XDG_DOCUMENTS_DIR="${docsRoot}"\n`)
initGhProfiles(home)
const target = 'desktop-review.txt'

const endpoint = startFixture({ reasoning, expected, target })
endpoint.listen(0, '127.0.0.1')
await once(endpoint, 'listening')
const address = endpoint.address()
assert(address !== null && typeof address === 'object')

const child = spawn(process.execPath, [
  'node_modules/pnpm/bin/pnpm.cjs', 'run', '--config.verifyDepsBeforeRun=false', 'start:desktop',
], {
  cwd: root,
  env: {
    ...process.env,
    DSH_HOME: home,
    GLM_API_KEY: 'synthetic-desktop-key',
    GLM_BASE_URL: `http://127.0.0.1:${address.port}`,
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    DSH_DESKTOP_MAIN_INSPECT_PORT: '9231',
    DSH_DESKTOP_RENDERER_DEBUG_PORT: '9232',
    DSH_DESKTOP_HOST_INSPECT_PORT: '9233',
    ELECTRON_ENABLE_LOGGING: '1',
    XDG_CONFIG_HOME: xdgConfig,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
child.stdout.setEncoding('utf8').on('data', chunk => { appLog += chunk })
child.stderr.setEncoding('utf8').on('data', chunk => { appLog += chunk })
const timer = setTimeout(() => child.kill('SIGKILL'), 420_000)

/** One /proc snapshot: pid → { ppid, comm, rssKiB, cmdline }. */
function procSnapshot() {
  const rows = new Map()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const fields = stat.slice(close + 2).split(' ')
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(part => part !== '')
      rows.set(Number(entry), {
        ppid: Number(fields[1]),
        comm: stat.slice(stat.indexOf('(') + 1, close),
        rssKiB: Number(fields[21]) * 4,
        cmdline: cmdline.join(' '),
      })
    } catch { /* raced exit */ }
  }
  return rows
}

/** Descendants of one root pid over a snapshot, as a flat pid list. */
function descendants(snapshot, rootPid) {
  const children = new Map()
  for (const [pid, row] of snapshot) {
    const list = children.get(row.ppid) ?? []
    list.push(pid)
    children.set(row.ppid, list)
  }
  const out = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    out.push(pid)
    queue.push(...children.get(pid) ?? [])
  }
  return out
}

/** Classify one process for the report split. */
function classify(row) {
  const cmd = row.cmdline
  if (cmd.includes('dsh-desktop-host')) return 'host'
  if (cmd.includes('--type=renderer')) return 'renderer'
  if (cmd.includes('--type=gpu-process')) return 'gpu'
  if (cmd.includes('--type=utility')) return 'utility'
  if (cmd.includes('electron') || cmd.includes('chrome_crashpad_handler')) return 'electron-main'
  if (cmd.includes('pnpm') || cmd.includes('scripts/dev.ts') || cmd.includes('tsx')) return 'launcher'
  return 'other'
}

/** All samples; each entry: t, phase, per-class rss sums, total. */
const samples = []
let phase = 'boot'
function sample() {
  const snapshot = procSnapshot()
  const pids = descendants(snapshot, child.pid)
  const perClass = {}
  let total = 0
  for (const pid of pids) {
    const row = snapshot.get(pid)
    if (row === undefined) continue
    const kind = classify(row)
    perClass[kind] = (perClass[kind] ?? 0) + row.rssKiB
    total += row.rssKiB
  }
  samples.push({ t: Math.round(performance.now() / 100) / 10, phase, perClass, totalKiB: total })
}
const sampler = setInterval(sample, 1000)

/** Minimal CDP client (renderer) shared with gh-desktop-run. */
async function cdp() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const list = await fetch('http://127.0.0.1:9232/json').then(response => response.json())
      const page = list.find(entry => entry.type === 'page')
      if (page !== undefined) return await connect(page.webSocketDebuggerUrl)
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`renderer debugger never came up\n${appLog.slice(-4000)}`)
}

function connect(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url)
    let sequence = 0
    const pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    })
    socket.addEventListener('open', () => {
      resolvePromise({
        send: (method, params = {}) => new Promise((res, rej) => {
          const id = ++sequence
          pending.set(id, message => {
            if (message.error !== undefined) rej(new Error(`${method}: ${message.error.message}`))
            else res(message.result)
          })
          socket.send(JSON.stringify({ id, method, params }))
        }),
      })
    })
    socket.addEventListener('error', () => reject(new Error('CDP websocket error')))
  })
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`)
  }
  return result.result.value
}

async function waitFor(page, expression, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(page, expression)) return
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error(`timeout waiting for ${label}\n${appLog.slice(-3000)}`)
}

function summarize(name, sliceSamples) {
  const totals = sliceSamples.map(entry => entry.totalKiB)
  const byClass = {}
  for (const entry of sliceSamples) {
    for (const [kind, kib] of Object.entries(entry.perClass)) {
      byClass[kind] = Math.max(byClass[kind] ?? 0, kib)
    }
  }
  const sorted = [...totals].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  return {
    name,
    samples: totals.length,
    medianMiB: Math.round((median / 1024) * 10) / 10,
    peakMiB: Math.round(((sorted.at(-1) ?? 0) / 1024) * 10) / 10,
    peakPerClassMiB: Object.fromEntries(
      Object.entries(byClass).map(([kind, kib]) => [kind, Math.round((kib / 1024) * 10) / 10]).sort((a, b) => b[1] - a[1]),
    ),
  }
}

try {
  const page = await cdp()
  await page.send('Runtime.enable')
  await waitFor(page, 'document.querySelector("textarea, [contenteditable=true]") !== null', 'composer input')
  phase = 'idle'
  await new Promise(resolve => setTimeout(resolve, IDLE_SECONDS * 1000))

  phase = 'turn'
  await evaluate(page, `document.querySelector('[data-composer-input=true]').focus()`)
  await page.send('Input.insertText', { text: 'Write the fixture and verify it.' })
  await waitFor(page, `[...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Send message' && !button.disabled)`, 'send enabled')
  await evaluate(page, `(() => {
    const send = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Send message')
    send.click()
    return true
  })()`)
  const approve = `(() => {
    const allow = [...document.querySelectorAll('button')].find(button => ['Allow once', '允许一次'].includes((button.textContent ?? '').trim()))
    if (allow === undefined) return false
    allow.click()
    return true
  })()`
  const deadline = Date.now() + 120_000
  while (!(await evaluate(page, `document.body.innerText.includes('GH_DESKTOP_DONE')`))) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for completion\n${appLog.slice(-3000)}`)
    await evaluate(page, approve)
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  assert.equal(await readFile(join(docsRoot, 'deepseek-harness', 'default-workspace', target), 'utf8'), expected, 'the scripted write tool ran')

  phase = 'settled'
  await new Promise(resolve => setTimeout(resolve, IDLE_SECONDS * 1000))

  const report = {
    idle: summarize('MEM01 idle (post-boot, pre-turn)', samples.filter(entry => entry.phase === 'idle')),
    turn: summarize('turn (approval + tool round)', samples.filter(entry => entry.phase === 'turn')),
    settled: summarize('MEM02 settled (post-turn)', samples.filter(entry => entry.phase === 'settled')),
    historicalWebMiB: { mem01: 577, mem02: 562, candidate: 450 },
    note: 'RSS of the full descendant tree of the launcher, sampled every second; per-class rows are per-class peaks, not a sum across phases.',
  }
  await writeFile(join(outDir, 'mem-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(outDir, 'mem-samples.json'), `${JSON.stringify(samples, null, 1)}\n`)
  await writeFile(join(outDir, 'app-log.txt'), appLog)
  console.log(JSON.stringify(report, null, 2))
} finally {
  clearInterval(sampler)
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await once(child, 'close')
  }
  const closed = new Promise(resolveClosed => endpoint.close(resolveClosed))
  endpoint.closeAllConnections()
  await closed
  await rm(fixture, { recursive: true, force: true })
}
