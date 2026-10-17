import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkComposedProfiles, checkDependencyClosure } from './check-gh-closure.ts'
import { readWorkspaceManifests } from './check-workspace-constraints.ts'

const root = resolve(import.meta.dirname, '..')

describe('GH model implementation closure', () => {
  it('keeps every actual GH profile and product dependency free of upstream retry code', () => {
    expect(checkDependencyClosure(readWorkspaceManifests(root))).toEqual([])
    expect(checkComposedProfiles()).toEqual([])
  })

  it('rejects an upstream model or retry implementation hidden behind a product dependency', () => {
    for (const implementation of ['@deepseek-ai/dsh-llm-retry', '@deepseek-ai/dsh-llm-deepseek']) {
      const manifests = readWorkspaceManifests(root).map(entry => entry.manifest.name !== '@glm-harness/gh-model-glm'
        ? entry
        : {
          ...entry,
          manifest: {
            ...entry.manifest,
            dependencies: { ...entry.manifest.dependencies, [implementation]: 'workspace:*' },
          },
        })
      expect(checkDependencyClosure(manifests))
        .toContain(`@glm-harness dependency closure includes banned ${implementation}`)
    }
  })
})
