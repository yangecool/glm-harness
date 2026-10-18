/**
 * The GH account owner: one OAuth grant per service domain, a monotonic epoch
 * per domain that discards results from a superseded login, single-flight
 * token refresh whose cancellation stays per-caller, and durable grant
 * storage through the credentials seam's record half. Tokens never leave this
 * module except as bearer material for the PAT owner; every public surface —
 * snapshot, errors, logs — is token-free.
 *
 * @module @glm-harness/gh-account/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { GhAccountDomain, GhAccountDomainConfig, GhAccountSnapshot, GhGrantPayload } from './types.ts'
import { exchangeCode, exchangeRefresh, freshState, pkcePair, OAuthRejection, type TokenGrant } from './oauth.ts'

/** The credentials scope this owner stores its grants under. */
export const GH_ACCOUNT_SCOPE = 'gh-account'

/** Seconds before expiry at which a refresh is considered due. */
const REFRESH_MARGIN_MS = 60_000

/** One domain's runtime state. */
interface DomainState {
  /** Configuration, resolved once at construction. */
  config: GhAccountDomainConfig & { requestTimeoutMs: number }
  /** The persisted grant, or null while logged out. */
  grant: GhGrantPayload | null
  /** Monotonic generation; bumped by every login and logout. */
  epoch: number
  /** The in-flight refresh shared by every concurrent caller, if any. */
  refresh: Promise<GhGrantPayload> | null
  /** The login awaiting user authorization, if any. */
  pending: { state: string; codeVerifier: string; redirectUrl: string; expiresAt: number; epochAtStart: number; exchanging: boolean } | null
  /** Credential mutations settle in invocation order, including logout deletion. */
  writes: Promise<void>
}

/** Login completion result. */
interface LoginOutcome {
  snapshot: GhAccountSnapshot
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ghAccount: GhAccountService
  }
}

/**
 * The account lifecycle service. One instance per process tree; the resident
 * service, the desktop, and the CLI all compose it the same way.
 */
export class GhAccountService extends Service {
  static inject = ['credentials']

  private readonly domains = new Map<GhAccountDomain, DomainState>()
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  /** Change notifications for snapshot surfaces. */
  readonly watchers: Array<(domain: GhAccountDomain) => void> = []
  /** Cold-start hydration of persisted grants; awaits nothing at construction time. */
  readonly hydrated: Promise<void>

