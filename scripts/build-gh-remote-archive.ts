/**
 * Build the relocatable GH remote runtime archive: a staged CLI closure with
 * its own Node binary, an initialized profile home template, the POSIX
 * bootstrap, and a per-file digest manifest. The staging boots the real
 * gh-headless profile against a loopback GLM fixture before anything is
 * packed, so a broken closure can never reach an archive.
 *
 * Run after `pnpm run build`:
 *   node --import tsx/esm scripts/build-gh-remote-archive.ts [--output dist-exe/gh-remote] [--skip-smoke]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { create as createTar } from 'tar'
import { pnpmInvocation, restoreLegacyHoists } from './executable-packaging.ts'
import { materializeStagedLinks, deduplicateStagedWorkspacePackages } from './build-exe-for-python-sdk-staging.ts'
import { GH_BANNED_UPSTREAM_PACKAGES } from './check-gh-closure.ts'
import { artifactManifestSchema, fileDigest, payloadFiles, verifyPayload, GH_REMOTE_TARGETS, type GhRemoteTarget } from './gh-remote/artifact.ts'
import { renderBootstrapScript } from './gh-remote/bootstrap.ts'
import { restoreStagedWorkspacePackages } from './gh-remote/staging.ts'
import { initGhProfiles } from './gh-init-profiles.ts'

const root = resolve(import.meta.dirname, '..')
const cliDirectory = 'apps/cli'
const cliName = '@deepseek-ai/dsh'

interface Manifest { name: string; version: string; license?: string }

async function manifest(path: string): Promise<Manifest> { return JSON.parse(await readFile(path, 'utf8')) as Manifest }

async function run(command: string, args: string[]): Promise<void> {
  console.log(`gh-remote build: ${[command, ...args].join(' ')}`)
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolveRun()
      else rejectRun(new Error(`command failed (${code ?? signal}): ${command}`))
    })
  })
}

async function pnpm(...args: string[]): Promise<void> { const [command, argv] = pnpmInvocation(args); await run(command, argv) }

/** Remove banned upstream business packages that arrived transitively; GH profiles must never load them. */
async function pruneBanned(staging: string): Promise<string[]> {
  const pruned: string[] = []
  for (const banned of GH_BANNED_UPSTREAM_PACKAGES) {
    const scope = banned.split('/')[0] as string
    const name = banned.split('/')[1] as string
    const direct = join(staging, 'node_modules', scope, name)
    if (existsSync(direct)) {
      await rm(direct, { recursive: true, force: true })
      pruned.push(banned)
    }
    const pnpmStore = join(staging, 'node_modules', '.pnpm')
    if (existsSync(pnpmStore)) {
      const prefix = `${scope}+${name}@`
      for (const entry of await readdir(pnpmStore)) {
        if (entry.startsWith(prefix)) {
          await rm(join(pnpmStore, entry), { recursive: true, force: true })
          if (!pruned.includes(banned)) pruned.push(banned)
        }
      }
    }
  }
  if (pruned.length > 0) console.log(`gh-remote build: pruned banned packages from staging: ${pruned.join(', ')}`)
  return pruned
}

async function copyLicenses(staging: string, product: string): Promise<void> {
  const destination = join(product, 'LICENSES')
  await mkdir(destination, { recursive: true })
  const inventory: { name: string; version: string; license?: string }[] = []
  for (const path of globSync(['node_modules/*/package.json', 'node_modules/@*/*/package.json'], { cwd: staging }).sort()) {
    const directory = dirname(join(staging, path))
    const data = await manifest(join(staging, path))
    inventory.push({ name: data.name, version: data.version, ...(data.license === undefined ? {} : { license: data.license }) })
    const licenses = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name))
    for (const name of licenses) {
      const source = join(directory, name)
      if (!(await lstat(source)).isFile()) continue
      const output = join(destination, data.name.replaceAll('/', '__'), name)
      await mkdir(dirname(output), { recursive: true })
      await copyFile(source, output)
    }
  }
  await copyFile(join(root, 'LICENSE'), join(destination, 'glm-harness-MIT.txt'))
  await writeFile(join(destination, 'packages.json'), `${JSON.stringify(inventory, null, 2)}\n`)
}

