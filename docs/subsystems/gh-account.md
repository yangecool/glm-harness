# GH Account and Project Tokens

English | [中文](gh-account.zh.md)

The GH account seam is owned by [gh-account](../../packages/glm/account) (`ctx.ghAccount`, `GhAccountService`; `ctx.ghProjectToken`, `GhProjectTokenService`): per-domain OAuth authorization-code + PKCE logins for the two service domains (`bigmodel`, `zai`), single-flight access-token refresh with per-caller cancellation, per-domain account epochs that discard superseded results, and short-term project tokens (PATs) resolved per physical model request. Grants persist through the credentials seam's record half; token material never reaches sessions, registries, logs, or any snapshot surface. The [package README](../../packages/glm/account/README.md) owns composition status, the endpoint configuration matrix, and limitations.

Source: [`packages/glm/account/src/service.ts`](../../packages/glm/account/src/service.ts)

## Login and grant persistence

`beginLogin` builds the S256 PKCE pair and returns the authorization URL with a CSRF state bound to one pending login per domain; `completeLogin` exchanges the code, bumps the domain's epoch, and persists the grant at the credentials record `gh-account/<domain>`. A cold start rehydrates every stored grant through the same seam before the service reports ready, so restarts keep logins. `logout` drops the grant, deletes the record, and bumps the epoch again — superseding every in-flight operation from the previous generation.

## Single-flight refresh and epochs

`accessToken` returns a valid access token, refreshing when the expiry margin is due. Concurrent callers share one physical exchange; a caller's `AbortSignal` cancels only that caller's wait, never the shared exchange the others still need. Every domain carries a monotonic epoch bumped by each login and logout: a refresh that started under a superseded generation fails with `gh-account/stale-generation` instead of overwriting the newer grant, and derived-credential owners align against `epochOf`.

## Project tokens

`ctx.ghProjectToken` mints PATs at the domain's token endpoint (`grant_type=urn:glm-harness:pat`, Bearer access token, project id) and caches one per domain+project until a 30-second expiry margin. A transport authorization rejection drops exactly the rejected token — the next physical attempt mints fresh, so a revoked credential is never reused. The cache also records the account generation it was minted under; the moment a login or logout moves the epoch, the cached PAT is invalid, so logout stops authorizing immediately rather than at token expiry.

## Model-route integration

The GLM provider route consults the PAT owner first when `preferAccountPat` is on: a logged-in domain yields a fresh-enough PAT per attempt, an explicit `gh-account/not-logged-in` falls through to the static key path, and a missing key fails as `MISSING_CREDENTIAL` — never an upstream fallback. The rejection hook is looked up lazily per callback, so plugin mount order between the account row and the model row carries no load.

## The service

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxghaccount--ghaccountservice"></a>

### `ctx.ghAccount` — `GhAccountService`

The account lifecycle service. One instance per process tree; the resident service, the desktop, and the CLI all compose it the same way.

```ts cordis-catalog
/**
 * List the configured domains.
 * @returns every domain this owner was constructed with.
 */
configuredDomains(): GhAccountDomain[]

/**
 * One domain's endpoint configuration, for owners that mint derived tokens.
 * @param domain - the account domain.
 * @returns the endpoint/client configuration the domain was constructed with.
 */
domainConfigOf(domain: GhAccountDomain): GhAccountDomainConfig & { requestTimeoutMs: number }

/**
 * The domain's current generation. Every login and logout bumps it, so
 * derived-credential owners compare it against the generation their token
 * was minted under and drop tokens a later generation superseded.
 * @param domain - the account domain.
 * @returns the domain's current generation counter.
 */
epochOf(domain: GhAccountDomain): number

/**
 * Public facts for one domain; token-free by construction.
 * @param domain - the account domain.
 * @returns the domain's account identity and expiry facts, logged-out included.
 */
snapshot(domain: GhAccountDomain): GhAccountSnapshot

/**
 * Begin one interactive login: build the PKCE pair and return the
 * authorization URL. The domain keeps the verifier; {@link completeLogin}
 * finishes the exchange.
 * @param domain - the account domain.
 * @param redirectUrl - the OAuth redirect_uri the authorization round-trip uses.
 * @returns the user-facing verification URL and the pending login's expiry.
 */
async beginLogin(domain: GhAccountDomain, redirectUrl: string): Promise<{ verificationUrl: string; expiresAt: number }>

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
async completeLogin(domain: GhAccountDomain, code: string, returnedState: string, redirectUrl: string): Promise<LoginOutcome>

/**
 * Drop one domain's grant and supersede every in-flight operation.
 * @param domain - the account domain.
 */
async logout(domain: GhAccountDomain): Promise<void>

/**
 * A valid access token for the domain, refreshing when due. Concurrent
 * callers share one refresh; each caller's abort stops only that caller's
 * wait, and the shared exchange runs to completion for the others. A result
 * from a superseded generation is discarded as stale.
 * @param domain - the account domain.
 * @param signal - the caller's own cancellation.
 * @returns a currently valid access token.
 */
async accessToken(domain: GhAccountDomain, signal?: AbortSignal): Promise<string>
```

Source: [`packages/glm/account/src/service.ts`](../../packages/glm/account/src/service.ts)

<a id="ctxghprojecttoken--ghprojecttokenservice"></a>

### `ctx.ghProjectToken` — `GhProjectTokenService`

The PAT owner. Composed wherever the account owner is; the GLM route consults it before the static key path.

```ts cordis-catalog
/**
 * Total mints served since process start.
 * @returns the mint counter; deliberately carries no token material.
 */
mintCount(): number

/**
 * Resolve one request-scoped PAT, minting or re-minting as due.
 * @param domain - the account domain the project belongs to.
 * @param projectId - the personal or team project key id.
 * @param signal - the caller's per-attempt cancellation.
 * @returns the bearer token for exactly one physical request.
 */
async resolvePat(domain: GhAccountDomain, projectId: string, signal?: AbortSignal): Promise<string>

/**
 * Drop a rejected PAT. The transport calls this on an authorization
 * rejection carrying the token it used; the next resolution mints fresh.
 * @param token - the token the server rejected.
 */
rejectPat(token: string): void

/**
 * Whether a cached PAT is currently valid for the domain+project (surfaces only).
 * @param domain - the account domain.
 * @returns token-free cache facts, or null when nothing valid is cached.
 */
patFacts(domain: GhAccountDomain): { projectId: string; expiresAt: number; mints: number } | null
```

Source: [`packages/glm/account/src/pat.ts`](../../packages/glm/account/src/pat.ts)
<!-- END GENERATED cordis-surface -->
