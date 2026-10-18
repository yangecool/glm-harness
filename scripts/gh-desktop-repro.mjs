/** Reproduction harness for the two historical GH-004-A desktop findings:
 * (1) the changed-files card renders intermittently at session end — drive a
 *     full scripted turn per boot and watch up to 90s for the deliverables
 *     card, across several boots; (2) with the home's session stores locked
 *     (chmod 000) the send-path error surfaces late — time from submit to the
 *     first visible error and to the first EACCES in the host-visible log.
 *
 * Prereqs: built repo + apps/desktop, an X display, Electron's binary.
 * Run: DISPLAY=:99 node --import tsx/esm scripts/gh-desktop-repro.mjs <out-dir> [boots]
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initGhProfiles } from './gh-init-profiles.ts'
import { startFixture } from './gh-desktop-fixture.mjs'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(process.argv[2] ?? '.gh-desktop-repro')
const boots = Number(process.argv[3] ?? 3)
assert(process.env.DISPLAY !== undefined && process.env.DISPLAY !== '', 'DISPLAY must point at an X server')

const reasoning = '先写入测试文件，再核验结果。'
const expected = 'GH desktop regression\n'
await mkdir(outDir, { recursive: true })
const results = []

async function bootFixture() {
  const fixture = await mkdtemp(join(tmpdir(), 'gh-desktop-repro-'))
  const home = join(fixture, 'home')
  // XDG redirect keeps the app's first-use Documents workspace inside the
  // fixture, so the session cwd is hermetic and the scripted relative write
  // lands where the workspace-changes recorder observes it.
  const docsRoot = join(fixture, 'docs')
  const xdgConfig = join(fixture, 'xdg')
  await mkdir(xdgConfig, { recursive: true })
  await writeFile(join(xdgConfig, 'user-dirs.dirs'), `XDG_DOCUMENTS_DIR="${docsRoot}"\n`)
  initGhProfiles(home)
  return { fixture, home, docsRoot, xdgConfig, target: 'desktop-review.txt' }
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
        close: () => socket.close(),
      })
    })
    socket.addEventListener('error', () => reject(new Error('CDP websocket error')))
  })
}

async function cdp() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const list = await fetch('http://127.0.0.1:9232/json').then(response => response.json())
      const page = list.find(entry => entry.type === 'page')
      if (page !== undefined) return await connect(page.webSocketDebuggerUrl)
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('renderer debugger never came up')
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`)
  }
  return result.result.value
}

async function screenshot(page, path) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path, Buffer.from(shot.data, 'base64'))
}

/** Launch the app and drive one full turn; resolves when the completion text shows. */
async function driveTurn({ home, target, xdgConfig, onApproved }) {
  const endpoint = startFixture({ reasoning, expected, target })
  endpoint.listen(0, '127.0.0.1')
  await once(endpoint, 'listening')
  const address = endpoint.address()
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
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'close')
    }
    const closed = new Promise(resolveClosed => endpoint.close(resolveClosed))
    endpoint.closeAllConnections()
    await closed
    return appLog
  }
  try {
    const page = await cdp()
    await page.send('Runtime.enable')
    for (let attempt = 0; attempt < 90; attempt += 1) {
      if (await evaluate(page, 'document.querySelector("textarea, [contenteditable=true]") !== null')) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    await evaluate(page, `document.querySelector('[data-composer-input=true]').focus()`)
    await page.send('Input.insertText', { text: 'Write the fixture and verify it.' })
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await evaluate(page, `[...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Send message' && !button.disabled)`)) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    const submittedAt = Date.now()
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
    const deadline = submittedAt + 120_000
    while (!(await evaluate(page, `document.body.innerText.includes('GH_DESKTOP_DONE')`))) {
      if (Date.now() > deadline) throw new Error(`turn did not complete\n${appLog.slice(-3000)}`)
      await evaluate(page, approve)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    await onApproved?.(page)
    return { page, stop, submittedAt }
  } catch (error) {
    await stop()
    throw error
  }
}

