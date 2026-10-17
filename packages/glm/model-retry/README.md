---
description: "GLM Harness's own bounded model-request retry executor: provider-owned normal-mode policies on the agent request-recovery point, with durable retry events, cancellable waits, and an explicit refusal of unbounded retry."
kind: "package-reference"
---

# @glm-harness/gh-model-retry

English | [中文](README.zh.md)

## Summary

Mount this executor to retry transient GLM request failures within a provider-declared budget: each retry is committed to the session log before its cancellable wait, restarts rebuild the budget from replayed events, and the token meter plus retry UI see one chain of physical attempts. A provider `Retry-After` longer than the policy cap, an exhausted budget, or an `always` policy fails the step explicitly — GH shows retry state instead of waiting invisibly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

GH profiles mount the executor as one row next to the GLM adapter; `@glm-harness/gh-base` composes it for every shipped profile.

### When to choose it

Choose it when a composition wants bounded, observable recovery for transient model failures. A deployment that prefers immediate explicit failure disables this row; the GLM route then surfaces every failure on its first attempt.

### Minimal configuration

The executor has no configuration; each provider registration owns its retry policy (`retryPolicy` under the provider's config, resolved through the public `RetryPolicySchema`). Compose it in `cordis.yml`:

```yaml
- id: model-retry
  name: '@glm-harness/gh-model-retry'
```

The `glm` route defaults to normal mode with three retries over `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, and `STREAM_CLOSED`; authentication, quota, request-shape, and truncation failures stay terminal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/index.ts` listens on the `agent/request-error` waterfall — the loop's request-recovery extension point — and executes the failed step's captured provider policy. The durable counting key is `(provider, policy content)`: the `llmRetry` session projection folds committed `llm/retry` events, so a restart continues the same budget instead of resetting it, and `step/start` resets the chain. The retry identity (`RetryId`) is stable across one chain and shared with the existing retry UI and token-meter consumers through the provider-neutral Agent type contracts. Disposal aborts every active wait and drains the tracked recoveries.

The bounded-only rule has two edges: an `always` policy is refused loudly (logged and delegated, so the step fails rather than retrying without a budget), and a provider `Retry-After` beyond `maxDelayMs` fails the step instead of parking the session on a long hold.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Policy execution, durable events, cancellable waits, disposal drain |
| [`tests/retry.spec.ts`](tests/retry.spec.ts) | Recovery, budget exhaustion, retry-after caps, cancellation, replay, config rejection |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@glm-harness/gh-model-glm`](../model-glm/README.md) — the route whose policy this executor runs
- [`dsh-llm` retry policy](../../llm/llm/README.md) — the public policy schema and resolution
- [`dsh-agent-loop`](../../core/agent-loop/README.md) — the request-recovery extension point

-----

<a id="model-experience"></a>
## Model Experience

### GH bounded retry executor

#### What the model sees

Nothing new: a retry re-issues the same assembled request after the wait. A failed attempt's partial output is settled as a durable `assistant/attempt` record, never committed as an assistant message, so the model history stays one chain of complete requests.

#### Token effect

Each physical attempt that reports usage is accounted separately by the token meter; a failed attempt with no usage stays unknown rather than zero. Retries add request cost only when the provider eventually answers.

#### KV Cache effect

A retry resends the identical request bytes, so prefix-cache eligibility is unchanged; nothing here creates or invalidates provider cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The executor retries only model requests; a tool round-trip that failed after side effects is not replayed (that boundary belongs to the session-continuity work).
- Retry budget and waits are provider-policy fields, not yet a user-visible setting; surfacing them in the models settings page is future work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The upstream `dsh-llm-retry` executor stays banned from GH closures; this package is the GH-owned replacement required by E02.5 and must not grow account, routing, or telemetry business.

</details>
