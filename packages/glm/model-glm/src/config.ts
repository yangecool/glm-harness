/**
 * Plugin configuration and per-request connection snapshot: base URL,
 * credential reference, and the stream idle timeout, resolved together from
 * one configuration generation.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

/** Public default endpoint (BigModel); Z.AI deployments override baseURL. */
export const PUBLIC_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
/** Environment variable consulted when config leaves the base URL empty. */
export const BASE_URL_ENV = 'GLM_BASE_URL'
/** Idle ceiling for one stream between frames. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000

/** Live plugin configuration. */
export interface Config {
  baseURL: Volatile<string>
  apiKeyEnv: Volatile<string>
  streamIdleTimeoutMs: Volatile<number>
}

export const Config = z.object({
  baseURL: z.string().role('url').default('').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('GLM_API_KEY').volatile(),
  streamIdleTimeoutMs: z.number().default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
})

/** Plain deployment inputs, detached from live configuration. */
export type Options = {
  baseURL?: string
  apiKeyEnv?: string
  streamIdleTimeoutMs?: number
}

/** One validated connection generation shared by capability answers and dispatch. */
export interface GlmConnectionOptions {
  /** Chat-completions root, no trailing slash. */
  readonly baseURL: string
  /** Credential reference resolved per request. */
  readonly apiKeyEnv: CredentialRef
  readonly streamIdleTimeoutMs: number
}

/** Read one validated provider configuration.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export function plainOptions(config: Config): Options {
  return {
    baseURL: config.baseURL.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs.get(),
  }
}

/** Resolve endpoint and credential reference together.
 * @param config - raw deployment settings.
 * @param environment - application launch environment.
 * @returns validated endpoint facts and the matching credential reference.
 */
export function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot): GlmConnectionOptions {
  // The schema default is the empty string so deployments can leave the field
  // unset; '' means "not configured", not "an endpoint to validate".
  const configured = config.baseURL !== undefined && config.baseURL.trim() !== '' ? config.baseURL : undefined
  const rawBase = configured
    ?? (environment?.get(credentialRef(BASE_URL_ENV))?.value)
    ?? PUBLIC_BASE_URL
  const idle = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(idle) || idle <= 0) {
    throw new TypeError('streamIdleTimeoutMs must be a positive number of milliseconds')
  }
  return {
    baseURL: validatedBaseUrl(rawBase),
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? 'GLM_API_KEY'),
    streamIdleTimeoutMs: idle,
  }
}

/** Accept an http(s) root without credentials, query, or fragment. */
function validatedBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError(`GLM baseURL must be an absolute http(s) URL, got ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`GLM baseURL must be http(s), got ${JSON.stringify(raw)}`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError(`GLM baseURL must be a bare root (no credentials, query, or fragment), got ${JSON.stringify(raw)}`)
  }
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')}`
}

/** Chat-completions endpoint of one base URL. */
export function chatCompletionsUrl(baseURL: string): string {
  return `${baseURL}/chat/completions`
}
