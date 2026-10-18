/** Real-Electron GH desktop verification: launch the unpackaged shell against
 * a GH home (desktop profile) and a loopback GLM fixture under Xvnc, drive the
 * renderer over CDP, and capture screenshots + assertions.
 *
 * Prereqs: built repo + apps/desktop (`pnpm run build`), an X display
 * (DISPLAY env; the runner does not start one), Electron's binary installed.
 * Run: node --import tsx/esm scripts/gh-desktop-run.mjs <out-dir> [--keep]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initGhProfiles } from './gh-init-profiles.ts'
import { startFixture, observations } from './gh-desktop-fixture.mjs'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(process.argv[2] ?? '.gh-desktop-run')
const keep = process.argv.includes('--keep')
assert(process.env.DISPLAY !== undefined && process.env.DISPLAY !== '', 'DISPLAY must point at an X server (e.g. Xvnc :99)')

const reasoning = '先写入测试文件，再核验结果。'
const expected = 'GH desktop regression\n'
const fixture = await mkdtemp(join(tmpdir(), 'gh-desktop-run-'))
const home = join(fixture, 'home')
// XDG redirect: the app's first-use workspace lives under the OS Documents
// root; pointing it into the fixture keeps the run hermetic and puts the
// session cwd where the scripted write can record.
const docsRoot = join(fixture, 'docs')
const xdgConfig = join(fixture, 'xdg')
await mkdir(xdgConfig, { recursive: true })
await writeFile(join(xdgConfig, 'user-dirs.dirs'), `XDG_DOCUMENTS_DIR="${docsRoot}"\n`)
await mkdir(outDir, { recursive: true })
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
const timer = setTimeout(() => child.kill('SIGKILL'), 300_000)

/** Minimal CDP client over the native WebSocket. */
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
    const events = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      } else events.push(message)
    })
    socket.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++sequence
        pending.set(id, message => {
          if (message.error !== undefined) rej(new Error(`${method}: ${message.error.message}`))
          else res(message.result)
        })
        socket.send(JSON.stringify({ id, method, params }))
      })
      resolvePromise({ send, events, close: () => socket.close() })
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

async function screenshot(page, name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(outDir, name), Buffer.from(shot.data, 'base64'))
}

/** Wait until an evaluate predicate returns truthy, polling every 500ms. */
async function waitFor(page, expression, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(page, expression)) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`timeout waiting for ${label}\n${appLog.slice(-4000)}`)
}

