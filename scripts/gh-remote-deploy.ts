/**
 * Controller CLI for GH remote deployment: save, list, and remove SSH
 * targets; deploy a runtime archive; run or manage the installed runner.
 *
 * Examples:
 *   node --import tsx/esm scripts/gh-remote-deploy.ts --save-as lab --host 192.168.1.5 --port 22 --user dev --identity ~/.ssh/id_ed25519
 *   node --import tsx/esm scripts/gh-remote-deploy.ts --list
 *   node --import tsx/esm scripts/gh-remote-deploy.ts --target lab --archive <archive.tar.gz> --trust-fingerprint
 *   node --import tsx/esm scripts/gh-remote-deploy.ts --target lab --status
 *   node --import tsx/esm scripts/gh-remote-deploy.ts --target lab --start   # supervised resident service
 */
import { basename } from 'node:path'
import { resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline'
import { bootstrapLifecycle, deployRuntime, ensureHostKey } from './gh-remote/deploy.ts'
import { loadTargets, remoteTargetSchema, removeTarget, resolveTarget, upsertTarget, defaultTargetStore } from './gh-remote/targets.ts'

async function confirmFingerprint(fingerprint: string): Promise<boolean> {
  console.log(`gh-remote: new host fingerprint: ${fingerprint}`)
  const interface_ = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<boolean>((resolveAnswer) => {
      interface_.question('type the full fingerprint line again to pin: ', (answer) => {
        resolveAnswer(answer.trim().length > 0 && fingerprint.includes(answer.trim()))
      })
    })
  } finally {
    interface_.close()
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    'save-as': { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, user: { type: 'string' },
    identity: { type: 'string' }, 'ssh-config-alias': { type: 'string' }, 'proxy-jump': { type: 'string' },
    list: { type: 'boolean' }, remove: { type: 'string' },
    target: { type: 'string' }, archive: { type: 'string' }, home: { type: 'string' },
    'trust-fingerprint': { type: 'boolean' }, 'known-hosts': { type: 'string' },
    status: { type: 'boolean' }, run: { type: 'boolean' }, start: { type: 'boolean' }, stop: { type: 'boolean' }, rollback: { type: 'boolean' },
    'set-env': { type: 'string', multiple: true },
  }, allowPositionals: true, tokens: true })
  const store = process.env.GH_REMOTE_TARGETS ?? defaultTargetStore()

  if (values.list === true) {
    const saved = await loadTargets(store)
    for (const entry of saved.targets) {
      console.log(`${entry.name}\t${entry.sshConfigAlias ?? `${entry.user !== undefined ? `${entry.user}@` : ''}${entry.host}:${entry.port}`}${entry.identity !== undefined ? `\tkey=${entry.identity}` : ''}`)
    }
    return
  }
  if (values.remove !== undefined) {
    console.log(await removeTarget(values.remove, store) ? `removed ${values.remove}` : `no target named ${values.remove}`)
    return
  }
  if (values['save-as'] !== undefined) {
    if (values.host === undefined) throw new Error('--save-as requires --host')
    const record = remoteTargetSchema.parse({
      name: values['save-as'], host: values.host,
      ...(values.port === undefined ? {} : { port: Number.parseInt(values.port, 10) }),
      ...(values.user === undefined ? {} : { user: values.user }),
      ...(values.identity === undefined ? {} : { identity: resolve(values.identity) }),
      ...(values['ssh-config-alias'] === undefined ? {} : { sshConfigAlias: values['ssh-config-alias'] }),
      ...(values['proxy-jump'] === undefined ? {} : { proxyJump: values['proxy-jump'] }),
    })
    await upsertTarget(record, store)
    console.log(`saved ${record.name} -> ${record.sshConfigAlias ?? `${record.host}:${record.port}`}`)
    return
  }
  if (values.target === undefined) throw new Error('pass --target <saved-name | user@host[:port]> (or --list/--save-as/--remove)')
  const target = await resolveTarget(values.target, store)

  const knownHosts = values['known-hosts'] ?? join(process.env.HOME ?? '.', '.glmh', 'known_hosts')
  const home = values.home ?? '.glmh-remote'

  if (values.archive !== undefined) {
    const record = await deployRuntime(target, {
      archive: resolve(values.archive), home, knownHosts,
      trustFingerprint: values['trust-fingerprint'] === true,
      ...(values['trust-fingerprint'] === true ? {} : { confirmFingerprint }),
    })
    console.log(`deployed ${basename(values.archive)} to ${record.target} (fingerprint ${record.fingerprintPinned ? 'newly pinned' : 'already pinned'})`)
    console.log(record.releaseSummary)
    return
  }
  if (values.status === true) {
    console.log(await bootstrapLifecycle(target, knownHosts, home, 'status', [], 60_000))
    return
  }
  if (values.stop === true) {
    console.log(await bootstrapLifecycle(target, knownHosts, home, 'stop', [], 60_000))
    return
  }
  if (values.rollback === true) {
    console.log(await bootstrapLifecycle(target, knownHosts, home, 'rollback', [], 120_000))
    return
  }
  if (values.run === true || values.start === true) {
    // The unified bootstrap runs the gh-supervisor profile only; the resident
    // service it supervises is the product surface (prompts go over its RPC).
    const envAssignments = values['set-env'] ?? []
    if (values.start === true) {
      const output = await bootstrapLifecycle(target, knownHosts, home, 'start', [], 3_600_000, envAssignments)
      console.log(output.trim())
      return
    }
    const output = await bootstrapLifecycle(target, knownHosts, home, 'run', [], 3_600_000, envAssignments)
    console.log(output.trim())
    return
  }
  // No action given: show what a bare target resolves to after a host-key check.
  const scratch = await mkdtemp(join(tmpdir(), 'gh-remote-kh-'))
  try {
    await writeFile(join(scratch, 'known_hosts'), '')
    const pinned = await ensureHostKey(target, join(scratch, 'known_hosts'), { trustFingerprint: false, confirmFingerprint })
    console.log(`target ${values.target} reachable (pinned=${pinned})`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
