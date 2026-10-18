/** GH previews build without release credentials; tag publication has an explicit repository. */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Workflow {
  on: { push: { branches: string[]; tags: string[] }; workflow_dispatch: unknown }
  env?: Record<string, string>
  jobs: Record<string, {
    'runs-on': string
    env?: Record<string, string>
    steps?: Array<{ uses?: string; run?: string; if?: string; env?: Record<string, string> }>
  }>
}

describe('GH hosted builds', () => {
  it.each(['gh-windows-x64.yml', 'gh-remote-release.yml'])('%s retains main previews and only publishes tags', (file) => {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
    const workflow = yaml.load(source) as Workflow
    expect(workflow.on.push.branches).toContain('main')
    expect(workflow.on.push.tags).toEqual(['gh-v*'])
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.run?.includes('gh release')) continue
        expect(job.env?.GH_REPO ?? workflow.env?.GH_REPO).toBe('${{ github.repository }}')
        if (step.run.includes('gh release upload')) {
          expect(step.if).toBe("startsWith(github.ref, 'refs/tags/gh-v')")
          expect(step.run).toContain('--verify-tag')
        }
      }
    }
    if (file === 'gh-windows-x64.yml') {
      expect(source).toContain('shell: pwsh')
      expect(source).toContain('--standalone --app-id')
    } else {
      expect(source).toContain('node --import tsx/esm scripts/build-gh-remote-archive.ts')
    }
  })
})
