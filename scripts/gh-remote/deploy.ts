/**
 * Controller-side deployment orchestration for GH remote runtimes over real
 * OpenSSH: TOFU host-key pinning, probing, upload, stage-localized install,
 * runner lifecycle, and rollback. Connection details delegate to the system
 * ssh/scp binaries; no credentials beyond key-file paths ever appear here.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'
import { StageError, probeRemote, sshArguments, sshCapture, type RemoteProbe } from './probe.ts'
import { BOOTSTRAP_STAGE_CODES } from './bootstrap.ts'
import { artifactManifestSchema, fileDigest, type ArtifactManifest } from './artifact.ts'
import type { RemoteTarget } from './targets.ts'

const run = promisify(execFile)

/** Options one deployment accepts. */
export interface DeployOptions {
  /** Local archive path; a `<archive>.sha256` sidecar must sit beside it. */
  archive: string
  /** Remote install root (GH_REMOTE_HOME); defaults to the target user's ~/.glmh-remote. */
  home?: string
  /** known_hosts file under the controller's control; TOFU pins land here. */
  knownHosts: string
  /** Trust and pin a not-yet-known host key without prompting. */
  trustFingerprint?: boolean
  /** Interactive fallback when a new fingerprint appears and trustFingerprint is unset. */
  confirmFingerprint?: (fingerprint: string) => boolean | Promise<boolean>
  /** Extra `KEY=value` assignments prepended to remote install commands. */
  envAssignments?: readonly string[]
}

/** Record of one completed deployment exchange. */
export interface DeployRecord {
  target: string
  fingerprintPinned: boolean
  probe: RemoteProbe
  manifest: { version: string; commit: string; target: string; nodeVersion: string; files: number }
  installLog: string
  remoteHome: string
  releaseSummary: string
}

const stageByCode = new Map<number, string>(Object.entries(BOOTSTRAP_STAGE_CODES).map(([stage, code]) => [code, stage]))

function controlOptions(knownHosts: string): string[] {
  return ['-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15']
}

/** Expand a remote home reference: absolute paths stay, relative ones sit under the target user's $HOME. */
function remoteHomeLiteral(home: string): string {
  return home.startsWith('/') ? home : `"$HOME/${home}"`
}

/** The shell-quoted upload area inside a remote home. */
function uploadLiteral(home: string): string {
  return home.startsWith('/') ? `"${home}/upload"` : `"$HOME/${home}/upload"`
}

/**
 * Pin a not-yet-known host key after showing its fingerprint (R02 TOFU).
 * @param target - target to scan.
 * @param knownHosts - controller-owned known_hosts path.
 * @param options - trust decision inputs.
 * @returns whether a new key was pinned; a changed key on a known host rejects at connect time.
 */
