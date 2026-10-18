/**
 * Client-safe type surface of the GH account owner: the two service domains,
 * the public account snapshot, the OAuth grant's persisted shape, and the
 * short-term project token's cached facts. Nothing here carries a secret.
 *
 * @module @glm-harness/gh-account/types
 */

/** The two GH account service domains; one grant per domain, one epoch per domain. */
export type GhAccountDomain = 'bigmodel' | 'zai'

/** One domain's OAuth endpoints and client identity, resolved from configuration. */
export interface GhAccountDomainConfig {
  /** The domain this configuration serves. */
  domain: GhAccountDomain
  /** RFC 6749 authorization endpoint. */
  authorizeUrl: string
  /** RFC 6749 token endpoint (authorization_code, refresh_token, and the PAT grant). */
  tokenUrl: string
  /** Registered client id. */
  clientId: string
  /** Optional extra scope string sent with the authorization request. */
  scope?: string
  /** Poll interval for the standalone (no local callback) login completion, in milliseconds. */
  pollMs?: number
}

/** The persisted OAuth grant: exactly what the token endpoint issued, nothing derived. */
export interface GhGrantPayload {
  /** The refresh token; rotation replaces it in place under one credentials write. */
  refreshToken: string
  /** The current access token and its absolute expiry epoch in milliseconds. */
  accessToken: string
  accessExpiresAt: number
  /** The stable account identity the issuer reported at login time. */
  accountId: string
  /** The account's plan family as the issuer reported it (display only, never an entitlement fact). */
  plan: string | null
}

/** Public facts about one logged-in account; no token ever appears here. */
export interface GhAccountSnapshot {
  /** The domain the account belongs to. */
  domain: GhAccountDomain
  /** The stable account identity. */
  accountId: string
  /** The plan family reported at login, for display. */
  plan: string | null
  /** Monotonic generation: every login or logout bumps it, and results from an older generation are discarded. */
  epoch: number
  /** When the current access token expires, epoch milliseconds. */
  accessExpiresAt: number
}

/** Why an account operation ended short of success; codes are stable API. */
export type GhAccountErrorCode =
  | 'gh-account/not-logged-in'
  | 'gh-account/stale-generation'
  | 'gh-account/oauth-rejected'
  | 'gh-account/domain-unknown'
  | 'gh-account/login-in-progress'

/** One failed account operation, with the stable code clients switch on. */
export interface GhAccountError {
  readonly code: GhAccountErrorCode
  readonly message: string
}

/** The request that starts one interactive login. */
export interface GhLoginRequest {
  /** The domain to log into. */
  domain: GhAccountDomain
}

/** The state one interactive login returns to the caller. */
export interface GhLoginBegin {
  /** The URL the user (or an automating fixture) opens to authorize. */
  verificationUrl: string
  /** The polling deadline for standalone logins, epoch milliseconds. */
  expiresAt: number
}

/** What a short-term project token resolution reports — never the token itself. */
export interface GhProjectTokenFacts {
  /** The project the token was minted for. */
  projectId: string
  /** When this token stops being valid, epoch milliseconds. */
  expiresAt: number
  /** How many mints served callers since the process started. */
  mints: number
}
