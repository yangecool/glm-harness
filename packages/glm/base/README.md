---
description: "The GLM Harness shared core: the dsh public infrastructure as an explicit DeepSeek-free closure, for GH profiles that compose their own model, account, and telemetry layers."
kind: "package-bundle"
---

# @glm-harness/gh-base

English | [中文](README.zh.md)

## Summary

Every GH profile runs on `gh-base`, so GH surfaces share the full tool set, durable session history, workspace safety defaults, and one provider-neutral LLM seam — while carrying none of the upstream model, account, or telemetry business. The bundle's dependency list is the product's minimal closure of dsh public packages: `@deepseek-ai/dsh-llm-pi-ai`, the DeepSeek model adapters and account platform, the DeepSeek session-log extensions, the DeepSeek web-search provider, and the OTel exporters are absent from both this manifest and the composed tree, and `scripts/check-gh-closure.ts` fails when any of them re-enters either side. Model access is not a fallback decision: GLM routing arrives as `@glm-harness` model plugins on the same `ctx.llm` seam, and until that layer is mounted a model request fails explicitly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

A GH profile names `@glm-harness/gh-base` first and its surface bundle second; `scripts/gh-init-profiles.ts` writes those profile manifests into a GH-owned Harness home. Everything else works as with `dsh-base`: later bundles and the profile's `cordis.patch.yml` address the rows here by id, and a patch replaces the targeted row's whole config.

### What you get

The dsh core minus the upstream business rows: sessions, tools, sandbox and approval policy, skills, subagents, jobs, workflows, spill, storage, settings, and credentials — plus the LLM seam itself (`dsh-llm`, `dsh-llm-retry`, `dsh-agent-default-model`) with no adapter registered. The default model route reads `provider: glm`, which no current layer provides, so a fresh agent without GH model routing fails with an unregistered-provider error rather than reaching an upstream endpoint.

### Changing the defaults

Edit the profile's `cordis.patch.yml` or add a later bundle; this package is not a library you import. GH model, account, and telemetry decisions land as their own `@glm-harness` packages and must not be inlined here.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Composition mechanics

`gh-base` mirrors the upstream `dsh-base` row set with ten rows removed (`deepseek-llm-api-extensions`, `session-log-deepseek`, `plugin-package-inventory-deepseek`, `deepseek-account`, `llm-pi-ai`, `otel`, `session-telemetry-otel`, `web-search-deepseek`, `llm-deepseek`, `llm-deepseek-account`) and two restated: `web` pins only `fetchProvider: http`, and `agent-default-model` names the GH provider id. The header of `cordis.patch.yml` and `scripts/check-gh-closure.ts` carry the same list; keep the three in sync when the boundary changes.

### Source map

- `cordis.patch.yml` — the entire bundle: the rows every GH profile mounts.
- `src/index.ts` — no runtime API; the manifest's `dsh.bundle.patch` is the substance.
- `scripts/check-gh-closure.ts` (repository root) — the gate that fails when a banned upstream package re-enters the `@glm-harness` dependency closure or a composed GH profile.

<a id="further-exploration"></a>
## Further Exploration

- [dsh-base](../../bundle/base/README.md) — the upstream shared core this layer is derived from; read it for the row-by-row semantics.
- [app-boot profiles](../../boot/app-boot/README.md#profiles) — how a profile stacks this bundle with surface bundles and user patches.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- No model adapter ships here. GLM provider routing, catalog, wire protocol, and accounts are the `@glm-harness` model packages (plan E02); until they land, GH profiles boot and run tools but every model request fails explicitly.
- No telemetry ships here. GH diagnostics and feedback (plan E09) will provide their own exporters with GH-owned endpoints; upstream OTel packages stay out of the closure.
- Web search is providerless until the GH search decision; `web_fetch` works through the anonymous HTTP fetch provider.