// ── Scenario 1: changed-files card visibility across boots ─────────────────
for (let boot = 1; boot <= boots; boot += 1) {
  const { fixture, home, docsRoot, xdgConfig, target } = await bootFixture()
  let outcome
  try {
    const startedAt = Date.now()
    const { page, stop } = await driveTurn({ home, target, xdgConfig })
    const completedAt = Date.now()
    const cardProbe = `document.body.innerText.includes('Edited ') || document.body.innerText.includes('已编辑 ')`
    let appearedAt
    const cardDeadline = completedAt + 90_000
    while (Date.now() < cardDeadline) {
      if (await evaluate(page, cardProbe)) { appearedAt = Date.now(); break }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    if (appearedAt !== undefined) {
      await screenshot(page, join(outDir, `changed-files-boot${boot}.png`))
    } else {
      await screenshot(page, join(outDir, `no-changed-files-boot${boot}.png`))
    }
    // Deep probe: does the host serve the changes summary, and does the card
    // appear once the collapsed turn row is expanded?
    const deep = await evaluate(page, `(async () => {
      const rpc = await fetch('/api/session/list', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }),
      }).then(r => r.json())
      const id = rpc?.result?.value?.items?.[0]?.sessionId
      const summary = id === undefined ? null : await fetch('/api/changes.summary?sessionId=' + encodeURIComponent(id), { credentials: 'include' })
        .then(async r => ({ status: r.status, body: (await r.text()).slice(0, 300) })).catch(e => ({ error: String(e) }))
      const expander = [...document.querySelectorAll('button, [role=button], [aria-expanded=false]')]
        .find(node => /Completed in|耗时|完成/.test(node.textContent ?? ''))
      if (expander !== undefined) expander.click()
      await new Promise(resolve => setTimeout(resolve, 1500))
      const cardAfterExpand = document.body.innerText.includes('Edited ') || document.body.innerText.includes('已编辑 ')
      return { sessionId: id, summary, expanded: expander !== undefined, cardAfterExpand }
    })()`)
    const appLog = await stop()
    // The durable log is the ground truth for whether the recorder appended.
    const sessionLog = await import('node:fs').then(fs => {
      const sessionsRoot = join(home, 'sessions')
      if (!fs.existsSync(sessionsRoot)) return { sessionsRoot: 'missing' }
      const logs = []
      const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name.endsWith('.jsonl.zstd')) logs.push(full)
        }
      }
      walk(sessionsRoot)
      const types = []
      for (const logPath of logs) {
        const text = execFileSync('zstd', ['-dc', logPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) ?? ''
        for (const line of text.split('\n')) {
          try { types.push(JSON.parse(line).type) } catch { /* partial */ }
        }
      }
      return { logCount: logs.length, hasChanges: types.includes('workspace/changes'), hasPresented: types.includes('deliverables/presented'), tail: types.slice(-8) }
    })
    outcome = {
      boot,
      turnSeconds: Math.round((completedAt - startedAt) / 100) / 10,
      changedFilesCard: appearedAt === undefined ? 'absent-90s' : `appeared +${Math.round((appearedAt - completedAt) / 100) / 10}s`,
      fileWritten: await readFile(join(docsRoot, 'deepseek-harness', 'default-workspace', target), 'utf8').then(value => value === expected).catch(() => false),
      eaccesInLog: /EACCES/i.test(appLog),
      deepProbe: deep,
      sessionLog,
    }
  } catch (error) {
    outcome = { boot, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
  results.push({ scenario: 'changed-files', ...outcome })
  console.log(JSON.stringify(results.at(-1)))
}

// ── Scenario 2: locked stores — time until the failure surfaces ────────────
{
  const { fixture, home, docsRoot, xdgConfig, target } = await bootFixture()
  // The historical web finding locked the persistence roots before boot.
  for (const dir of ['sessions', 'storages']) {
    await mkdir(join(home, dir), { recursive: true })
    chmodSync(join(home, dir), 0o000)
  }
  let outcome
  try {
    const startedAt = Date.now()
    const endpoint = startFixture({ reasoning, expected, target })
    endpoint.listen(0, '127.0.0.1')
    await once(endpoint, 'listening')
    const address = endpoint.address()
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
    let logEaccesAt
    child.stdout.setEncoding('utf8').on('data', chunk => { appLog += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { appLog += chunk })
    const logWatcher = setInterval(() => {
      if (logEaccesAt === undefined && /EACCES|permission denied/i.test(appLog)) logEaccesAt = Date.now()
    }, 500)
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    try {
      const page = await cdp()
      await page.send('Runtime.enable')
      for (let attempt = 0; attempt < 90; attempt += 1) {
        if (await evaluate(page, 'document.querySelector("textarea, [contenteditable=true]") !== null')) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      const bootedAt = Date.now()
      await evaluate(page, `document.querySelector('[data-composer-input=true]').focus()`)
      await page.send('Input.insertText', { text: 'Write the fixture and verify it.' })
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await evaluate(page, `[...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Send message' && !button.disabled)`)) break
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const submittedAt = Date.now()
      await evaluate(page, `(() => {
        const send = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Send message')
        send.click()
        return true
      })()`)
      const errorProbe = `(() => {
        const text = document.body.innerText
        return /EACCES|permission denied|失败|错误|error/i.test(text)
      })()`
      let uiErrorAt
      const errorDeadline = submittedAt + 90_000
      while (Date.now() < errorDeadline) {
        if (await evaluate(page, errorProbe)) { uiErrorAt = Date.now(); break }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      await screenshot(page, join(outDir, 'locked-state.png'))
      outcome = {
        scenario: 'locked-late-report',
        bootSeconds: Math.round((bootedAt - startedAt) / 100) / 10,
        uiErrorAfterSubmitSeconds: uiErrorAt === undefined ? 'none-90s' : Math.round((uiErrorAt - submittedAt) / 100) / 10,
        logEaccesAfterSubmitSeconds: logEaccesAt === undefined ? 'none' : Math.round((logEaccesAt - submittedAt) / 100) / 10,
      }
    } finally {
      clearInterval(logWatcher)
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'close')
      } else {
        await new Promise(resolve => setImmediate(resolve))
      }
      await writeFile(join(outDir, 'locked-app-log.txt'), appLog)
      const closed = new Promise(resolveClosed => endpoint.close(resolveClosed))
      endpoint.closeAllConnections()
      await closed
    }
  } catch (error) {
    outcome = { scenario: 'locked-late-report', error: error instanceof Error ? error.message : String(error) }
  } finally {
    for (const dir of ['sessions', 'storages']) {
      try { chmodSync(join(home, dir), 0o755) } catch { /* already gone */ }
    }
    await rm(fixture, { recursive: true, force: true })
  }
  results.push(outcome)
  console.log(JSON.stringify(outcome))
}

await writeFile(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