  constructor(ctx: Context, configs: readonly GhAccountDomainConfig[]) {
    super(ctx, 'ghAccount')
    for (const config of configs) {
      const requestTimeoutMs = config.requestTimeoutMs ?? 30_000
      if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 2_147_483_647) {
        throw new Error('gh-account requestTimeoutMs must be a positive timer budget')
      }
      if (this.domains.has(config.domain)) throw new Error(`gh-account domain ${config.domain} is configured twice`)
      new URL(config.authorizeUrl)
      new URL(config.tokenUrl)
      if (config.clientId.trim() === '') throw new Error('gh-account clientId must be non-empty')
      this.domains.set(config.domain, {
        config: { ...config, requestTimeoutMs }, grant: null, epoch: 0, refresh: null, pending: null, writes: Promise.resolve(),
      })
    }
    this.hydrated = this.own((async (): Promise<void> => {
      for (const [domain, state] of this.domains) {
        const epoch = state.epoch
        const record = await this.credentials().readRecord(this.keyOf(domain))
        if (this.lifetime.signal.aborted || state.epoch !== epoch) continue
        if (record?.kind === 'grant') {
          state.grant = parseStoredGrant(record.payload)
          state.epoch += 1
        }
      }
    })())
    ctx.effect(() => async () => {
      this.lifetime.abort(new GhAccountFailure('gh-account/unavailable', 'the account service was unloaded'))
      for (const state of this.domains.values()) {
        state.epoch += 1
        state.grant = null
        state.pending = null
      }
      await Promise.allSettled([...this.operations])
      this.watchers.length = 0
    })
  }

  /** The credentials service, narrowed for internal use. */
  private credentials(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw new Error('gh-account: the credentials service is required')
    return credentials
  }

  /** The record address one domain's grant lives at. */
  private keyOf(domain: GhAccountDomain): CredentialKey {
    return credentialKey(GH_ACCOUNT_SCOPE, domain)
  }

  /**
   * List the configured domains.
   * @returns every domain this owner was constructed with.
   */
  configuredDomains(): GhAccountDomain[] {
    return [...this.domains.keys()]
  }

  /**
   * One domain's endpoint configuration, for owners that mint derived tokens.
   * @param domain - the account domain.
   * @returns the endpoint/client configuration the domain was constructed with.
   */
  domainConfigOf(domain: GhAccountDomain): GhAccountDomainConfig & { requestTimeoutMs: number } {
    return this.domainOf(domain).config
  }

  /**
   * The domain's current generation. Every login and logout bumps it, so
   * derived-credential owners compare it against the generation their token
   * was minted under and drop tokens a later generation superseded.
   * @param domain - the account domain.
   * @returns the domain's current generation counter.
   */
  epochOf(domain: GhAccountDomain): number {
    return this.domainOf(domain).epoch
  }

  /**
   * Public facts for one domain; token-free by construction.
   * @param domain - the account domain.
   * @returns the domain's account identity and expiry facts, logged-out included.
   */
  snapshot(domain: GhAccountDomain): GhAccountSnapshot {
    const state = this.domainOf(domain)
    if (state.grant === null) {
      return { domain, accountId: '', plan: null, epoch: state.epoch, accessExpiresAt: 0 }
    }
    return {
      domain,
      accountId: state.grant.accountId,
      plan: state.grant.plan,
      epoch: state.epoch,
      accessExpiresAt: state.grant.accessExpiresAt,
    }
  }

  /** Resolve one domain's state or fail with the stable domain error. */
  private domainOf(domain: GhAccountDomain): DomainState {
    this.lifetime.signal.throwIfAborted()
    const state = this.domains.get(domain)
    if (state === undefined) throw new GhAccountFailure('gh-account/domain-unknown', `no ${domain} domain is configured`)
    return state
  }

  /**
   * Begin one interactive login: build the PKCE pair and return the
   * authorization URL. The domain keeps the verifier; {@link completeLogin}
   * finishes the exchange.
   * @param domain - the account domain.
   * @param redirectUrl - the OAuth redirect_uri the authorization round-trip uses.
   * @returns the user-facing verification URL and the pending login's expiry.
   */
  async beginLogin(domain: GhAccountDomain, redirectUrl: string): Promise<{ verificationUrl: string; expiresAt: number }> {
    await this.hydrated
    const state = this.domainOf(domain)
    if (state.pending !== null && state.pending.expiresAt > Date.now()) {
      throw new GhAccountFailure('gh-account/login-in-progress', `a ${domain} login is already awaiting authorization`)
    }
    const pkce = pkcePair()
    const csrf = freshState()
    const url = new URL(state.config.authorizeUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', state.config.clientId)
    url.searchParams.set('redirect_uri', redirectUrl)
    url.searchParams.set('code_challenge', pkce.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', csrf)
    if (state.config.scope !== undefined) url.searchParams.set('scope', state.config.scope)
    const expiresAt = Date.now() + 600_000
    state.pending = { state: csrf, codeVerifier: pkce.codeVerifier, redirectUrl, expiresAt, epochAtStart: state.epoch, exchanging: false }
    return { verificationUrl: url.href, expiresAt }
  }

  /**
   * Complete one login by exchanging the authorization code. The verifier and
   * CSRF state must match the pending login; a completed exchange bumps the
   * epoch, superseding every in-flight refresh from the previous grant.
   * @param domain - the account domain.
   * @param code - the authorization code the redirect carried.
   * @param returnedState - the CSRF state the redirect carried back.
   * @param redirectUrl - the redirect_uri the code was issued for.
   * @returns the logged-in snapshot.
   */
  async completeLogin(domain: GhAccountDomain, code: string, returnedState: string, redirectUrl: string): Promise<LoginOutcome> {
    await this.hydrated
    const state = this.domainOf(domain)
    const pending = state.pending
    if (pending === null || pending.expiresAt <= Date.now()) {
      throw new GhAccountFailure('gh-account/oauth-rejected', `no ${domain} login is pending`)
    }
    if (returnedState !== pending.state) {
      throw new GhAccountFailure('gh-account/oauth-rejected', `authorization state mismatch for ${domain}`)
    }
    if (redirectUrl !== pending.redirectUrl) throw new GhAccountFailure('gh-account/oauth-rejected', 'authorization redirect mismatch')
    if (pending.exchanging) throw new GhAccountFailure('gh-account/login-in-progress', 'this authorization code is already being exchanged')
    pending.exchanging = true
    return await this.own((async () => {
      try {
        const granted = await this.exchange(domain, signal => exchangeCode(
          state.config.tokenUrl, state.config.clientId, code, pending.codeVerifier, pending.redirectUrl, signal))
        const grant: GhGrantPayload = {
          refreshToken: granted.refreshToken ?? '',
          accessToken: granted.accessToken,
          accessExpiresAt: Date.now() + granted.expiresInSeconds * 1_000,
          accountId: granted.accountId,
          plan: granted.plan,
        }
        return await this.serializeWrite(state, async () => {
          this.assertGeneration(state, pending.epochAtStart)
          if (state.pending !== pending) throw new GhAccountFailure('gh-account/stale-generation', 'this login was superseded')
          await this.persist(domain, grant)
          this.assertGeneration(state, pending.epochAtStart)
          state.epoch += 1
          state.grant = grant
          this.announce(domain)
          return { snapshot: this.snapshot(domain) }
        })
      } finally {
        if (state.pending === pending) state.pending = null
      }
    })())
  }

  /**
   * Drop one domain's grant and supersede every in-flight operation.
   * @param domain - the account domain.
   */
  async logout(domain: GhAccountDomain): Promise<void> {
    const state = this.domainOf(domain)
    state.epoch += 1
    state.pending = null
    state.grant = null
    state.refresh = null
    await this.hydrated
    await this.own(this.serializeWrite(state, () => this.credentials().deleteRecord(this.keyOf(domain))))
    this.announce(domain)
  }

  /**
   * A valid access token for the domain, refreshing when due. Concurrent
   * callers share one refresh; each caller's abort stops only that caller's
   * wait, and the shared exchange runs to completion for the others. A result
   * from a superseded generation is discarded as stale.
   * @param domain - the account domain.
   * @param signal - the caller's own cancellation.
   * @returns a currently valid access token.
   */
  async accessToken(domain: GhAccountDomain, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    await this.hydrated
    signal?.throwIfAborted()
    const state = this.domainOf(domain)
    const epoch = state.epoch
    if (state.grant === null) {
      throw new GhAccountFailure('gh-account/not-logged-in', `no ${domain} account is logged in`)
    }
    if (state.grant.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) return state.grant.accessToken
    const shared = state.refresh ?? this.refreshNow(domain)
    const settled = await this.withCallerCancel(shared, signal)
    this.assertGeneration(state, epoch)
    // A newer login may have landed while this caller waited; its grant wins.
    const grant = state.grant
    if (grant.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) return grant.accessToken
    return settled.accessToken
  }

  /** Race one caller's abort against the shared refresh without aborting it. */
  private async withCallerCancel<T>(shared: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return await shared
    signal.throwIfAborted()
    const cancelled = Promise.withResolvers<never>()
    const onAbort = (): void => {
      cancelled.reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([shared, cancelled.promise])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Run one refresh exchange and publish the rotated grant. */
  private async refreshNow(domain: GhAccountDomain): Promise<GhGrantPayload> {
    const state = this.domainOf(domain)
    const current = state.grant
    if (current === null) throw new GhAccountFailure('gh-account/not-logged-in', `no ${domain} account is logged in`)
    const epochAtStart = state.epoch
    const run = (async (): Promise<GhGrantPayload> => {
      const granted = await this.exchange(domain, signal => exchangeRefresh(
        state.config.tokenUrl, state.config.clientId, current.refreshToken, signal))
      // A login or logout finished while the exchange was in flight: its
      // outcome is authoritative and this rotation is discarded.
      if (state.epoch !== epochAtStart) {
        throw new GhAccountFailure('gh-account/stale-generation', `${domain} changed accounts during the refresh`)
      }
      const merged: GhGrantPayload = {
        refreshToken: granted.refreshToken ?? current.refreshToken,
        accessToken: granted.accessToken,
        accessExpiresAt: Date.now() + granted.expiresInSeconds * 1_000,
        accountId: granted.accountId,
        plan: granted.plan ?? current.plan,
      }
      if (granted.accountId !== current.accountId) throw new GhAccountFailure('gh-account/oauth-rejected', 'refresh changed the account identity')
      return await this.serializeWrite(state, async () => {
        this.assertGeneration(state, epochAtStart)
        await this.persist(domain, merged)
        this.assertGeneration(state, epochAtStart)
        state.grant = merged
        return merged
      })
    })()
    state.refresh = run
    try {
      return await this.own(run)
    } finally {
      if (state.refresh === run) state.refresh = null
    }
  }

  /** Wrap one OAuth rejection with the stable account error code. */
  private async exchange(domain: GhAccountDomain, operation: (signal: AbortSignal) => Promise<TokenGrant>): Promise<TokenGrant> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.domainOf(domain).config.requestTimeoutMs)])
    try {
      return await operation(signal)
    } catch (error) {
      if (signal.aborted) throw new GhAccountFailure('gh-account/unavailable', `${domain} token exchange was cancelled or timed out`)
      if (error instanceof OAuthRejection) {
        throw new GhAccountFailure('gh-account/oauth-rejected', `${domain} token exchange failed: ${error.message}`)
      }
      throw error
    }
  }

  /** Persist one grant through the credentials record half. */
  private async persist(domain: GhAccountDomain, grant: GhGrantPayload): Promise<void> {
    await this.credentials().modifyRecord(this.keyOf(domain), () => Promise.resolve({ kind: 'grant' as const, payload: grant }))
  }

  /** Notify snapshot surfaces without leaking why. */
  private announce(domain: GhAccountDomain): void {
    for (const watcher of this.watchers) {
      try { watcher(domain) } catch (error) {
        this.ctx.logger.warn('gh-account snapshot observer failed: %o', error)
      }
    }
  }

  /** Reject late results before publishing or returning account credentials. */
  private assertGeneration(state: DomainState, epoch: number): void {
    this.lifetime.signal.throwIfAborted()
    if (state.epoch !== epoch) throw new GhAccountFailure('gh-account/stale-generation', 'the account changed during the operation')
  }

  /** Keep credential writes ordered without letting a failed write poison later logout. */
  private serializeWrite<T>(state: DomainState, operation: () => Promise<T>): Promise<T> {
    const pending = state.writes.then(operation)
    state.writes = pending.then(() => undefined, () => undefined)
    return pending
  }

  /** Keep owned I/O alive through cancellation and await it during service teardown. */
  private own<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }
}

/** Validate a durable grant without exposing its token material in errors. */
function parseStoredGrant(payload: unknown): GhGrantPayload {
  if (typeof payload !== 'object' || payload === null) throw new GhAccountFailure('gh-account/invalid-grant', 'stored account grant is invalid')
  const value = payload as Partial<GhGrantPayload>
  if (typeof value.refreshToken !== 'string' || typeof value.accessToken !== 'string' || value.accessToken === ''
    || typeof value.accessExpiresAt !== 'number' || !Number.isFinite(value.accessExpiresAt) || value.accessExpiresAt < 0
    || typeof value.accountId !== 'string' || value.accountId === '' || value.plan !== null && typeof value.plan !== 'string') {
    throw new GhAccountFailure('gh-account/invalid-grant', 'stored account grant is invalid')
  }
  return {
    refreshToken: value.refreshToken, accessToken: value.accessToken, accessExpiresAt: value.accessExpiresAt,
    accountId: value.accountId, plan: value.plan,
  }
}

/** One account operation failure carrying the stable code clients switch on. */
export class GhAccountFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}
