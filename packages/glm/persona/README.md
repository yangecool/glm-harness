---
description: "The GLM Harness model identity and work policy as two static system-prompt sections: goal-driven execution, locate before modifying, self-verification, and honest reporting that promises nothing the composed tool catalog does not grant."
kind: "package-reference"
---

# @glm-harness/gh-persona

English | [中文](README.zh.md)

## Summary

Mount this plugin to give GLM sessions the GLM Harness identity and a coding work policy: understand before changing, make reviewable edits, verify before reporting, and respect the actual tool catalog. The sections are static text, so the request prefix stays byte-stable for provider caching, and disposing the plugin removes them without residue. It owns no tools, permissions, or model routing.

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

A GH profile mounts the plugin as one row next to the GLM adapter; `@glm-harness/gh-base` composes it for every shipped profile.

### When to choose it

Choose it when a composition wants the GLM Harness working behavior. A deployment that replaces the persona should disable this row and register its own sections; keeping both duplicates guidance.

### Minimal configuration

The plugin has no configuration; the sections are product content, not tunables. Compose it in `cordis.yml`:

```yaml
- id: gh-persona
  name: '@glm-harness/gh-persona'
```

The base bundle also sets `includeHarnessIdentity: false` on `dsh-system-prompt`, so this plugin's identity section replaces the upstream statement instead of stacking on it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/index.ts` registers two sections through `ctx.systemPrompt.section()` in the calling context's scope: `glm:identity` at the harness-identity order and `glm:work-policy` at the deployment-persona prefix order. Both registrations go through `ctx.effect()`, so disposal unwinds them together. The work policy names no tool, platform, directory, or permission — those facts belong to the tool catalog and runtime context, which is what keeps the text honest when a composition grants less.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Section names, identity text, work-policy text, and registration |
| [`tests/persona.spec.ts`](tests/persona.spec.ts) | Order, byte-stability, no-unavailable-promises, disposal, duplicate rejection |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@glm-harness/gh-base`](../base/README.md) — the composition that mounts this plugin and pins the tool order
- [`dsh-system-prompt`](../../core/system-prompt/README.md) — the registry the sections land in
- [`dsh-persona`](../../preset/persona/README.md) — the scope-only persona row for agent presets

-----

<a id="model-experience"></a>
## Model Experience

### GH persona sections

#### What the model sees

Two static sections (`glm:identity`, `glm:work-policy`) lead every assembly: the identity statement, then a six-line work policy covering goal progression, minimal reviewable changes, self-verification before completion, tool discipline, no claimed capabilities beyond the catalog, and user-only questions. The text is identical across turns and assemblies.

#### Token effect

The sections add a fixed prefix of roughly 200 tokens once per request; nothing per turn, tool, or file changes.

#### KV Cache effect

The static text keeps the system prefix byte-identical across requests, which preserves prefix-cache eligibility. Actual provider cache hits are read from reported counters, not assumed from this stability.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The policy is English-only model guidance; no per-project persona overrides exist yet (planned with model settings in the GH model-work-policy work).
- Tool-dialect variants (concise or hashline schemas) are future work; this policy works with the standard tool descriptions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

TOK01 evidence lives with the product smoke: the built profile's first main request must carry the identity and work policy with the upstream identity absent.

</details>