/**
 * Boot the staged closure through the real gh-headless profile against a
 * loopback GLM fixture; a closure missing anything fails the build here.
 * @param staging - staged runtime root (lib/bin.js + node_modules).
 * @param home - fixture GH home with initialized profiles.
 */
async function smokeStagedClosure(staging: string, home: string): Promise<void> {
  const workspace = join(home, 'smoke-workspace')
  await mkdir(workspace, { recursive: true })
  const target = join(workspace, 'remote-smoke.txt')
  const frame = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
  const endpoint = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      const body = JSON.parse(raw) as { messages?: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }> }
      const toolResult = body.messages?.some(message => message.role === 'tool') ?? false
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!toolResult) {
        response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'remote_write', type: 'function', function: {
          name: 'write', arguments: JSON.stringify({ file_path: target, content: 'GH remote smoke\n' }),
        } }] } }] }))
        response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
      } else {
        response.write(frame({ choices: [{ index: 0, delta: { content: 'GH_REMOTE_SMOKE_DONE' } }] }))
        response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      }
      response.write(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      response.end(frame('[DONE]'))
    })
  })
  endpoint.listen(0, '127.0.0.1')
  await once(endpoint, 'listening')
  const address = endpoint.address()
  if (address === null || typeof address !== 'object') throw new Error('gh-remote build: smoke endpoint failed to listen')
  const child = spawn(process.execPath, [join(staging, 'lib', 'bin.js'), '--profile', 'gh-headless', 'Write the smoke file and finish.'], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: home,
      GLM_API_KEY: 'synthetic-remote-key',
      GLM_BASE_URL: `http://127.0.0.1:${address.port}`,
      GH_PERMISSION_MODE: 'yolo',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  try {
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null]
    if (code !== 0 || signal !== null) throw new Error(`gh-remote build: staged closure smoke failed (${code ?? signal}): ${stderr}`)
    if (!stdout.includes('GH_REMOTE_SMOKE_DONE')) throw new Error(`gh-remote build: staged closure smoke missed its marker: ${stdout}`)
    if (!existsSync(target)) throw new Error('gh-remote build: staged closure smoke wrote no file')
  } finally {
    clearTimeout(timer)
    endpoint.close()
    endpoint.closeAllConnections()
  }
}

/**
 * Boot the staged closure's `gh-supervisor` profile against a scratch release
 * store: the supervisor profile runner must spawn the resident service from
 * the staged runtime, publish its identity, and answer the capability
 * handshake — the closure guarantee the archive ships.
 * @param staging - staged runtime root (lib/bin.js + node_modules).
 * @param home - fixture GH home with initialized profiles.
 */
/** The ghRemote/describe envelope the supervisor smoke handshake reads. */
interface SmokeDescribe {
  result?: { ok?: boolean; value?: { runtimeId?: string | null; releaseId?: string | null; admission?: string } }
}

