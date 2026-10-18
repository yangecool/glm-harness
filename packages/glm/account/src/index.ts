/**
 * @glm-harness/gh-account — the GH account and project-token owner.
 *
 * Two service domains (bigmodel, zai) own OAuth authorization-code + PKCE
 * logins, single-flight refresh with per-caller cancellation, per-domain
 * account epochs that discard superseded results, and short-term project
 * tokens resolved per physical request with rejection-driven invalidation.
 * Grants persist through the credentials seam's record half; tokens never
 * reach sessions, registries, logs, or any snapshot surface.
 *
 * Endpoints are configuration, not code: production points them at the real
 * services, verification points them at a loopback fixture. No real account
 * is contacted by default and none is required for the rest of the harness to
 * boot — a missing account only fails the operations that need one.
 *
 * @module @glm-harness/gh-account
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GhAccountService } from './service.ts'
import { GhProjectTokenService } from './pat.ts'

export { GhAccountService, GhAccountFailure, GH_ACCOUNT_SCOPE } from './service.ts'
export { GhProjectTokenService, PatRejection } from './pat.ts'
export { exchangeCode, exchangeRefresh, pkcePair, freshState, OAuthRejection } from './oauth.ts'
export type { TokenGrant, PkcePair } from './oauth.ts'
export type {
  GhAccountDomain,
  GhAccountDomainConfig,
  GhAccountSnapshot,
  GhAccountErrorCode,
  GhAccountError,
  GhGrantPayload,
  GhLoginRequest,
  GhLoginBegin,
  GhProjectTokenFacts,
} from './types.ts'

/** One domain row's configuration. */
export interface Config {
  /** The account service domains this instance serves. */
  domains: Array<{
    /** The service domain this row configures. */
    domain: 'bigmodel' | 'zai'
    /** The domain's OAuth authorization endpoint. */
    authorizeUrl: string
    /** The domain's OAuth token endpoint; PATs mint here too. */
    tokenUrl: string
    /** The registered OAuth client id. */
    clientId: string
    /** Extra scopes appended to the authorization request, when the domain needs them. */
    scope?: string
    /** Reserved polling hint in milliseconds; no polling login driver is implemented. */
    pollMs?: number
    /** Deadline for an OAuth or PAT exchange, including the response body. */
    requestTimeoutMs?: number
  }>
}

export const name = 'gh-account'
export const inject = ['credentials']

export function apply(ctx: Context, config: Config): void {
  const domains = config.domains.map(row => ({
    domain: row.domain,
    authorizeUrl: row.authorizeUrl,
    tokenUrl: row.tokenUrl,
    clientId: row.clientId,
    ...(row.scope !== undefined && row.scope !== '' ? { scope: row.scope } : {}),
    ...(row.pollMs !== undefined ? { pollMs: row.pollMs } : {}),
    ...(row.requestTimeoutMs !== undefined ? { requestTimeoutMs: row.requestTimeoutMs } : {}),
  }))
  const account = new GhAccountService(ctx, domains)
  ctx.plugin(GhProjectTokenService)
  void account
}

export const Config = z.object({
  domains: z.array(z.object({
    domain: z.union(['bigmodel', 'zai'] as const).default('bigmodel'),
    authorizeUrl: z.string().default(''),
    tokenUrl: z.string().default(''),
    clientId: z.string().default(''),
    scope: z.string().default(''),
    pollMs: z.number().default(1000),
    requestTimeoutMs: z.number().default(30_000),
  })).default([]),
})
