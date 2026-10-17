/** Built-profile regression, using only an owned temporary workspace and loopback GLM service.
 * Run after build:artifacts: node --import tsx/esm scripts/gh-product-smoke.mjs [report.json]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initGhProfiles } from './gh-init-profiles.ts'

const root = resolve(import.meta.dirname, '..')
const fixture = await mkdtemp(join(tmpdir(), 'gh-product-smoke-'))
const reasoning = '先写入测试文件，再核验结果。'
const expected = 'GH review regression\n'
const observations = []
const results = []
let scenario = 'tool-round'
let target = ''
const frame = payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
const delta = value => frame({ choices: [{ index: 0, delta: value }] })
const finish = reason => frame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })

const endpoint = createServer(async (request, response) => {
  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const main = body.tools?.length > 0
    const toolResult = body.messages.some(message => message.role === 'tool')
    const assistant = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.length > 0)
    const system = body.messages.find(message => message.role === 'system')?.content ?? ''
    const mainCount = observations.filter(item => item.scenario === scenario && item.main).length
    observations.push({
      scenario, main, model: body.model, toolResult, reasoning: assistant?.reasoning_content,
      system, tools: main ? body.tools.map(tool => tool.function.name) : undefined,
    })
    if (body.model !== 'glm-4.6') {
      response.writeHead(400).end(JSON.stringify({ error: { message: 'unknown model' } }))
      return
    }
    if (main && (scenario === 'rate-limit-exhaust' || (scenario === 'rate-limit-retry' && mainCount === 0))) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        .end(JSON.stringify({ error: { message: 'fixture rate limit' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (main && !toolResult) {
      assert(body.tools.some(tool => tool.function.name === 'write'))
      response.write(delta({ reasoning_content: reasoning, content: null }))
      response.write(delta({ tool_calls: [{ index: 0, id: 'review_write', type: 'function', function: {
        name: 'write', arguments: JSON.stringify({ file_path: target, content: expected }),
      } }] }))
      response.write(finish('tool_calls'))
    } else {
      if (main) assert.equal(assistant?.reasoning_content, reasoning)
      response.write(delta({ content: main ? 'GH_SMOKE_DONE' : 'Smoke title' }))
      response.write(finish('stop'))
    }
    response.write(frame({ choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } } }))
    response.write(frame({ choices: [], usage: { completion_tokens: 40, total_tokens: 140 } }))
    response.end(frame('[DONE]'))
  } catch (error) {
    response.destroy(error instanceof Error ? error : new Error(String(error)))
  }
})

async function run(name) {
  scenario = name
  const home = join(fixture, name, 'home')
  const workspace = join(fixture, name, 'workspace')
  await mkdir(workspace, { recursive: true })
  initGhProfiles(home)
  target = join(workspace, 'review.txt')
  const address = endpoint.address()
  assert(address !== null && typeof address === 'object')
  const child = spawn(process.execPath, [join(root, 'apps/cli/lib/bin.js'), '--profile', 'gh-headless', 'Write the fixture and verify it.'], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: home, GLM_API_KEY: 'synthetic-smoke-key',
      GLM_BASE_URL: `http://127.0.0.1:${address.port}`, DSH_PERMISSION_MODE: 'danger-full-access' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  try {
    const [code, signal] = await once(child, 'close')
    assert.equal(signal, null, `child failed to finish: ${stderr}`)
    const calls = observations.filter(item => item.scenario === name && item.main)
    const first = calls[0]
    if (name === 'tool-round') {
      assert.equal(code, 0, stderr)
      assert.match(stdout, /GH_SMOKE_DONE/)
      assert.equal(await readFile(target, 'utf8'), expected)
      assert.equal(calls.length, 2)
      assert.equal(calls[1].reasoning, reasoning)
      // The GH persona owns the identity and work policy; the upstream harness
      // identity is gone, and the model-facing tool order follows the pinned
      // curation rather than lexicographic order.
      assert.match(first.system, /AI coding agent powered by GLM Harness/)
      assert.match(first.system, /Verify your own work before reporting completion/)
      assert.doesNotMatch(first.system, /DeepSeek Harness/)
      assert.ok(first.system.indexOf('GLM Harness') < first.system.indexOf('Work toward'), 'identity precedes the work policy')
      const order = first.tools
      const curated = ['read', 'edit', 'write', 'bash', 'grep', 'glob']
      const positions = curated.map(name => order.indexOf(name))
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `curated tools in order: ${order.join(',')}`)
      assert.equal(positions[0], 0, `read leads the catalog: ${order.join(',')}`)
    } else if (name === 'rate-limit-retry') {
      assert.equal(code, 0, stderr)
      assert.match(stdout, /GH_SMOKE_DONE/)
      // One rejected attempt, then the bounded retry recovers: the retool
      // request, its tool-result continuation, and the final text.
      assert.equal(calls.length, 3)
    } else {
      assert.equal(code, 1, stderr)
      assert.match(stderr, /RATE_LIMIT|fixture rate limit/)
      // One attempt plus exactly the three configured retries; the budget
      // then fails the step explicitly instead of retrying in the dark.
      assert.equal(calls.length, 4, 'bounded retry budget must be one attempt plus three retries')
    }
    results.push({ name, passed: true, exitCode: code, mainRequests: calls.length })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'close')
    }
  }
}

try {
  endpoint.listen(0, '127.0.0.1')
  await once(endpoint, 'listening')
  await run('tool-round')
  await run('rate-limit-retry')
  await run('rate-limit-exhaust')
  const report = { scope: 'built gh-headless profile / synthetic loopback, no real GLM', results, observations }
  if (process.argv[2] !== undefined) await writeFile(resolve(process.argv[2]), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ passed: true, results }))
} finally {
  const closed = new Promise(resolveClosed => endpoint.close(resolveClosed))
  endpoint.closeAllConnections()
  await closed
  await rm(fixture, { recursive: true, force: true })
}
