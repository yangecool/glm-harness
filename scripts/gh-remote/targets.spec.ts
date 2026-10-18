import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { loadTargets, remoteTargetSchema, removeTarget, resolveTarget, upsertTarget } from './targets.ts'

async function store(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gh-remote-targets-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return join(root, 'remote-targets.json')
}

it('round-trips upsert, load, and remove', async () => {
  const path = await store()
  const target = remoteTargetSchema.parse({ name: 'desk', host: '192.168.1.5', port: 2222, user: 'dev', identity: '/keys/id_ed25519' })
  await upsertTarget(target, path)
  await expect(loadTargets(path)).resolves.toEqual({ targets: [target] })
  const replaced = remoteTargetSchema.parse({ name: 'desk', host: '192.168.1.6', port: 22 })
  await upsertTarget(replaced, path)
  await expect(loadTargets(path)).resolves.toEqual({ targets: [replaced] })
  expect(await removeTarget('desk', path)).toBe(true)
  expect(await removeTarget('desk', path)).toBe(false)
  await expect(loadTargets(path)).resolves.toEqual({ targets: [] })
})

it('resolves saved names and parses ad-hoc user@host:port references', async () => {
  const path = await store()
  await upsertTarget(remoteTargetSchema.parse({ name: 'lab', host: 'lab.internal', port: 2200, user: 'ci' }), path)
  await expect(resolveTarget('lab', path)).resolves.toMatchObject({ host: 'lab.internal', port: 2200, user: 'ci' })
  await expect(resolveTarget('root@box.example:2222', path)).resolves.toMatchObject({ user: 'root', host: 'box.example', port: 2222 })
  await expect(resolveTarget('plain.example', path)).resolves.toMatchObject({ host: 'plain.example', port: 22 })
  await expect(resolveTarget('missing-name', path)).rejects.toThrow('no saved target')
  await expect(resolveTarget('box:notaport', path)).rejects.toThrow('invalid port')
})

it('rejects records carrying secrets or malformed fields', () => {
  expect(() => remoteTargetSchema.parse({ name: 'Bad Name', host: 'h' })).toThrow()
  expect(() => remoteTargetSchema.parse({ name: 'ok', host: 'h', password: 'hunter2' })).toThrow()
  expect(() => remoteTargetSchema.parse({ name: 'ok', host: 'h', port: 0 })).toThrow()
})
