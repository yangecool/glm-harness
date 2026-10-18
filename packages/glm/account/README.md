---
description: "GH account and project-token owner: OAuth authorization-code + PKCE logins over the two service domains, single-flight refresh with per-caller cancellation, per-domain account epochs, and request-level short-term PAT resolution with rejection-driven invalidation — tokens never reach sessions, logs, or snapshots."
kind: "package-reference"
---

# @glm-harness/gh-account

English | [中文](README.zh.md)

## Summary

Own the GH account lifecycle and the short-term credentials derived from it. One OAuth grant per service domain (`bigmodel`, `zai`) persists through the credentials seam's record half; refreshes are single-flight with per-caller cancellation, and every login or logout bumps a per-domain epoch that discards superseded results. Short-term project tokens (PATs) resolve per physical model request, and a rejected PAT is dropped the moment the transport reports the rejection — the next attempt mints fresh. Client status and RPC views omit token material; credential-resolution methods return secrets only to their request owners.

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

Every profile carries the row; with no domain configured it mounts empty. Other features still boot and model calls use a configured static API key, or fail with `MISSING_CREDENTIAL`. Configured domains require valid URLs, a client id, and `requestTimeoutMs` (default 30,000 ms). The deadline covers token requests and response bodies.

### Minimal configuration

```yaml
- id: gh-account
  config:
    domains:
      - domain: bigmodel
        authorizeUrl: https://issuer.example.invalid/oauth/authorize
        tokenUrl: https://issuer.example.invalid/oauth/token
        clientId: gh-harness
```

The implemented issuer protocol is a fixture: authorization-code/PKCE and `urn:glm-harness:pat` at the token endpoint, with `project_id` scope. These are not verified BigModel/Z.AI endpoints or grants. Real service adapters must be implemented from the verified official protocol, including business JWT and personal/team project selection; changing URLs alone is insufficient. The GLM route opts in with `preferAccountPat`, `accountDomain`, and `patProjectId`; only a logged-out domain falls through to the configured static API key.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/service.ts` waits for credential hydration before login or credential resolution. Login completion, refresh, and logout serialize durable writes per domain; generation checks surround both network results and persistence. An old login, refresh, or PAT mint cannot publish after logout or a newer login. Tokens publish in memory only after successful persistence. Callers cancel only their own shared-refresh wait; the owner bounds exchanges and aborts and awaits them during disposal. Missing or invalid issuer TTLs are rejected. Watcher failures do not roll back an accepted account state.

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

- No real BigModel or Z.AI adapter is qualified. The loopback issuer verifies lifecycle mechanics only; actual OAuth/JWT/PAT protocols, Coding Plan access, and real-account joint testing remain open (D01).
- Entitlement facts are display-only plan strings from the token endpoint; quota, billing, and plan enforcement (E02.7) are separate owners.
- An AUTH rejection invalidates the PAT but does not auto-retry the request; a bounded single retry with a fresh PAT belongs to the retry-policy owner (E02.5).
- RPC drives authorization URLs and manual code completion. Neither a desktop callback listener nor a polling login driver is implemented; the desktop account UI must add its own verified flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Token material is confined to the two modules that move it: `service.ts` holds grant values and `pat.ts` holds PAT values; every other surface — snapshots, the RPC namespace, logs — receives identity, plan, and generation facts only. The single-flight refresh deliberately keeps running when a caller aborts, because one caller's cancellation must not burn a rotation for everyone else. The tests drive a real loopback issuer over `fetch`, never a mocked client, so wire shapes stay honest.

</details>
