/**
 * PKCE helpers and the two token-endpoint exchanges the account owner speaks.
 * Pure functions over `fetch`; no state, no logging of token material.
 *
 * @module @glm-harness/gh-account/oauth
 */

import { createHash, randomBytes } from 'node:crypto'

/** One RFC 7636 code verifier pair. */
export interface PkcePair {
  /** The verifier kept client-side. */
  codeVerifier: string
  /** The S256 challenge sent with the authorization request. */
  codeChallenge: string
}

/**
 * Generate a fresh PKCE pair.
 * @returns the S256 verifier/challenge pair one authorization round-trip uses.
 */
export function pkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url')
  return { codeVerifier, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url') }
}

/**
 * Opaque state binding one authorization request.
 * @returns the random CSRF token sent with the authorization URL.
 */
export function freshState(): string {
  return randomBytes(16).toString('base64url')
}

/** A successful token-endpoint response; only the fields the owner reads. */
export interface TokenGrant {
  /** The refresh token; absent when the issuer did not rotate it. */
  refreshToken?: string
  /** The access token. */
  accessToken: string
  /** Seconds until the access token expires. */
  expiresInSeconds: number
  /** The stable account identity the issuer reported. */
  accountId: string
  /** The plan family the issuer reported, when it reports one. */
  plan: string | null
}

/** Shape shared by both exchanges' failure reporting. */
export class OAuthRejection extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Parse one token-endpoint document into the fields the owner keeps. */
function parseGrant(payload: unknown): TokenGrant {
  const body = payload as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    account_id?: unknown
    sub?: unknown
    plan?: unknown
  }
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new OAuthRejection(0, 'token endpoint response carries no access_token')
  }
  const accountId = typeof body.account_id === 'string' ? body.account_id
    : typeof body.sub === 'string' ? body.sub
      : ''
  if (accountId === '') throw new OAuthRejection(0, 'token endpoint response carries no account identity')
  const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 3600
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' && body.refresh_token.length > 0 ? { refreshToken: body.refresh_token } : {}),
    expiresInSeconds: expiresIn,
    accountId,
    plan: typeof body.plan === 'string' ? body.plan : null,
  }
}

/**
 * Exchange one authorization code for the first grant.
 * @param tokenUrl - the domain's token endpoint.
 * @param clientId - the registered client id.
 * @param code - the authorization code the issuer redirected with.
 * @param codeVerifier - the PKCE verifier paired with the request's challenge.
 * @param redirectUrl - the redirect URI the authorization request carried.
 * @returns the parsed grant.
 */
export async function exchangeCode(
  tokenUrl: string,
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUrl: string,
): Promise<TokenGrant> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      code_verifier: codeVerifier,
      redirect_uri: redirectUrl,
    }),
  })
  if (!response.ok) throw new OAuthRejection(response.status, `authorization_code exchange rejected with HTTP ${String(response.status)}`)
  return parseGrant(await response.json())
}

/**
 * Refresh one grant. The issuer may rotate the refresh token; when it does not,
 * the previous one stays authoritative.
 * @param tokenUrl - the domain's token endpoint.
 * @param clientId - the registered client id.
 * @param refreshToken - the grant's current refresh token.
 * @returns the parsed grant, carrying the rotated refresh token when the issuer rotated it.
 */
export async function exchangeRefresh(
  tokenUrl: string,
  clientId: string,
  refreshToken: string,
): Promise<TokenGrant> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  })
  if (!response.ok) throw new OAuthRejection(response.status, `refresh_token exchange rejected with HTTP ${String(response.status)}`)
  return parseGrant(await response.json())
}
