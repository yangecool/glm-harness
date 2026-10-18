/**
 * The short-term project-token owner: request-level PAT resolution over the
 * account owner's access tokens. One PAT per domain+project is cached until
 * its expiry margin or the account generation moves — whichever comes first,
 * so a logout stops authorizing immediately; every physical model attempt
 * re-resolves, a rejected PAT is dropped the moment the transport reports it,
 * and the next attempt mints a fresh one — a rejected credential is never
 * reused.
 *
 * @module @glm-harness/gh-account/pat
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { GhAccountDomain } from './types.ts'
import { GhAccountFailure } from './service.ts'

/** Seconds before PAT expiry at which a re-mint is due. */
const PAT_MARGIN_MS = 30_000

/** One cached PAT. */
interface PatEntry {
  /** The minted token; never logged, never journaled, never snapshotted. */
  token: string
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number
  /** The project the token was minted for. */
  projectId: string
  /** The account generation the mint ran under; a later login or logout supersedes it. */
  epoch: number
}

/** The token-endpoint PAT grant's failure. */
export class PatRejection extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ghProjectToken: GhProjectTokenService
  }
}

/**
 * The PAT owner. Composed wherever the account owner is; the GLM route
 * consults it before the static key path.
 */
export class GhProjectTokenService extends Service {
  static inject = ['ghAccount']

  private readonly cache = new Map<GhAccountDomain, PatEntry>()
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  /** Mint counter for surfaces; deliberately carries no token material. */
  private mints = 0

  constructor(ctx: Context) {
    super(ctx, 'ghProjectToken')
    ctx.effect(() => async () => {
      this.lifetime.abort(new GhAccountFailure('gh-account/unavailable', 'the project-token service was unloaded'))
      await Promise.allSettled([...this.operations])
      this.cache.clear()
    })
  }

  /**
   * Total mints served since process start.
   * @returns the mint counter; deliberately carries no token material.
   */
  mintCount(): number {
    return this.mints
  }

  /**
   * Resolve one request-scoped PAT, minting or re-minting as due.
   * @param domain - the account domain the project belongs to.
   * @param projectId - the personal or team project key id.
   * @param signal - the caller's per-attempt cancellation.
   * @returns the bearer token for exactly one physical request.
   */
  async resolvePat(domain: GhAccountDomain, projectId: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const account = this.ctx.ghAccount
    await account.hydrated
    signal?.throwIfAborted()
    const epoch = account.epochOf(domain)
    const cached = this.cache.get(domain)
    if (cached !== undefined && cached.projectId === projectId && cached.expiresAt - PAT_MARGIN_MS > Date.now()
      // A login or logout since the mint supersedes the cached PAT: logout
      // must stop authorizing immediately, not at the token's expiry.
      && cached.epoch === epoch) {
      return cached.token
    }
    const operation = this.mint(domain, projectId, epoch, signal)
    this.operations.add(operation)
    try { return await operation } finally { this.operations.delete(operation) }
  }

  /** Mint under one account generation and discard every superseded result. */
  private async mint(domain: GhAccountDomain, projectId: string, epoch: number, caller?: AbortSignal): Promise<string> {
    const account = this.ctx.ghAccount
    const config = account.domainConfigOf(domain)
    const signal = AbortSignal.any([
      this.lifetime.signal, AbortSignal.timeout(config.requestTimeoutMs), ...caller === undefined ? [] : [caller],
    ])
    const accessToken = await account.accessToken(domain, signal)
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${accessToken}` },
      body: new URLSearchParams({
        grant_type: 'urn:glm-harness:pat',
        project_id: projectId,
        client_id: config.clientId,
      }),
    })
    if (!response.ok) throw new PatRejection(response.status, `pat mint rejected with HTTP ${String(response.status)}`)
    let payload: unknown
    try { payload = await response.json() } catch (error) {
      if (error instanceof SyntaxError) throw new PatRejection(0, 'pat mint returned invalid JSON')
      throw error
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new PatRejection(0, 'pat mint response must be an object')
    }
    const body = payload as { access_token?: unknown; expires_in?: unknown }
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new PatRejection(0, 'pat mint response carries no access_token')
    }
    if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0
      || !Number.isFinite(Date.now() + body.expires_in * 1000)) {
      throw new PatRejection(0, 'pat mint response carries no valid expires_in')
    }
    signal.throwIfAborted()
    if (account.epochOf(domain) !== epoch) throw new GhAccountFailure('gh-account/stale-generation', 'the account changed during PAT mint')
    const entry: PatEntry = {
      token: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1_000,
      projectId,
      epoch,
    }
    this.cache.set(domain, entry)
    this.mints += 1
    return entry.token
  }

  /**
   * Drop a rejected PAT. The transport calls this on an authorization
   * rejection carrying the token it used; the next resolution mints fresh.
   * @param token - the token the server rejected.
   */
  rejectPat(token: string): void {
    for (const [domain, entry] of this.cache) {
      if (entry.token === token) this.cache.delete(domain)
    }
  }

  /**
   * Whether a cached PAT is currently valid for the domain+project (surfaces only).
   * @param domain - the account domain.
   * @returns token-free cache facts, or null when nothing valid is cached.
   */
  patFacts(domain: GhAccountDomain): { projectId: string; expiresAt: number; mints: number } | null {
    const cached = this.cache.get(domain)
    if (cached === undefined || cached.expiresAt <= Date.now()) return null
    if (cached.epoch !== this.ctx.ghAccount.epochOf(domain)) return null
    return { projectId: cached.projectId, expiresAt: cached.expiresAt, mints: this.mints }
  }
}
