# GH 账号与项目令牌

[English](gh-account.md) | 中文

GH 账号 seam 由 [gh-account](../../packages/glm/account) 持有（`ctx.ghAccount`、`GhAccountService`；`ctx.ghProjectToken`、`GhProjectTokenService`）：面向两个服务域（`bigmodel`、`zai`）的按域 OAuth 授权码 + PKCE 登录、带单调用者取消的单飞访问令牌刷新、丢弃被超越结果的按域账号 epoch，以及按物理模型请求解析的短时项目令牌（PAT）。grant 经 credentials seam 的记录半边持久化；令牌材料绝不进入 session、注册表、日志或任何快照面。[包 README](../../packages/glm/account/README.zh.md) 持有组合状态、端点配置矩阵与限制。

Source: [`packages/glm/account/src/service.ts`](../../packages/glm/account/src/service.ts)

## 登录与 grant 持久化

`beginLogin` 生成 S256 PKCE 对，返回授权 URL 与绑定到该域唯一待决登录的 CSRF state；`completeLogin` 交换授权码、递增该域 epoch、把 grant 持久化到 credentials 记录 `gh-account/<domain>`。冷启动在同一 seam 上恢复全部已存 grant 后才报告就绪，因此重启保留登录。`logout` 丢弃 grant、删除记录并再次递增 epoch——超越上一代数的全部在途操作。

## 单飞刷新与 epoch

`accessToken` 返回有效访问令牌，到期余量内触发刷新。并发调用者共享一次物理交换；单个调用者的 `AbortSignal` 只取消自己的等待，绝不取消其他调用者仍需要的共享交换。每个域带一个由每次登录/登出递增的单调 epoch：在被超越代数下启动的刷新以 `gh-account/stale-generation` 失败，而不是覆盖更新的 grant；派生凭据 owner 通过 `epochOf` 对齐。

## 项目令牌

`ctx.ghProjectToken` 在该域 token 端点铸造 PAT（`grant_type=urn:glm-harness:pat`、Bearer 访问令牌、project id），按域+project 缓存至 30 秒到期余量。传输层鉴权拒绝只丢弃被拒的那个令牌——下一次物理尝试必换新，被吊销凭牌绝不复用。缓存同时记录铸造时的账号代数；登录或登出移动 epoch 的瞬间缓存 PAT 即失效，因此登出立即停止授权，而不是等到令牌到期。

## 模型路由集成

`preferAccountPat` 开启时 GLM provider 路由先咨询 PAT owner：已登录域每次尝试给出足够新的 PAT，显式 `gh-account/not-logged-in` 回落静态 key 路径，缺 key 以 `MISSING_CREDENTIAL` 显式失败——绝无上游回退。拒绝回调按调用时懒查找，账号行与模型行之间的挂载顺序不承载语义。

## The service

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
domainConfigOf(domain: GhAccountDomain): GhAccountDomainConfig

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
beginLogin(domain: GhAccountDomain, redirectUrl: string): { verificationUrl: string; expiresAt: number }

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
