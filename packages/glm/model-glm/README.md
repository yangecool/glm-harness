# GLM model adapter

English | [中文](README.zh.md)

`@glm-harness/gh-model-glm` owns the `glm` provider route: a GH-written chat-completions request serializer, Server-Sent-Events parser, and stream translator bound to the DSH `LlmAdapter` seam. Nothing here imports or forwards to `llm-pi-ai` or `llm-deepseek`; the wire protocol (BigModel / Z.AI `POST {baseURL}/chat/completions`, OpenAI-compatible frames with `reasoning_content` and `tool_calls` deltas, terminated by `data: [DONE]`) is implemented in this package against its own types.

## Behavior

Requests always stream (`stream: true` + `stream_options.include_usage`), carry the harness attribution headers and a per-request bearer key, and honor the caller's abort signal under a stream idle watchdog. Reasoning is binary on this protocol: the model catalog exposes the `off`/`high` efforts and maps them onto GLM's `thinking` switch; `reasoning_content` deltas become reasoning blocks that are never sent back in later requests. Tool-call fragments are assembled by wire index; finish reasons map `stop`/`tool_calls`/`length` and a provider refusal (for example `content_filter`) fails the call instead of passing as an empty success. Usage is split into disjoint counts — cached prompt tokens are reported as `cacheReadTokens` and subtracted from `inputTokens` — and every malformed condition (no finish, no blocks, non-object tool arguments, frames past `[DONE]`, a stream that ends without it) is one explicit classified failure.

The key is resolved per request through the credentials service (falling back to the launch environment's `GLM_API_KEY`); without one the model call fails with `MISSING_CREDENTIAL` — there is no upstream fallback. Configuration: `baseURL` (default `https://open.bigmodel.cn/api/paas/v4`, env `GLM_BASE_URL`; point it at `https://api.z.ai/api/paas/v4` for Z.AI), `apiKeyEnv` (default `GLM_API_KEY`), `streamIdleTimeoutMs` (default 120000).

The static catalog (glm-4.6, glm-4.5-air, glm-4.5-flash) states publicly documented capabilities; no live service has verified them yet (blocked item D01), so treat the numbers as declared, not measured. Uncatalogued model ids resolve to text-only negative capability and still route.

## Use this package

The `model-glm` plugin is composed by `@glm-harness/gh-base`; profiles built on it get the route without extra wiring. The keyless test suite (`tests/stream.spec.ts`, `tests/runtime.spec.ts`) drives the pure protocol functions and the adapter against a loopback chat-completions endpoint — `pnpm exec vitest run --config vitest.config.ts packages/glm/model-glm/tests` from the repository root. A full keyless product loop is reproduced by pointing `GLM_BASE_URL` at a local wire mock and running the `gh-headless` profile.
