import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  productPinnedHome, resolveProductProfile, seedProductHomeProfiles, UPSTREAM_PRODUCT_PROFILE,
} from '../src/product-profile.ts'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-product-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('product profile resolution', () => {
  it('falls back to the upstream composition when no metadata ships', () => {
    const root = temporaryRoot()
    expect(resolveProductProfile(join(root, 'runtime'))).toEqual(UPSTREAM_PRODUCT_PROFILE)
  })

  it('reads the metadata beside the runtime descriptor', () => {
    const root = temporaryRoot()
    const runtime = join(root, 'runtime')
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'product-profile.json'), JSON.stringify({
      productName: 'GLM Harness',
      homeDirName: '.glmh',
      bundles: ['@glm-harness/gh-base', '@glm-harness/gh-desktop'],
      profilePatch: '- id: system-prompt\n',
      homeProfiles: { 'gh-supervisor': { bundles: ['@glm-harness/gh-remote-supervisor-app'], patch: '' } },
    }))
    const product = resolveProductProfile(runtime)
    expect(product.productName).toBe('GLM Harness')
    expect(product.bundles).toEqual(['@glm-harness/gh-base', '@glm-harness/gh-desktop'])
    expect(product.homeProfiles['gh-supervisor']?.bundles).toEqual(['@glm-harness/gh-remote-supervisor-app'])
  })

  it('prefers the $DSH_DESKTOP_PRODUCT_PROFILE override over the runtime copy', () => {
    const root = temporaryRoot()
    const runtime = join(root, 'runtime')
    mkdirSync(runtime, { recursive: true })
    const override = join(root, 'override.json')
    writeFileSync(join(runtime, 'product-profile.json'), JSON.stringify({ bundles: ['runtime-side'] }))
    writeFileSync(override, JSON.stringify({ productName: 'override', bundles: ['override-side'] }))
    const product = resolveProductProfile(runtime, { DSH_DESKTOP_PRODUCT_PROFILE: override })
    expect(product.productName).toBe('override')
    expect(product.bundles).toEqual(['override-side'])
  })

  it('refuses malformed metadata loudly instead of booting a guessed composition', () => {
    const root = temporaryRoot()
    const override = join(root, 'broken.json')
    for (const document of [{ bundles: [] }, { bundles: ['ok', 'has space'] }, { homeDirName: 'a/b' }, { homeProfiles: { 'x/..': { bundles: ['a'] } } }]) {
      writeFileSync(override, JSON.stringify(document))
      expect(() => resolveProductProfile(join(root, 'runtime'), { DSH_DESKTOP_PRODUCT_PROFILE: override })).toThrow(/broken\.json: .*must/)
    }
  })
})

describe('product home pinning', () => {
  it('pins the product home only when the user has not set $DSH_HOME', () => {
    const product = { ...UPSTREAM_PRODUCT_PROFILE, homeDirName: '.glmh' }
    expect(productPinnedHome(product, {})).toMatch(/\.glmh$/u)
    expect(productPinnedHome(product, { DSH_HOME: '/custom' })).toBeUndefined()
    expect(productPinnedHome(product, { DSH_HOME: '  ' })).toMatch(/\.glmh$/u)
    expect(productPinnedHome(UPSTREAM_PRODUCT_PROFILE, {})).toBeUndefined()
  })
})

describe('product home profile seeding', () => {
  it('seeds bundles and the product patch, preserving user edits on re-runs', () => {
    const root = temporaryRoot()
    const product = {
      ...UPSTREAM_PRODUCT_PROFILE,
      homeProfiles: { 'gh-web': { bundles: ['@glm-harness/gh-base'], patch: '- id: system-prompt\n' } },
    }
    expect(seedProductHomeProfiles(root, product)).toEqual(['gh-web'])
    const profile = join(root, 'profiles', 'gh-web')
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['@glm-harness/gh-base'])
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('- id: system-prompt')
    writeFileSync(join(profile, 'cordis.patch.yml'), '# user edits\n[]\n')
    seedProductHomeProfiles(root, product)
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('# user edits\n[]\n')
  })
})
