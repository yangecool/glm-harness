import { expect, it } from 'vitest'
import { remoteTargetSchema } from './targets.ts'
import { remoteProbeSchema, sshArguments } from './probe.ts'
import { StageError } from './probe.ts'

it('composes ssh argument vectors with port, user, identity, and jump delegation', () => {
  const plain = remoteTargetSchema.parse({ name: 't', host: 'h.example', port: 2222, user: 'dev' })
  expect(sshArguments(plain, ['-o', 'x'])).toEqual(['-p', '2222', 'dev@h.example', '-o', 'x'])
  const keyed = remoteTargetSchema.parse({ name: 't', host: 'h.example', port: 22, identity: '/keys/id' })
  expect(sshArguments(keyed)).toEqual(['-p', '22', 'h.example', '-i', '/keys/id'])
  const jumped = remoteTargetSchema.parse({ name: 't', host: 'h.example', port: 22, proxyJump: 'bastion' })
  expect(sshArguments(jumped)).toEqual(['-p', '22', 'h.example', '-J', 'bastion'])
  const aliased = remoteTargetSchema.parse({ name: 't', host: 'ignored', port: 22, sshConfigAlias: 'lab-box' })
  expect(sshArguments(aliased)).toEqual(['lab-box'])
})

it('parses probe stdout into qualified target facts', () => {
  const parsed = remoteProbeSchema.parse({
    kernel: 'Linux', machine: 'x86_64', arch: 'x64', target: 'linux-x64', libc: 'glibc 2.39',
    tools: { tar: true, sha256sum: true, flock: true, awk: true },
    nodeOnTarget: false, homeFreeKb: 1048576, getconfLine: 'glibc 2.39',
  })
  expect(parsed.target).toBe('linux-x64')
  expect(() => remoteProbeSchema.parse({ ...parsed, tools: { tar: 'yes' } })).toThrow()
})

it('carries the failing stage in StageError', () => {
  const error = new StageError('connect', 'refused')
  expect(error.message).toBe('gh-remote: stage=connect: refused')
  expect(error.stage).toBe('connect')
})