try {
  const page = await cdp()
  await page.send('Runtime.enable')
  await page.send('Page.enable')

  // The web client must load and mount the composer.
  await waitFor(page, 'document.querySelector("textarea, [contenteditable=true]") !== null', 'composer input')
  await screenshot(page, '01-home.png')

  // Diagnostics: the host-pushed client entry graph decides which packages the
  // renderer loaded, and console errors name any entry that failed to activate.
  const bootGraph = await evaluate(page, `(() => {
    const boot = window.__DSH_BOOT__
    if (boot === undefined) return { present: false }
    const rows = Array.isArray(boot.entries) ? boot.entries : Array.isArray(boot.plugins) ? boot.plugins : []
    return { present: true, rows: rows.map(row => ({ id: row.id })) }
  })()`)
  const consoleErrors = page.events
    .filter(event => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
    .map(event => event.params.args.map(arg => arg.value ?? arg.description).join(' '))
  await writeFile(join(outDir, 'boot-graph.json'), `${JSON.stringify({ bootGraph, consoleErrors }, null, 2)}\n`)
  console.log(`boot graph entries: ${bootGraph.rows?.map(row => row.id).join(', ') ?? '(none)'}`)

  // The GH model catalog drives the header selector; the fixture model shows.
  await waitFor(page, `document.body.innerText.includes('GLM-4.6')`, 'GLM model in the header')
  await evaluate(page, `(() => {
    const selector = [...document.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('GLM-4.6'))
    selector?.click()
    return true
  })()`)
  await waitFor(page, `[...document.querySelectorAll('[role=menu] *, [role=menuitem], [role=dialog] *')].filter(node => (node.textContent ?? '').includes('GLM-4.6')).length > 1`, 'model menu entries', 20_000)
  await screenshot(page, '02-model-menu.png')
  await evaluate(page, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)

  // Submit the scripted task through the real composer: the conversation view
  // that opens is where the permission chip's slot lives. The composer is a
  // Lexical contenteditable, so text arrives as real input (CDP insertText)
  // rather than DOM mutation Lexical would reconcile away.
  await evaluate(page, `document.querySelector('[data-composer-input=true]').focus()`)
  await page.send('Input.insertText', { text: 'Write the fixture and verify it.' })
  await waitFor(page, `[...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Send message' && !button.disabled)`, 'send button enabled', 15_000)
  await evaluate(page, `(() => {
    const send = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Send message')
    send.click()
    return true
  })()`)

  // The submitted prompt must reach the conversation view, and while the turn
  // runs the composer offers its stop control — a fast fixture may finish
  // before the first poll, so the stop sighting is opportunistic evidence.
  await waitFor(page, `document.body.innerText.includes('Write the fixture and verify it.')`, 'submitted prompt in the transcript', 30_000)
  let stopSeen = false
  let approvalSeen = false
  const stopProbe = `[...document.querySelectorAll('button')].some(button => /stop|interrupt|cancel/i.test(button.getAttribute('aria-label') ?? ''))`
  const approveProbe = `(() => {
    const allow = [...document.querySelectorAll('button')].find(button => ['Allow once', '允许一次'].includes((button.textContent ?? '').trim()))
    if (allow === undefined) return false
    allow.click()
    return true
  })()`
  const completionDeadline = Date.now() + 120_000
  while (!(await evaluate(page, `document.body.innerText.includes('GH_DESKTOP_DONE')`))) {
    if (Date.now() > completionDeadline) throw new Error(`timeout waiting for assistant completion\n${appLog.slice(-4000)}`)
    if (!stopSeen && await evaluate(page, stopProbe)) {
      stopSeen = true
      await screenshot(page, '03-turn-running.png')
    }
    if (!approvalSeen && await evaluate(page, `document.body.innerText.includes('Waiting for approval') || document.body.innerText.includes('等待审批')`)) {
      approvalSeen = true
      await screenshot(page, '04-approval-panel.png')
    }
    await evaluate(page, approveProbe)
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  await writeFile(join(outDir, 'stop-control.json'), `${JSON.stringify({ stopSeen, approvalSeen }, null, 2)}\n`)
  await screenshot(page, '05-turn-complete.png')

  const writtenPath = join(docsRoot, 'deepseek-harness', 'default-workspace', target)
  assert.equal(await readFile(writtenPath, 'utf8'), expected, 'the scripted write tool ran through the desktop runtime')
  const mainCalls = observations.filter(item => item.main)
  assert(mainCalls.length >= 2, 'at least the tool round and the continuation reached the fixture')
  assert.match(mainCalls[0].system, /AI coding agent powered by GLM Harness/)
  assert(mainCalls[0].tools.includes('write'), 'the write tool is in the desktop catalog')

  // The GH permission chip inside the conversation composer: present, default
  // build, three modes plus the independent plan entry in its menu.
  const chipState = await evaluate(page, `(() => {
    const chip = [...document.querySelectorAll('button')].find(button => {
      const label = button.getAttribute('aria-label') ?? ''
      return label.startsWith('Permission mode:') || label.startsWith('权限模式：')
    })
    if (chip === undefined) return { present: false }
    return { present: true, label: chip.getAttribute('aria-label') }
  })()`)
  assert(chipState.present, `permission chip missing\n${appLog.slice(-4000)}`)
  assert(['Permission mode: Confirm before changes', '权限模式：变更前确认'].includes(chipState.label),
    `unexpected default chip label ${JSON.stringify(chipState.label)}`)
  await evaluate(page, `(() => {
    const chip = [...document.querySelectorAll('button')].find(button => {
      const label = button.getAttribute('aria-label') ?? ''
      return label.startsWith('Permission mode:') || label.startsWith('权限模式：')
    })
    chip.click()
    return true
  })()`)
  await waitFor(page, `((document.body.innerText.includes('Full access') || document.body.innerText.includes('完全访问')) && (document.body.innerText.includes('Autonomous') || document.body.innerText.includes('自主模式')) && (document.body.innerText.includes('Plan mode') || document.body.innerText.includes('计划模式')))`, 'permission menu entries')
  await screenshot(page, '06-permission-menu.png')

  // Switch to yolo through the UI: pick with the explicit risk confirmation.
  const picked = await evaluate(page, `(() => {
    const nodes = [...document.querySelectorAll('button[role=menuitem]')]
    const entry = nodes.find(node => ['Full access', '完全访问'].includes(node.innerText.trim()))
    if (entry !== undefined) entry.click()
    return { found: entry !== undefined, text: entry?.textContent ?? null, tag: entry?.tagName ?? null, dialogs: document.querySelectorAll('[role=dialog]').length }
  })()`)
  await writeFile(join(outDir, 'yolo-pick.json'), `${JSON.stringify(picked, null, 2)}\n`)
  await waitFor(page, `document.body.innerText.includes('Switch to full access') || document.body.innerText.includes('切换到完全访问')`, 'full-access confirmation')
  await screenshot(page, '07-yolo-confirm.png')
  await evaluate(page, `(() => {
    const acknowledge = [...document.querySelectorAll('label, input')].find(node => (node.textContent ?? '').includes('I understand') || (node.textContent ?? '').includes('我已了解风险'))
    acknowledge?.click()
    return true
  })()`)
  await evaluate(page, `(() => {
    const confirm = [...document.querySelectorAll('button')].find(button => ['Switch to full access', '切换到完全访问'].includes((button.textContent ?? '').trim()))
    confirm?.click()
    return true
  })()`)
  await waitFor(page, `[...document.querySelectorAll('button')].some(button => ['Permission mode: Full access', '权限模式：完全访问'].includes(button.getAttribute('aria-label') ?? ''))`, 'chip shows full access')
  await screenshot(page, '08-yolo-active.png')

  // The independent plan entry toggles through the same menu.
  await evaluate(page, `(() => {
    const chip = [...document.querySelectorAll('button')].find(button => ['Permission mode: Full access', '权限模式：完全访问'].includes(button.getAttribute('aria-label') ?? ''))
    chip.click()
    return true
  })()`)
  await waitFor(page, `document.body.innerText.includes('Plan mode') || document.body.innerText.includes('计划模式')`, 'plan entry visible')
  await evaluate(page, `(() => {
    const entry = [...document.querySelectorAll('button[role=menuitem]')].find(node => ['Plan mode', '计划模式'].includes(node.innerText.trim()))
    entry?.click()
    return true
  })()`)
  await waitFor(page, `document.body.innerText.includes('Plan mode on') || document.body.innerText.includes('计划模式已开启')`, 'plan toggled on', 30_000)
  await screenshot(page, '09-plan-active.png')

  await writeFile(join(outDir, 'result.json'), `${JSON.stringify({ passed: true, mainRequests: mainCalls.length, target: writtenPath, home }, null, 2)}\n`)
  console.log(JSON.stringify({ passed: true, mainRequests: mainCalls.length }))
} finally {
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await once(child, 'close')
  }
  await writeFile(join(outDir, 'app-log.txt'), appLog)
  const closed = new Promise(resolveClosed => endpoint.close(resolveClosed))
  endpoint.closeAllConnections()
  await closed
  if (!keep) await rm(fixture, { recursive: true, force: true })
}
