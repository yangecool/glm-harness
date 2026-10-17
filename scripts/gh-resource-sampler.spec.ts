import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ files: new Map<string, string>(), entries: [] as string[] }))
vi.mock('node:fs', () => ({
  readdirSync: () => fixture.entries,
  readFileSync: (path: string) => {
    const value = fixture.files.get(path)
    if (value === undefined) throw Object.assign(new Error('process exited'), { code: 'ENOENT' })
    return value
  },
}))

import { sampleTree } from '../benchmarks/glm/proc-tree-sampler.ts'

function seedProcess(pid: number, parent: number, memory: number): void {
  fixture.entries.push(String(pid))
  fixture.files.set(`/proc/${pid}/stat`, `${pid} (fixture) S ${parent} 0 0`)
  fixture.files.set(`/proc/${pid}/smaps_rollup`,
    `Rss: ${memory} kB\nPss: ${memory} kB\nPrivate_Clean: 0 kB\nPrivate_Dirty: ${memory} kB\nSwap: 0 kB\n`)
}

beforeEach(() => {
  fixture.files.clear()
  fixture.entries = ['self', 'thread-self', '9not-a-pid']
})

describe('GH process-tree sampling', () => {
  it('includes descendants whose multi-digit pid starts with nine', () => {
    seedProcess(120, 1, 10)
    seedProcess(901, 120, 20)
    seedProcess(9101, 901, 30)
    seedProcess(88, 1, 100)
    const { tick, rows } = sampleTree(120)
    expect(tick.pids).toEqual([120, 901, 9101])
    expect(rows.map(row => row.pid).sort((a, b) => a - b)).toEqual([120, 901, 9101])
    expect(tick.pssKb).toBe(60)
  })

  it('does not count another process or a descendant that exits during sampling', () => {
    seedProcess(901, 1, 10)
    seedProcess(99, 901, 20)
    seedProcess(98, 1, 100)
    fixture.files.delete('/proc/99/smaps_rollup')
    const { tick, rows } = sampleTree(901)
    expect(tick.pssKb).toBe(10)
    expect(rows.map(row => row.pid)).toEqual([901])
  })
})