async function smokeSupervisorProfile(staging: string, home: string): Promise<void> {
  // The smoke's release is a fresh multi-gigabyte copy; a cold boot can outrun
  // the default ready budget. Overriding the tunable through the profile patch
  // is itself the configurability guarantee this smoke carries.
  await writeFile(join(home, 'profiles', 'gh-supervisor', 'cordis.patch.yml'), [
    '# supervisor smoke: a cold first boot from a fresh release copy.',
    '- id: gh-supervisor-runner',
    '  config:',
    '    readyTimeoutMs: 240000',
    '    baseBackoffMs: 250',
    '',
  ].join('\n'))
  const root = join(home, 'supervisor-smoke-root')
  const supervisorCli = join(staging, 'node_modules', '@glm-harness', 'gh-remote-supervisor', 'lib', 'index.js')
  const installed = spawnSync(process.execPath, [supervisorCli, '--root', root, 'install', '--from', staging], { encoding: 'utf8' })
  if (installed.status !== 0) throw new Error(`gh-remote build: supervisor smoke install failed: ${installed.stderr}`)
  const used = spawnSync(process.execPath, [supervisorCli, '--root', root, 'use', installed.stdout.trim()], { encoding: 'utf8' })
  if (used.status !== 0) throw new Error(`gh-remote build: supervisor smoke use failed: ${used.stderr}`)
  const runner = spawn(process.execPath, [join(staging, 'lib', 'bin.js'), '--profile', 'gh-supervisor', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: home,
    env: {
      ...process.env,
      DSH_HOME: home,
      GH_REMOTE_ROOT: root,
      GLM_API_KEY: 'synthetic-smoke-key',
      GH_PERMISSION_MODE: 'yolo',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let supervisorErr = ''
  let supervisorOut = ''
  runner.stderr.setEncoding('utf8').on('data', (chunk: string) => { supervisorErr += chunk })
  runner.stdout.setEncoding('utf8').on('data', (chunk: string) => { supervisorOut += chunk })
  try {
    const identityPath = join(root, 'run', 'service.json')
    let identity: { pid?: number; readyUrl?: string; releaseId?: string | null } | null = null
    for (let attempt = 0; attempt < 240 && identity === null; attempt += 1) {
      identity = await readFile(identityPath, 'utf8').then(raw => JSON.parse(raw) as typeof identity).catch(() => null)
      if (identity?.readyUrl === undefined || identity.readyUrl === '') identity = null
      if (runner.exitCode !== null && identity === null) break
      await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
    }
    if (identity?.readyUrl === undefined) {
      const currentPointer = JSON.parse(await readFile(join(root, 'releases', 'current.json'), 'utf8')) as { releaseId: string }
      const releaseDir = join(root, 'releases', currentPointer.releaseId)
      const dump = JSON.stringify({
        stderrHead: supervisorErr.slice(0, 800),
        stderrTail: supervisorErr.slice(-400),
        stdout: supervisorOut,
        identity: await readFile(identityPath, 'utf8').catch(() => null),
        releaseTop: await readdir(releaseDir).catch(() => null),
        releaseRuntime: await readdir(join(releaseDir, 'runtime')).catch(() => null),
        entryExists: await readFile(join(releaseDir, 'runtime', 'lib', 'bin.js'), 'utf8').then(() => true,
          () => readFile(join(releaseDir, 'lib', 'bin.js'), 'utf8').then(() => true, () => false)),
      }, null, 2)
      throw new Error(`gh-remote build: supervisor smoke never became ready: ${dump}`)
    }
    // The capability handshake answers over the service's own transport.
    const exchange = await fetch(identity.readyUrl, { redirect: 'manual' })
    const cookie = exchange.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ')
    const described = await fetch(new URL('/api/ghRemote/describe', new URL(identity.readyUrl).origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-describe', method: 'ghRemote/describe', payload: { args: {} } }),
    }).then(response => response.json() as Promise<SmokeDescribe>)
    if (described.result?.ok !== true || described.result.value?.releaseId === null || described.result.value?.releaseId === undefined) {
      throw new Error(`gh-remote build: supervisor smoke handshake failed: ${JSON.stringify(described).slice(0, 200)}`)
    }
  } finally {
    runner.kill('SIGTERM')
    await Promise.race([once(runner, 'close'), new Promise(resolveKill => setTimeout(resolveKill, 15_000))])
    await new Promise<void>((resolveStop) => {
      const stop = spawnSync(process.execPath, [supervisorCli, '--root', root, 'stop'], { encoding: 'utf8' })
      void stop
      resolveStop()
    })
  }
}

/**
 * Build the selected target's relocatable runtime archive.
 * @param argv - command-line arguments, excluding the interpreter and script.
 */
export async function buildGhRemoteArchive(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: {
    target: { type: 'string' }, output: { type: 'string' }, 'skip-smoke': { type: 'boolean', default: false },
    variant: { type: 'string' },
  } })
  const variant = values.variant
  const host = `${process.platform}-${process.arch}`
  const selected = (values.target ?? host) as GhRemoteTarget
  if (!GH_REMOTE_TARGETS.some(target => target === selected)) throw new Error(`Unsupported GH remote target: ${selected}`)
  if (selected !== host) throw new Error(`GH remote target ${selected} requires its native host; current host is ${host}`)
  if (!existsSync(join(root, cliDirectory, 'lib', 'bin.js'))) throw new Error('gh-remote build: run `pnpm run build` first (apps/cli/lib/bin.js missing)')
  const definition = await manifest(join(root, cliDirectory, 'package.json'))
  const output = resolve(root, values.output ?? 'dist-exe/gh-remote')
  await mkdir(join(root, '.dsh-build'), { recursive: true })
  const temporary = await mkdtemp(join(root, '.dsh-build/gh-remote-'))
  try {
    const staging = join(temporary, 'staging')
    try {
      await pnpm('--filter', cliName, 'deploy', '--legacy', '--prod', '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.auto-install-peers=false', '--config.link-workspace-packages=true', '--config.hoist-workspace-packages=false', staging)
    } finally {
      await pnpm('install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts')
    }
    await restoreLegacyHoists(staging, join(root, cliDirectory, 'node_modules'))
    await materializeStagedLinks(staging)
    await deduplicateStagedWorkspacePackages(staging, root)
    await restoreStagedWorkspacePackages(staging, root)
    await pruneBanned(staging)

    const home = join(temporary, 'smoke-home')
    initGhProfiles(home)
    if (!values['skip-smoke']) {
      await smokeStagedClosure(staging, home)
      await smokeSupervisorProfile(staging, home)
    }

    const product = join(temporary, 'gh-remote')
    await mkdir(join(product, 'bin'), { recursive: true })
    await copyFile(process.execPath, join(product, 'bin', 'node'))
    await chmod(join(product, 'bin', 'node'), 0o755)
    await cp(staging, join(product, 'runtime'), { recursive: true })
    await cp(join(home, 'profiles'), join(product, 'home-template', 'profiles'), { recursive: true })
    await writeFile(join(product, 'bootstrap.sh'), renderBootstrapScript())
    await chmod(join(product, 'bootstrap.sh'), 0o755)
    await copyLicenses(staging, product)

    const metadata = artifactManifestSchema.parse({
      format: 1, product: 'gh-remote-runtime', version: definition.version, target: selected,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
      ...(variant === undefined ? {} : { variant }),
      nodeVersion: process.version,
      entry: 'bootstrap.sh',
      files: await Promise.all((await payloadFiles(product)).map(async path => ({
        path, sha256: await fileDigest(join(product, path)), mode: (await lstat(join(product, path))).mode & 0o777,
      }))),
    })
    await writeFile(join(product, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    await verifyPayload(product)

    await mkdir(output, { recursive: true })
    const archive = join(output, `gh-remote-${definition.version}-${selected}${variant === undefined ? '' : `-${variant}`}.tar.gz`)
    await createTar({ cwd: temporary, file: archive, gzip: true, portable: true }, ['gh-remote'])
    await writeFile(`${archive}.sha256`, `${await fileDigest(archive)}  ${basename(archive)}\n`)
    const size = (await lstat(archive)).size
    console.log(`GH remote archive: ${archive} (${(size / 1024 / 1024).toFixed(1)} MiB, ${metadata.files.length} files, node ${process.version})`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) await buildGhRemoteArchive(process.argv.slice(2))
