---
description: "GH account and project-token owner: OAuth authorization-code + PKCE logins over the two service domains, single-flight refresh with per-caller cancellation, per-domain account epochs, and request-level short-term PAT resolution with rejection-driven invalidation — tokens never reach sessions, logs, or snapshots."
kind: "package-reference"
---

# @glm-harness/gh-account

English | [中文](README.zh.md)

## Summary

Own the GH account lifecycle and the short-term credentials derived from it. One OAuth grant per service domain (`bigmodel`, `zai`) persists through the credentials seam's record half; refreshes are single-flight with per-caller cancellation, and every login or logout bumps a per-domain epoch that discards superseded results. Short-term project tokens (PATs) resolve per physical model request, and a rejected PAT is dropped the moment the transport reports the rejection — the next attempt mints fresh. Every public surface is token-free by construction.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This is a composition row: gh-base mounts it, and the resident service exposes the `ghAccount` Remote namespace (`status`, `beginLogin`, `completeLogin`, `logout`) for connected clients.

### When to choose it

Every profile carries the row; whether it does anything is configuration. With no domain configured the owner mounts empty — nothing else fails to boot, and model calls use the static key path (or fail explicitly with `MISSING_CREDENTIAL`).

### Minimal configuration

```yaml
- id: gh-account
  config:
    domains:
      - domain: bigmodel
        authorizeUrl: https://account.bigmodel.cn/oauth/authorize
        tokenUrl: https://account.bigmodel.cn/oauth/token
        clientId: gh-harness
```

Endpoints are configuration, not code: production points them at the real services, verification points them at a loopback fixture. The PAT grant is `urn:glm-harness:pat` at the same token endpoint, authenticated by the access token, scoped by `project_id`. The GLM route opts in with `preferAccountPat` plus `accountDomain` and `patProjectId`; a logged-out domain falls through to the static key path, never to an upstream fallback.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/service.ts` keeps one state per domain: the persisted grant, a monotonic epoch, the shared in-flight refresh, and the pending login's PKCE verifier. `beginLogin` builds an S256-challenged authorization URL; `completeLogin` checks the CSRF state, exchanges the code, bumps the epoch (superseding any in-flight refresh from the previous grant), and persists the rotated grant under the `gh-account/<domain>` credentials record. `accessToken` returns the cached token while it is more than a refresh-margin away from expiry; otherwise every concurrent caller shares one refresh exchange, and each caller's `AbortSignal` stops only that caller's wait — the exchange runs to completion for the others. `src/pat.ts` caches one PAT per domain until its expiry margin; `rejectPat` removes exactly the token the server rejected, so a rejected credential is never reused. `src/oauth.ts` holds the PKCE helpers and the two token-endpoint exchanges as pure `fetch` functions.

| File | Role |
|---|---|
| [`src/service.ts`](src/service.ts) | Domain state, login lifecycle, epoch, single-flight refresh, grant persistence |
| [`src/pat.ts`](src/pat.ts) | Request-level PAT resolution, expiry-margin caching, rejection invalidation |
| [`src/oauth.ts`](src/oauth.ts) | PKCE pair generation, code and refresh exchanges |
| [`tests/account.spec.ts`](tests/account.spec.ts) | Login round-trip, single-flight, caller cancellation, epoch supersession, hydration, PAT lifecycle over a loopback issuer |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@glm-harness/gh-model-glm`](../model-glm/README.md) — the provider route that resolves the PAT before the static key
- [`dsh-credentials`](../../credentials/credentials/README.md) — the seam whose record half stores the grants
- [`@glm-harness/gh-remote-app`](../remote-app/README.md) — the `ghAccount` Remote namespace over the resident service

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No real BigModel or Z.AI service has been contacted: every flow is verified against a loopback issuer; real-account joint testing (D01) needs real credentials.
- Entitlement facts are display-only plan strings from the token endpoint; quota, billing, and plan enforcement (E02.7) are separate owners.
- An AUTH rejection invalidates the PAT but does not auto-retry the request; a bounded single retry with a fresh PAT belongs to the retry-policy owner (E02.5).
- Desktop local-callback login (vs. the polling/redirect flow driven over RPC) arrives with the desktop account UI.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Token material is confined to the two modules that move it: `service.ts` holds grant values and `pat.ts` holds PAT values; every other surface — snapshots, the RPC namespace, logs — receives identity, plan, and generation facts only. The single-flight refresh deliberately keeps running when a caller aborts, because one caller's cancellation must not burn a rotation for everyone else. The tests drive a real loopback issuer over `fetch`, never a mocked client, so wire shapes stay honest.

</details>
