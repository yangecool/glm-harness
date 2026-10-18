/** Remote host probing over real OpenSSH: OS, architecture, libc, toolchain, disk, and Node absence. */
import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { RemoteTarget } from './targets.ts'
import { BOOTSTRAP_REQUIRED_TOOLS } from './bootstrap.ts'

/**
 * Run one remote shell script over ssh and capture stdout.
 * @param argv - complete ssh argument vector ending in the remote command.
 * @param script - shell source fed to the remote `sh` on stdin.
 * @param timeoutMs - hard deadline for the exchange.
 * @returns remote stdout; rejects with the merged stderr on any failure.
 */
export function sshCapture(argv: readonly string[], script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const fail = (message: string): void => {
      clearTimeout(timer)
      reject(new Error(message))
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => { fail(error.message) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && signal === null) resolve(stdout)
      else fail(`ssh exited ${code ?? signal}${stderr === '' ? '' : `: ${stderr.trim()}`}`)
    })
    child.stdin.end(script)
  })
}

/** Facts one probe collects before any archive is uploaded. */
export const remoteProbeSchema = z.object({
  kernel: z.string(),
  machine: z.string(),
  arch: z.enum(['x64', 'arm64', 'other']),
  target: z.enum(['linux-x64', 'linux-arm64', 'unsupported']),
  libc: z.string(),
  tools: z.record(z.string(), z.boolean()),
  nodeOnTarget: z.boolean(),
  homeFreeKb: z.number().int().nonnegative(),
  getconfLine: z.string(),
}).strict()

/** Parsed probe result. */
export type RemoteProbe = z.infer<typeof remoteProbeSchema>

/** A failure carries the deploy stage it belongs to, mirroring the bootstrap's stage codes. */
export class StageError extends Error {
  constructor(readonly stage: string, message: string) {
    super(`gh-remote: stage=${stage}: ${message}`)
    this.name = 'StageError'
  }
}

/**
 * Build the ssh argument vector for one target, honoring saved delegation fields.
 * @param target - saved or ad-hoc target.
 * @param extra - literal extra arguments appended last.
 * @returns argv for the system ssh binary.
 */
export function sshArguments(target: RemoteTarget, extra: readonly string[] = []): string[] {
  const argv: string[] = []
  if (target.sshConfigAlias !== undefined) {
    argv.push(target.sshConfigAlias)
  } else {
    argv.push('-p', String(target.port))
    if (target.user !== undefined) argv.push(`${target.user}@${target.host}`)
    else argv.push(target.host)
  }
  if (target.proxyJump !== undefined) argv.push('-J', target.proxyJump)
  if (target.identity !== undefined) argv.push('-i', target.identity)
  return [...argv, ...extra]
}

const PROBE_SCRIPT = `set -eu
echo "kernel=$(uname -s)"
echo "machine=$(uname -m)"
echo "getconf=$(getconf GNU_LIBC_VERSION 2>/dev/null || echo none)"
for tool in ${BOOTSTRAP_REQUIRED_TOOLS.join(' ')}; do
  if command -v "$tool" >/dev/null 2>&1; then echo "tool-$tool=yes"; else echo "tool-$tool=no"; fi
done
if command -v node >/dev/null 2>&1; then echo "node=$(command -v node)"; else echo "node=absent"; fi
df -Pk . | awk 'NR == 2 { print "free=" $4 }'
echo "home=$(printf %s "$HOME")"`

/**
 * Probe one target through a real ssh connection.
 * @param target - target to probe.
 * @param options - known_hosts file and connect timeout overrides.
 * @returns collected facts; connection failures reject with a connect StageError.
 */
export async function probeRemote(
  target: RemoteTarget,
  options: { knownHosts?: string; connectTimeoutSeconds?: number } = {},
): Promise<RemoteProbe> {
  const control: string[] = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${options.connectTimeoutSeconds ?? 15}`]
  if (options.knownHosts !== undefined) control.push('-o', `UserKnownHostsFile=${options.knownHosts}`, '-o', 'StrictHostKeyChecking=yes')
  let stdout: string
  try {
    stdout = await sshCapture([...sshArguments(target), ...control, '--', 'sh'], PROBE_SCRIPT, 60_000)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new StageError('connect', detail)
  }
  const fields = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const equals = line.indexOf('=')
    if (equals > 0) fields.set(line.slice(0, equals), line.slice(equals + 1))
  }
  const machine = fields.get('machine') ?? ''
  const arch = machine === 'x86_64' ? 'x64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : 'other'
  const kernel = fields.get('kernel') ?? ''
  return remoteProbeSchema.parse({
    kernel,
    machine,
    arch,
    target: kernel === 'Linux' && (arch === 'x64' || arch === 'arm64') ? `linux-${arch}` : 'unsupported',
    libc: fields.get('getconf') ?? 'none',
    tools: Object.fromEntries(BOOTSTRAP_REQUIRED_TOOLS.map(tool => [tool, fields.get(`tool-${tool}`) === 'yes'])),
    nodeOnTarget: fields.get('node') !== 'absent' && fields.get('node') !== undefined,
    homeFreeKb: Number.parseInt(fields.get('free') ?? '0', 10) || 0,
    getconfLine: fields.get('getconf') ?? 'none',
  })
}
