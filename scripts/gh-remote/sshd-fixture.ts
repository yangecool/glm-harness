/** Unprivileged loopback OpenSSH fixture: own host key, own authorized_keys, no PAM, no system state. */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A running fixture sshd bound to a loopback port with a fresh identity. */
export interface FixtureSshd {
  port: number
  identity: string
  fixture: string
  stop: () => Promise<void>
}

const JAIL_TOOLS = ['sh', 'tar', 'sha256sum', 'flock', 'awk', 'find', 'sort', 'mv', 'ln', 'chmod', 'cp', 'cmp', 'sed', 'grep', 'cut', 'cat', 'mkdir', 'rm', 'sleep', 'kill', 'date', 'uname', 'getconf', 'df', 'env', 'basename', 'dirname', 'readlink', 'ls', 'head', 'tail'] as const

/**
 * Start a fixture sshd on a random loopback port with a freshly generated
 * host key and authorized identity; nothing outside the fixture directory is
 * read or written.
 * @returns connection coordinates and a teardown function.
 */
export async function startFixtureSshd(): Promise<FixtureSshd> {
  const fixture = await mkdtemp(join(tmpdir(), 'gh-remote-sshd-'))
  const identity = join(fixture, 'identity')
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', identity])
  const hostKey = join(fixture, 'host_ed25519')
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
  await writeFile(join(fixture, 'authorized_keys'), `${await readFile(`${identity}.pub`, 'utf8')}\n`)
  await chmod(join(fixture, 'authorized_keys'), 0o600)
  await writeFile(join(fixture, 'devnull'), '')
  const port = 22000 + Math.floor(Math.random() * 2000)
  const resolved = await run('bash', ['-lc', 'command -v sshd || echo /usr/sbin/sshd']).then(result => result.stdout.trim().split('\n').at(-1) ?? '')
  if (resolved === '' || !existsSync(resolved)) throw new Error('gh-remote: no sshd binary on this host')
  const child = spawn(resolved, [
    '-D', '-e', '-p', String(port),
    '-h', hostKey,
    '-o', `AuthorizedKeysFile=${join(fixture, 'authorized_keys')}`,
    '-o', 'StrictModes=no', '-o', 'UsePAM=no', '-o', 'PasswordAuthentication=no',
    '-o', `PidFile=${join(fixture, 'sshd.pid')}`,
    '-o', 'ListenAddress=127.0.0.1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let logText = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { logText += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { logText += chunk })
  const ready = Promise.withResolvers<void>()
  const deadline = setTimeout(() => { ready.reject(new Error(`fixture sshd not ready: ${logText.slice(-500)}`)) }, 20_000)
  const poll = setInterval(() => {
    run('ssh', ['-p', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${join(fixture, 'devnull')}`, '-i', identity, `${process.env.USER}@127.0.0.1`, 'true'], { timeout: 5_000 })
      .then(() => { clearInterval(poll); ready.resolve() })
      .catch(() => {})
  }, 400)
  try {
    await ready.promise
  } finally {
    clearTimeout(deadline)
    clearInterval(poll)
  }
  return {
    port,
    identity,
    fixture,
    stop: async () => {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 5_000))])
      await rm(fixture, { recursive: true, force: true })
    },
  }
}

/**
 * Build a PATH jail holding every POSIX tool the bootstrap needs except Node.
 * @param directory - jail directory to populate.
 * @returns the jail directory.
 */
export async function makeNodeJail(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  for (const tool of JAIL_TOOLS) {
    const resolved = await run('bash', ['-lc', `command -v ${tool}`]).then(result => result.stdout.trim()).catch(() => '')
    if (resolved === '') continue
    await copyFile(resolved, join(directory, tool)).catch(() => {})
  }
  return directory
}
