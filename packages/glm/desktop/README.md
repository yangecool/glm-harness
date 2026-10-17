---
description: "The GH product layer over the dsh web-app surface: a reserved-name desktop composition overlay that removes upstream telemetry and analytics rows while the unmodified Electron shell boots the GH profile."
kind: "package-bundle"
---

# @glm-harness/gh-desktop

English | [中文](README.zh.md)

## Summary

The desktop Electron shell owns no GH business logic: it reads whatever composition `$DSH_HOME/profiles/desktop` provides and spawns the desktop host against it. A GH Harness home therefore initializes the reserved `desktop` profile with `@glm-harness/gh-base`, `@deepseek-ai/dsh-web-app`, and this bundle last. The overlay removes the two upstream rows whose enablement is keyed to the reserved profile name — the OTel product-telemetry exporter and the client analytics beacon — because a GH desktop composition must not report to upstream production endpoints. GH-owned observability arrives as its own layer; until then the composition mounts neither exporter.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

`scripts/gh-init-profiles.ts` writes the reserved `desktop` profile into a GH-owned Harness home with this bundle as the last layer. The bundle is only meaningful directly after `@deepseek-ai/dsh-web-app`: rows are addressed by id and the last write wins, so an earlier position would let the web-app patch re-enable the removed rows.

```yaml
bundles:
  - '@glm-harness/gh-base'
  - '@deepseek-ai/dsh-web-app'
  - '@glm-harness/gh-desktop'
```

### What you get

Two row removals, nothing else: `desktop-product-telemetry` and `product-analytics` become `disabled: true` in the composed profile. The workbench, webserver, client module roster, and every workbench surface stay exactly as the web-app bundle ships them.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Composition mechanics

The upstream web-app patch guards its telemetry rows with `profileContext.name !== 'desktop'`, so the rows stay dark for `gh-web` and light up only under the reserved desktop name — precisely the name a GH desktop home carries. Overlaying `disabled: true` by id, after the web-app layer, keeps the removal unconditional and reviewable: one file, one row pair, no Electron-main change and no upstream patch edit.

### Source map

- `cordis.patch.yml` — the overlay rows this bundle contributes.
- `src/index.ts` — module documentation only; no runtime API.

<a id="further-exploration"></a>
## Further Exploration

- `scripts/gh-init-profiles.ts` — the profile manifest writer for GH homes.
- `scripts/check-gh-closure.ts` — the gate proving no banned upstream package re-enters a composed GH profile.
- `packages/bundle/web-app/cordis.patch.yml` — the overlaid rows and their profile-name guards.

## Model Experience

### Composition effects

#### What the model sees

The overlay disables upstream telemetry rows and contributes no model-facing context.

#### Token effect

`gh-desktop` makes no independent model calls. The selected capability owners determine token use.

#### KV Cache effect

This layer does not serialize requests. Changes to selected model-facing capabilities can change prefixes; their owners document that effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Product identity (branding, window titles, deep links) still renders the upstream shell chrome; the gh-brand layer that replaces it is a separate GH task.
- GH-owned reporting and diagnostics replace the removed exporters in a later observability layer; until then no exporter is mounted.

<a id="dev-note"></a>
### Dev Note

Keep business behavior in its owning plugins and verify the composed profile.
