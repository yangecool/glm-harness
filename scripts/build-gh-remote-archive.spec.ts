/** Archive variant input must not escape the selected output directory. */
import { expect, it } from 'vitest'
import { buildGhRemoteArchive } from './build-gh-remote-archive.ts'

it.each(['../outside', '/tmp/outside', '', 'part/name', 'a'.repeat(65)])('rejects unsafe variant %j before staging', async (variant) => {
  await expect(buildGhRemoteArchive(['--variant', variant])).rejects.toThrow('one safe filename segment')
})
