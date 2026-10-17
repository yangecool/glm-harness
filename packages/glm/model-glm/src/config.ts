/**
 * Plugin configuration and per-request connection snapshot: base URL,
 * credential reference, and the stream idle timeout, resolved together from
 * one configuration generation.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { EMPTY_RESPONSE_CODE, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { GLM_STREAM_CLOSED_CODE } from './transport.ts'

/** Public default endpoint (BigModel); Z.AI deployments override baseURL. */
export const PUBLIC_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
/** Environment variable consulted when config leaves the base URL empty. */
export const BASE_URL_ENV = 'GLM_BASE_URL'
/** Idle ceiling for one stream between frames. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000
/** Deadline for credentials, response headers, and an HTTP error body. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * The GLM route's default retry policy: bounded transient retries with the
 * route's stream-close code added. Authentication, quota, request-shape, and
 * truncation failures stay terminal — a truncated tool batch or a bad key
 * does not heal by resending the same bytes.
 */
export const GLM_DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: [EMPTY_RESPONSE_CODE, 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', GLM_STREAM_CLOSED_CODE],
}

/** Live plugin configuration. */
export interface Config {
  /** Chat-completions root; empty reads GLM_BASE_URL or the public BigModel default. */
  baseURL: Volatile<string>
  /** Credentials-service reference or launch-environment variable containing the bearer key. */
  apiKeyEnv: Volatile<string>
  /** Maximum idle milliseconds while waiting for streamed provider progress. */
  streamIdleTimeoutMs: Volatile<number>
  /** Maximum milliseconds for credential lookup, response headers, and an HTTP error body. */
  requestTimeoutMs: Volatile<number>
  /** Model-request retry policy captured with each connection generation. */
  retryPolicy: Volatile<RetryPolicyConfig | undefined>
}

export const Config = z.object({
  baseURL: z.string().role('url').default('').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('GLM_API_KEY').volatile(),
  streamIdleTimeoutMs: z.number().default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  requestTimeoutMs: z.number().default(DEFAULT_REQUEST_TIMEOUT_MS).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
})

/** Plain deployment inputs, detached from live configuration. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never }

/** Read one validated provider configuration.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export function plainOptions(config: Config): Options {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
}

/** One validated connection generation shared by capability answers and dispatch. */
export interface GlmConnectionOptions {
  /** Chat-completions root, no trailing slash. */
  readonly baseURL: string
  /** Credential reference resolved per request. */
  readonly apiKeyEnv: CredentialRef
  readonly streamIdleTimeoutMs: number
  readonly requestTimeoutMs: number
  /** Bounded retry policy exposed to the retry executor for this route. */
  readonly retryPolicy: ResolvedRetryPolicy
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
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(idle) || idle <= 0) {
    throw new TypeError('streamIdleTimeoutMs must be a positive number of milliseconds')
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError('requestTimeoutMs must be a positive number of milliseconds')
  }
  return {
    baseURL: validatedBaseUrl(rawBase),
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? 'GLM_API_KEY'),
    streamIdleTimeoutMs: idle,
    requestTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy ?? GLM_DEFAULT_RETRY_POLICY, 'model-glm: retryPolicy'),
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

/** Chat-completions endpoint of one base URL.
 * @param baseURL - validated chat-completions root.
 * @returns absolute request URL.
 */
export function chatCompletionsUrl(baseURL: string): string {
  return `${baseURL}/chat/completions`
}
