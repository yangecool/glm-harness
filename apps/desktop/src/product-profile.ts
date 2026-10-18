/**
 * The product-profile seam: optional metadata a distribution ships next to its
 * runtime descriptor, naming the composition the Electron shell boots — the
 * external plugin profile's bundles, the home directory name, first-run home
 * profiles, and the product patch layer — so a product distribution replaces
 * the upstream web composition without any shipped template changing.
 *
 * Resolution order: `$DSH_DESKTOP_PRODUCT_PROFILE` (an absolute path to the
 * metadata; also the verification seam), then `<runtime-dir>/product-profile.json`,
 * then the upstream default, which is byte-for-byte the previous behavior.
 *
 * @module desktop/product-profile
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { applyProfilePatchIfPristine, initProfile, PROFILE_TEMPLATES, type ProfileTemplate } from '@deepseek-ai/dsh-app-boot'

/** The upstream home directory name the stock shell keeps using. */
const UPSTREAM_HOME_DIR_NAME = '.dsh'
/** Env var that points at product metadata; absolute path to a JSON file. */
const PRODUCT_PROFILE_ENV = 'DSH_DESKTOP_PRODUCT_PROFILE'

/** One profile template the product seeds under `<home>/profiles/<name>`. */
export interface ProductHomeProfile {
  /** Bundles the seeded profile installs. */
  readonly bundles: readonly string[]
  /** Product patch layer seeded into the profile while pristine. */
  readonly patch: string
}

/** The product composition a desktop distribution ships. */
export interface ProductProfile {
  /** Product identity for diagnostics and crash reports. */
  readonly productName: string
  /** Bundles the external plugin profile installs; replaces the web tuple. */
  readonly bundles: readonly string[]
  /** Harness home directory under the OS home; `.dsh` keeps the upstream default. */
  readonly homeDirName: string
  /** Profile templates seeded under `<home>/profiles/<name>` on first run. */
  readonly homeProfiles: Readonly<Record<string, ProductHomeProfile>>
  /** Product patch layer seeded into the external profile while pristine. */
  readonly profilePatch: string
}

/** The stock composition: exactly what the shell did before the seam existed. */
export const UPSTREAM_PRODUCT_PROFILE: ProductProfile = {
  productName: 'DeepSeek Harness',
  bundles: [...(PROFILE_TEMPLATES.web as ProfileTemplate).bundles],
  homeDirName: UPSTREAM_HOME_DIR_NAME,
  homeProfiles: {},
  profilePatch: '',
}

/** A valid npm package name a profile may depend on. */
const isBundleName = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !/\s/u.test(value)

/** A single path segment usable as a home directory name. */
const isHomeDirName = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !value.includes('/') && !value.includes('\\')
  && !value.includes('\0') && !value.includes(':') && value !== '.' && value !== '..'

/**
 * Read and validate one product-profile document.
 * @param path - absolute path to the metadata JSON.
 * @param product name the error carries when the document is malformed.
 * @returns the validated profile.
 * @throws Error naming the malformed field; startup must stop loudly rather than boot a guessed composition.
 */
function parseProductProfile(path: string): ProductProfile {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path}: product profile must be a JSON object`)
  const candidate = raw as Record<string, unknown>
  if (candidate.productName !== undefined && typeof candidate.productName !== 'string') {
    throw new Error(`${path}: productName must be a string`)
  }
  if (!Array.isArray(candidate.bundles) || candidate.bundles.length === 0 || !candidate.bundles.every(isBundleName)) {
    throw new Error(`${path}: bundles must be a non-empty array of package names`)
  }
  if (candidate.homeDirName !== undefined && !isHomeDirName(candidate.homeDirName)) {
    throw new Error(`${path}: homeDirName must be one path segment`)
  }
  const homeProfiles: Record<string, ProductHomeProfile> = {}
  if (candidate.homeProfiles !== undefined) {
    if (typeof candidate.homeProfiles !== 'object' || candidate.homeProfiles === null || Array.isArray(candidate.homeProfiles)) {
      throw new Error(`${path}: homeProfiles must be an object of profile templates`)
    }
    for (const [name, entry] of Object.entries(candidate.homeProfiles as Record<string, unknown>)) {
      const invalid = `${path}: homeProfiles.${name} must map to { bundles, patch }`
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(invalid)
      const template = entry as Partial<ProductHomeProfile>
      if (!isHomeDirName(name) || name.toLowerCase() === 'node_modules'
        || !Array.isArray(template.bundles) || template.bundles.length === 0 || !template.bundles.every(isBundleName)
        || (template.patch !== undefined && typeof template.patch !== 'string')) {
        throw new Error(invalid)
      }
      homeProfiles[name] = { bundles: [...template.bundles], patch: template.patch ?? '' }
    }
  }
  if (candidate.profilePatch !== undefined && typeof candidate.profilePatch !== 'string') {
    throw new Error(`${path}: profilePatch must be a string`)
  }
  return {
    productName: candidate.productName ?? 'unnamed product',
    bundles: [...candidate.bundles],
    homeDirName: candidate.homeDirName ?? UPSTREAM_HOME_DIR_NAME,
    homeProfiles,
    profilePatch: candidate.profilePatch ?? '',
  }
}

/**
 * Resolve the active product composition.
 * @param runtimeDir - the runtime descriptor directory (`resources.dsh`).
 * @param env - environment carrying {@link PRODUCT_PROFILE_ENV}; defaults to the process env.
 * @returns the validated product profile, or the upstream default when no metadata ships.
 */
export function resolveProductProfile(
  runtimeDir: string,
  env: Record<string, string | undefined> = process.env,
): ProductProfile {
  const override = env[PRODUCT_PROFILE_ENV]
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) throw new Error(`${PRODUCT_PROFILE_ENV} must name an absolute product-profile path`)
    return parseProductProfile(override)
  }
  const path = join(runtimeDir, 'product-profile.json')
  if (!existsSync(path)) return UPSTREAM_PRODUCT_PROFILE
  return parseProductProfile(path)
}

/**
 * Seed the product's home profiles under `<home>/profiles`.
 * Idempotent by construction — `initProfile` never touches existing files and
 * the patch lands only while pristine — so a user's edits and installed
 * plugins survive every first-run, rebuild, and recovery.
 * @param home - the resolved Harness home.
 * @param product - the active product profile.
 * @returns the seeded profile names.
 */
export function seedProductHomeProfiles(home: string, product: ProductProfile): readonly string[] {
  const seeded: string[] = []
  for (const [name, template] of Object.entries(product.homeProfiles)) {
    const dir = join(home, 'profiles', name)
    initProfile(dir, template.bundles)
    if (template.patch !== '') applyProfilePatchIfPristine(dir, template.patch)
    seeded.push(name)
  }
  return seeded
}

/**
 * The product home, when it differs from the upstream default and the user
 * has not pinned `$DSH_HOME`.
 * @param product - the active product profile.
 * @param env - environment carrying `DSH_HOME`; defaults to the process env.
 * @returns the home path the launcher should pin, or undefined when the
 * upstream resolution already applies.
 */
export function productPinnedHome(
  product: ProductProfile,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = env.DSH_HOME
  if (configured !== undefined && configured.trim() !== '') return undefined
  if (product.homeDirName === UPSTREAM_HOME_DIR_NAME) return undefined
  return join(homedir(), product.homeDirName)
}
