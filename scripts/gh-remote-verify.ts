/**
 * Real-OpenSSH acceptance for the GH remote runtime archive.
 *
 * Runs an unprivileged fixture sshd on a loopback port with its own host key
 * and authorized_keys, deploys through the controller pipeline, and exercises
 * the acceptance matrix on the target side through a PATH jail that contains
 * no Node binary: probe/TOFU (R01/R02/R04), install/activate, a real
 * gh-headless profile turn over the loopback GLM fixture (E04.2 runner
 * startup without Node), tampered-archive refusal (R07), concurrent installs
 * (R08), and rollback. Usage:
 *   node --import tsx/esm scripts/gh-remote-verify.ts --archive <path> [--report out.json]
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { StageError } from './gh-remote/probe.ts'
import { bootstrapLifecycle, deployRuntime, remoteCommand } from './gh-remote/deploy.ts'
import { remoteTargetSchema } from './gh-remote/targets.ts'
import { makeNodeJail, startFixtureSshd } from './gh-remote/sshd-fixture.ts'

interface CaseResult { name: string; passed: boolean; detail: string }

function loopbackFixture(target: string): { server: ReturnType<typeof createServer>; portPromise: Promise<number> } {
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      const body = JSON.parse(raw) as { messages?: Array<{ role: string }> }
      const toolResult = body.messages?.some(message => message.role === 'tool') ?? false
      const frame = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!toolResult) {
        response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'verify_write', type: 'function', function: {
          name: 'write', arguments: JSON.stringify({ file_path: target, content: 'GH remote verify turn\n' }),
        } }] } }] }))
        response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
      } else {
        response.write(frame({ choices: [{ index: 0, delta: { content: 'GH_REMOTE_VERIFY_DONE' } }] }))
        response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      }
      response.write(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      response.end(frame('[DONE]'))
    })
  })
  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { resolvePort((server.address() as { port: number }).port) })
  })
  return { server, portPromise }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    archive: { type: 'string' }, report: { type: 'string' }, home: { type: 'string' },
  } })
  if (values.archive === undefined) throw new Error('Use --archive=<GH remote runtime archive>')
  const archive = resolve(values.archive)
  const fixture = await mkdtemp(join(tmpdir(), 'gh-remote-verify-'))
  const cases: CaseResult[] = []
  const note = (name: string, passed: boolean, detail: string): void => {
    cases.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }
  const remoteHome = values.home ?? `.gh-remote-verify-${Date.now()}`
  const sshd = await startFixtureSshd()
  const jail = await makeNodeJail(join(fixture, 'jail-bin'))
  const knownHosts = join(fixture, 'known_hosts')
  const target = remoteTargetSchema.parse({ name: 'fixture-sshd', host: '127.0.0.1', port: sshd.port, user: process.env.USER, identity: sshd.identity })
  const turnTarget = join(process.env.HOME ?? '.', remoteHome, 'workspace', 'verify-turn.txt')
  const turn = loopbackFixture(turnTarget)
  const port = await turn.portPromise
  try {
    // R02 first fingerprint: an unconfirmed host key refuses at the connect stage.
    try {
      await deployRuntime(target, { archive, home: remoteHome, knownHosts })
      note('tofu-refuses-untrusted', false, 'untrusted fingerprint was accepted')
    } catch (error) {
      const stage = error instanceof StageError ? error.stage : 'none'
      note('tofu-refuses-untrusted', stage === 'connect', `stage=${stage}`)
    }

    const deployed = await deployRuntime(target, { archive, home: remoteHome, knownHosts, trustFingerprint: true })
    note('deploy-probe-target', deployed.probe.target === 'linux-x64', `target=${deployed.probe.target} libc=${deployed.probe.getconfLine}`)
    note('deploy-install-activated', deployed.installLog.includes('activated'), deployed.installLog.split('\n').at(-1) ?? '')
    note('deploy-status-release', deployed.releaseSummary.includes('version='), deployed.releaseSummary.split('\n').filter(line => line.startsWith('version=') || line.startsWith('release=') || line.startsWith('node=')).join(' '))

    const jailCheck = await remoteCommand(target, knownHosts, `PATH="${jail}" sh -c "command -v node && echo node-present || echo node-absent"`, 30_000)
    note('target-jail-has-no-node', jailCheck.trim() === 'node-absent', jailCheck.trim())

    const workspace = `${remoteHome}/workspace`
    await mkdir(fixture, { recursive: true })
    await remoteCommand(target, knownHosts, `mkdir -p "$HOME/${workspace}"`, 30_000)
    const turnOutput = await bootstrapLifecycle(target, knownHosts, remoteHome, 'run', [
      '--', '--profile', 'gh-headless', 'Write the verify file and finish.',
    ], 300_000, [
      `PATH="${jail}"`,
      'GLM_API_KEY=synthetic-remote-key',
      `GLM_BASE_URL=http://127.0.0.1:${port}`,
      'GH_PERMISSION_MODE=yolo',
    ])
    note('remote-turn-no-node', turnOutput.includes('GH_REMOTE_VERIFY_DONE'), turnOutput.trim().split('\n').at(-1) ?? '')

    const written = await remoteCommand(target, knownHosts, `cat '${turnTarget}' 2>/dev/null || echo missing`, 30_000)
    note('remote-turn-file', written.trim() === 'GH remote verify turn', written.trim())

    // R07: a corrupted archive refuses at the digest stage on the target itself.
    const corruptName = `corrupt-${basename(archive)}`
    await remoteCommand(target, knownHosts, `cp "$HOME/${remoteHome}/upload/${basename(archive)}" "$HOME/${remoteHome}/upload/${corruptName}" && printf X >> "$HOME/${remoteHome}/upload/${corruptName}" && cp "$HOME/${remoteHome}/upload/${basename(archive)}.sha256" "$HOME/${remoteHome}/upload/${corruptName}.sha256"`, 60_000)
    try {
      await remoteCommand(target, knownHosts, `cd "$HOME/${remoteHome}/upload" && GH_REMOTE_HOME="$HOME/${remoteHome}" sh ./bootstrap.sh install "./${corruptName}"`, 120_000)
      note('tamper-refused', false, 'corrupted archive was installed')
    } catch (error) {
      const stage = error instanceof StageError ? error.stage : 'none'
      note('tamper-refused', stage === 'verify-archive', `stage=${stage}`)
    }

    // R08 front: two concurrent installs of the same release serialize through the lock.
    const concurrent = await Promise.allSettled([0, 1].map(() =>
      remoteCommand(target, knownHosts, `cd "$HOME/${remoteHome}/upload" && GH_REMOTE_HOME="$HOME/${remoteHome}" sh ./bootstrap.sh install "./${basename(archive)}" --force`, 300_000)))
    const concurrentCodes = concurrent.map(outcome => outcome.status === 'fulfilled' ? 'ok' : `stage=${outcome.reason instanceof StageError ? outcome.reason.stage : 'error'}`)
    note('concurrent-installs-serialize', concurrentCodes.every(code => code === 'ok'), concurrentCodes.join(' + '))

    const releases = await remoteCommand(target, knownHosts, `ls -1 "$HOME/${remoteHome}/releases" | sort -r | head -3`, 30_000)
    const releaseList = releases.trim().split('\n').filter(line => line.length > 0)
    note('two-releases-present', releaseList.length >= 2, releaseList.join(' '))
    if (releaseList.length >= 2) {
      const rollback = await bootstrapLifecycle(target, knownHosts, remoteHome, 'rollback', [], 120_000)
      note('rollback-activates-previous', rollback.includes('rolled back'), rollback.trim())
    }

    const finalStatus = await bootstrapLifecycle(target, knownHosts, remoteHome, 'status', [], 30_000)
    note('status-after-all', finalStatus.includes('release='), finalStatus.trim().split('\n').slice(0, 3).join(' '))
  } finally {
    turn.server.close()
    turn.server.closeAllConnections()
    await sshd.stop().catch(() => {})
    await rm(join(process.env.HOME ?? tmpdir(), remoteHome), { recursive: true, force: true }).catch(() => {})
    await rm(fixture, { recursive: true, force: true })
    if (values.report !== undefined) {
      const summary = {
        scope: 'real loopback OpenSSH (unprivileged fixture sshd), no-Node PATH jail on the target side, loopback GLM fixture',
        archive: basename(archive),
        cases,
        passed: cases.every(entry => entry.passed),
      }
      await writeFile(resolve(values.report), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(JSON.stringify({ passed: summary.passed, cases: cases.map(entry => `${entry.passed ? 'ok' : 'FAIL'} ${entry.name}`) }))
    }
  }
}

if (import.meta.main) await main()