export async function ensureHostKey(target: RemoteTarget, knownHosts: string, options: Pick<DeployOptions, 'trustFingerprint' | 'confirmFingerprint'> = {}): Promise<boolean> {
  if (!existsSync(knownHosts)) await writeFile(knownHosts, '')
  const existing = await readFile(knownHosts, 'utf8')
  const hostToken = target.sshConfigAlias ?? (target.port === 22 ? target.host : `[${target.host}]:${target.port}`)
  if (existing.includes(`${hostToken} `)) return false
  const scanArgs = target.sshConfigAlias !== undefined ? [target.sshConfigAlias] : ['-p', String(target.port), '-t', 'ed25519', '-T', '20', target.host]
  let scanned: string
  try {
    scanned = (await run('ssh-keyscan', [...scanArgs], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout
  } catch (error) {
    throw new StageError('connect', `ssh-keyscan failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const keys = scanned.split('\n').filter(line => line.trim().length > 0)
  if (keys.length === 0) throw new StageError('connect', `ssh-keyscan returned no keys for ${hostToken}`)
  const preferred = keys.find(line => line.includes('ssh-ed25519')) ?? keys[0]
  const temporary = await mkdtemp(join(tmpdir(), 'gh-remote-key-'))
  try {
    const keyFile = join(temporary, 'host-key')
    await writeFile(keyFile, `${preferred}\n`)
    let fingerprint: string
    try {
      fingerprint = (await run('ssh-keygen', ['-lf', keyFile], { timeout: 15_000 })).stdout.trim()
    } catch (error) {
      throw new StageError('connect', `fingerprint parsing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const trusted = options.trustFingerprint === true
      || (options.trustFingerprint !== false && options.confirmFingerprint !== undefined
        ? await options.confirmFingerprint(fingerprint)
        : false)
    if (!trusted) throw new StageError('connect', `new host fingerprint for ${hostToken}: ${fingerprint}; pass trustFingerprint or confirm to pin`)
    await appendFile(knownHosts, keys.join('\n') + '\n')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return true
}

/**
 * Verify the local archive and sidecar before anything leaves the controller.
 * @param archive - archive path.
 * @returns the archive digest matched against its sidecar.
 */
export async function verifyLocalArchive(archive: string): Promise<string> {
  if (!existsSync(archive)) throw new StageError('verify-archive', `archive not found: ${archive}`)
  if (!existsSync(`${archive}.sha256`)) throw new StageError('verify-archive', `missing sidecar ${archive}.sha256`)
  const expected = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s/)[0]
  const actual = await fileDigest(archive)
  if (actual !== expected) throw new StageError('verify-archive', `local archive digest mismatch (expected ${expected}, got ${actual})`)
  return actual
}

/**
 * Read the manifest embedded in a local archive without unpacking it.
 * @param archive - archive path.
 * @returns parsed manifest.
 */
export async function readArchiveManifest(archive: string): Promise<ArtifactManifest> {
  const { stdout } = await run('tar', ['-xzf', archive, '-O', 'gh-remote/manifest.json'], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  return artifactManifestSchema.parse(JSON.parse(stdout))
}

/**
 * Run one bootstrap command on the target and map its stage exit code.
 * @param target - deployed target.
 * @param knownHosts - controller-owned known_hosts path.
 * @param home - remote install root expression.
 * @param script - shell lines to run; set `home` the way `remoteHomeLiteral` renders it.
 * @param timeoutMs - hard deadline.
 * @returns captured stdout.
 */
export async function remoteCommand(target: RemoteTarget, knownHosts: string, script: string, timeoutMs: number): Promise<string> {
  const argv = [...sshArguments(target), ...controlOptions(knownHosts), '--', 'sh']
  try {
    return await sshCapture(argv, script, timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const codeMatch = /ssh exited (\d+)/.exec(message)
    if (codeMatch !== null) {
      const stage = stageByCode.get(Number.parseInt(codeMatch[1] as string, 10))
      if (stage !== undefined) throw new StageError(stage, message)
    }
    throw new StageError('runner', message)
  }
}

/**
 * Deploy one archive to a target: pin the host key if needed, probe, upload,
 * install under the bootstrap's lock, and report what became active.
 * @param target - connection target.
 * @param options - deployment options.
 * @returns the completed deployment record.
 */
export async function deployRuntime(target: RemoteTarget, options: DeployOptions): Promise<DeployRecord> {
  const fingerprintPinned = await ensureHostKey(target, options.knownHosts, options)
  await verifyLocalArchive(options.archive)
  const manifest = await readArchiveManifest(options.archive)
  const probe = await probeRemote(target, { knownHosts: options.knownHosts })
  if (probe.target !== manifest.target) {
    throw new StageError('probe', `archive targets ${manifest.target} but ${target.host} probes as ${probe.target}`)
  }
  for (const [tool, present] of Object.entries(probe.tools)) {
    if (!present) throw new StageError('probe', `${target.host} lacks required tool ${tool}`)
  }
  const home = options.home ?? '.glmh-remote'
  const homeLiteral = remoteHomeLiteral(home)
  const upload = uploadLiteral(home)
  const archiveName = basename(options.archive)
  await remoteCommand(target, options.knownHosts, `mkdir -p ${upload}`, 30_000)
  const scpDestination = `${target.user !== undefined ? `${target.user}@` : ''}${target.host}:${home.startsWith('/') ? `${home}/upload/` : `./${home}/upload/`}`
  await run('scp', [
    '-P', String(target.port),
    '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${options.knownHosts}`, '-o', 'StrictHostKeyChecking=yes',
    ...(target.identity === undefined ? [] : ['-i', target.identity]),
    options.archive, `${options.archive}.sha256`, scpDestination,
  ], { timeout: 600_000 })
  const envPrefix = (options.envAssignments ?? []).join(' ')
  const installLog = await remoteCommand(target, options.knownHosts, [
    `cd ${upload}`,
    `tar -xzf '${archiveName}' --strip-components=1 gh-remote/bootstrap.sh`,
    `${envPrefix === '' ? '' : `${envPrefix} `}GH_REMOTE_HOME=${homeLiteral} sh ./bootstrap.sh install './${archiveName}' --force`,
  ].join('\n'), 1_200_000)
  const status = await bootstrapLifecycle(target, options.knownHosts, home, 'status', [], 60_000)
  return {
    target: target.sshConfigAlias ?? `${target.user !== undefined ? `${target.user}@` : ''}${target.host}:${target.port}`,
    fingerprintPinned,
    probe,
    manifest: {
      version: manifest.version, commit: manifest.commit, target: manifest.target,
      nodeVersion: manifest.nodeVersion, files: manifest.files.length,
    },
    installLog: installLog.trim(),
    remoteHome: home,
    releaseSummary: status.trim(),
  }
}

/**
 * Invoke an installed bootstrap's lifecycle command (run/start/stop/status/rollback).
 * @param target - deployed target.
 * @param knownHosts - controller-owned known_hosts path.
 * @param home - remote install root.
 * @param command - bootstrap subcommand.
 * @param args - literal extra arguments.
 * @param timeoutMs - hard deadline.
 * @param envAssignments - `KEY=value` assignments prepended for run/start.
 * @returns captured stdout.
 */
export async function bootstrapLifecycle(
  target: RemoteTarget, knownHosts: string, home: string, command: string,
  args: readonly string[], timeoutMs: number, envAssignments: readonly string[] = [],
): Promise<string> {
  const homeLiteral = remoteHomeLiteral(home)
  const bootstrap = home.startsWith('/') ? `"${home}/upload/bootstrap.sh"` : `"$HOME/${home}/upload/bootstrap.sh"`
  const prefix = envAssignments.length === 0 ? '' : `${envAssignments.join(' ')} `
  return remoteCommand(target, knownHosts, `GH_REMOTE_HOME=${homeLiteral} ${prefix}sh ${bootstrap} ${command} ${args.join(' ')}`, timeoutMs)
}
