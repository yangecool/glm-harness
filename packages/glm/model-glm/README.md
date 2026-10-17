---
description: "Native GLM text and tool requests, streaming, reasoning replay, and usage accounting through the public LLM seam."
kind: "package-reference"
---

# GLM model adapter

English | [中文](README.zh.md)

## Summary

Call GLM text and tool models through the public LLM service using the GH-owned request/SSE implementation. The shipped GH base mounts this adapter and selects `glm-4.6`. Requests use per-call credentials, bounded waits, same-model reasoning replay, and presence-aware usage. Real GLM service integration, additional protocols, accounts, and multimodal support remain unverified or incomplete.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The `model-glm` plugin is composed by `@glm-harness/gh-base`; profiles built on it get the route without extra wiring. The keyless test suite (`tests/stream.spec.ts`, `tests/runtime.spec.ts`) drives the pure protocol functions and the adapter against a loopback chat-completions endpoint — `pnpm exec vitest run --config vitest.config.ts packages/glm/model-glm/tests` from the repository root. A full keyless product loop is reproduced by pointing `GLM_BASE_URL` at a local wire mock and running the `gh-headless` profile.

<a id="understand-the-implementation"></a>
## Understand the implementation

Requests always stream (`stream: true` + `stream_options.include_usage`), carry the harness attribution headers and a per-request bearer key, and honor the caller's abort signal. Credential lookup, response headers, and HTTP error bodies share a request deadline; the response stream has a separate idle watchdog. Reasoning is binary on this protocol: the model catalog exposes the `off`/`high` efforts and maps them onto GLM's `thinking` switch; `reasoning_content` deltas become reasoning blocks. Later requests replay those bytes in order for assistant messages from the same provider/model; a model switch omits that reasoning. Endpoint-specific preserved-thinking controls still need implementation and live validation. Tool-call fragments are assembled by wire index; finish reasons map `stop`/`tool_calls`/`length` and a provider refusal (for example `content_filter`) fails the call instead of passing as an empty success. Raw usage fragments are merged before projection; missing counters remain unknown and known zero cache counts stay present. Nullable content/reasoning deltas carry no text; other non-string values fail explicitly. Usage is split into disjoint counts — cached prompt tokens are reported as `cacheReadTokens` and subtracted from `inputTokens` — and every malformed condition (no finish, no blocks, non-object tool arguments, frames past `[DONE]`, a stream that ends without it) is one explicit classified failure.

The key is resolved per request through the credentials service (falling back to the launch environment's `GLM_API_KEY`); without one the model call fails with `MISSING_CREDENTIAL` — there is no upstream fallback. Configuration: `baseURL` (default `https://open.bigmodel.cn/api/paas/v4`, env `GLM_BASE_URL`; point it at `https://api.z.ai/api/paas/v4` for Z.AI), `apiKeyEnv` (default `GLM_API_KEY`), `requestTimeoutMs` (default 30000), and `streamIdleTimeoutMs` (default 120000), and `retryPolicy` (default normal mode, three retries over `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, and `STREAM_CLOSED`; the upstream retry executor stays banned, the GH executor in `gh-model-retry` runs the policy).

The static catalog (glm-4.6, glm-4.5-air, glm-4.5-flash) states publicly documented capabilities; no live service has verified them yet (blocked item D01), so treat the numbers as declared, not measured. Uncatalogued model ids fail with `UNSUPPORTED_MODEL` before provider I/O; no context window or output limit is invented. The shipped GH default selects `glm-4.6`.

## Further Exploration

- [LLM service](../../llm/llm/README.md) — public adapter contract.
- [GH base](../base/README.md) — shipped composition.

## Model Experience

### GLM request and replay

#### What the model sees

The adapter adds no persona prompt or tools. It translates the canonical request and replays same-model reasoning, preserving the context needed for tool continuation. Usage tracks uncached input separately from cache reads; reasoning tokens are an output subset, not an extra charge. Auxiliary requests use this same adapter when routed to `glm`.

#### Token effect

Raw prompt/completion/cache counters are merged before projection. Missing counters stay unknown; cached input is disjoint from uncached input, and reasoning is an output subset.

#### KV Cache effect

Reasoning replay changes the transmitted prefix compared with the earlier discard behavior. Stable serialization alone does not prove a provider cache hit; use actual provider counters. Model/endpoint-specific cache controls remain unverified.

## Known Limitations and Deferred Work

- Real GLM, Coding Plan/PAT, multimodal input, full provider configuration, persona/tool strategy, and endpoint-specific preserved-thinking controls remain pending. Automatic request retry is not shipped: the upstream retry implementation is excluded, and GH-owned bounded retry is a separate task. A zero or expired Retry-After imposes no additional provider delay and does not change HTTP error classification.

<a id="dev-note"></a>
### Dev Note

The adapter owns protocol behavior; shared loop changes require a public contract and consumer tests.
