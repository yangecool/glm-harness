---
description: "The GLM Harness shared core: the dsh public infrastructure as an explicit DeepSeek-free closure, for GH profiles that compose their own model, account, and telemetry layers."
kind: "package-bundle"
---

# @glm-harness/gh-base

English | [中文](README.zh.md)

## Summary

GH profiles share sessions, tools, workspace execution, settings, and the GH-native GLM adapter through this explicit public DSH composition. `scripts/gh-init-profiles.ts` selects the layer for shipped GH homes. The closure gate excludes upstream model, retry, account, and telemetry implementations. Missing GLM credentials fail explicitly. GH account integration remains separate implementation work; the ZCode permission modes ship as `gh-permissions`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

A GH profile names `@glm-harness/gh-base` first and its surface bundle second; `scripts/gh-init-profiles.ts` writes those profile manifests into a GH-owned Harness home. Everything else works as with `dsh-base`: later bundles and the profile's `cordis.patch.yml` address the rows here by id, and a patch replaces the targeted row's whole config.

### What you get

The dsh core minus the upstream business rows: sessions, tools, sandbox and approval policy, skills, subagents, jobs, workflows, spill, storage, settings, and credentials — plus the LLM seam itself (`dsh-llm`, `dsh-agent-default-model`) and the GH-native `gh-model-glm` adapter. The default route is `provider: glm`, `model: glm-4.6`; without credentials it fails explicitly with `MISSING_CREDENTIAL`. The upstream retry executor is excluded; the GH-owned bounded executor (`gh-model-retry`) runs the GLM route's provider policy on the agent request-recovery point.

### Changing the defaults

Edit the profile's `cordis.patch.yml` or add a later bundle; this package is not a library you import. GH model, account, and telemetry decisions land as their own `@glm-harness` packages and must not be inlined here.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Composition mechanics

`gh-base` mirrors the upstream `dsh-base` row set with eleven business rows excluded (`deepseek-llm-api-extensions`, `session-log-deepseek`, `plugin-package-inventory-deepseek`, `deepseek-account`, `llm-pi-ai`, `otel`, `session-telemetry-otel`, `web-search-deepseek`, `llm-deepseek`, `llm-deepseek-account`, `llm-retry`) and the GH-native `model-glm`, `model-retry`, and `gh-persona` rows added; two shared rows are restated: `web` pins only `fetchProvider: http`, and `agent-default-model` names the GH provider id. The header of `cordis.patch.yml` and `scripts/check-gh-closure.ts` carry the same list; keep the three in sync when the boundary changes.

### Source map

- `cordis.patch.yml` — the entire bundle: the rows every GH profile mounts.
- `src/index.ts` — no runtime API; the manifest's `dsh.bundle.patch` is the substance.
- `scripts/check-gh-closure.ts` (repository root) — the gate that fails when a banned upstream package re-enters the `@glm-harness` dependency closure or a composed GH profile.

<a id="further-exploration"></a>
## Further Exploration

- [dsh-base](../../bundle/base/README.md) — the upstream shared core this layer is derived from; read it for the row-by-row semantics.
- [app-boot profiles](../../boot/app-boot/README.md#profiles) — how a profile stacks this bundle with surface bundles and user patches.

## Model Experience

### Composition effects

#### What the model sees

The bundle selects model/tool/prompt capabilities; their owning plugins determine the actual request. It adds no independent prompt text.

#### Token effect

`gh-base` makes no independent model calls. The selected capability owners determine token use.

#### KV Cache effect

This layer does not serialize requests. Changes to selected model-facing capabilities can change prefixes; their owners document that effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The GH-native text/tool GLM adapter is composed here. Full model configuration and account/PAT integration remain pending (plan E02); GH-owned bounded retry ships here, and per-purpose model budgets arrive with the model-work-policy work. The ZCode three permission modes (`yolo`/`guarded`/`build`, plan independent) now ship here through `gh-permissions`, enforced at the tool executor; the DSH preset row is disabled and the web composer mode control arrives with the GH UI slice.
- No telemetry ships here. GH diagnostics and feedback (plan E09) will provide their own exporters with GH-owned endpoints; upstream OTel packages stay out of the closure.
- Web search is providerless until the GH search decision; `web_fetch` works through the anonymous HTTP fetch provider.

<a id="dev-note"></a>
### Dev Note

Keep business behavior in its owning plugins and verify the composed profile.
