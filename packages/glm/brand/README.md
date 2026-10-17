---
description: "The GLM Harness product identity: browser occupants for the generic brand slots plus the GLM color ramp as a runtime cascade override, composed as a bundle layer over the dsh web-app surface."
kind: "package-bundle"
---

# @glm-harness/gh-brand

English | [中文](README.zh.md)

## Summary

The GLM product identity over the dsh client shell, composed the way Grok Harness composed its own: a bundle layer applied after `@deepseek-ai/dsh-web-app` that turns the official brand row off and mounts this package, whose browser half occupies the generic brand slots (the sidebar mark and name, and the conversation-hero mark) with the GLM spark mark and wordmark, and installs the GLM color ramp as a runtime cascade override of the platform stylesheet's accent custom properties. No upstream theme file changes, and no Electron-main code: removing this bundle layer restores the stock identity and ramp wholesale.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

`scripts/gh-init-profiles.ts` lists this bundle directly after `@deepseek-ai/dsh-web-app` in the `gh-web` and reserved `desktop` profiles; rows are addressed by id and the last write wins, so an earlier position would let the web-app patch re-mount the official occupants.

```yaml
bundles:
  - '@glm-harness/gh-base'
  - '@deepseek-ai/dsh-web-app'
  - '@glm-harness/gh-brand'
```

### What you get

Three slot occupants (sidebar mark/name, hero mark), the GLM accent ramp overriding `--dsw-static-deepseek-*` and the onboarding accent in both theme blocks, and the platform-suffix badge composing `GLM` + `HARNESS` the way the shell composes product and platform identity.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Composition mechanics

The mark is a mask (`/glm-mark.svg`, `currentColor` fill), so one silhouette follows light/dark and every host surface; the wordmark letters render in the shipped Montserrat brand font rather than path artwork. The ramp override re-declares the same custom properties on the same selectors (`body`, `body[data-ds-dark-theme]`) in a stylesheet appended after every static sheet, winning by document order; disposal removes it.

### Beyond plugin seams

The surfaces without plugin seams carry GLM identity through copy and asset swaps in the repository's build inputs, each following the Grok Harness precedent: the document title and favicon links in `apps/web/index.html`, the `glm-*` assets and manifest in `apps/web/public/`, the product-name strings in `apps/desktop/src/locale.ts`, the welcome wordmark asset and update-dialog accent in `apps/desktop/renderer/`, and the client locale copy (brand fallback, hero headline, welcome notice). Each is a string or asset change with no logic change.

### Source map

- `cordis.patch.yml` — the overlay rows (disable `ui-brand-official`, insert `gh-brand`).
- `src/client/Brand.tsx` — the mark, wordmark, and badge occupants.
- `src/client/theme.ts` — the GLM ramp and its stylesheet installer.
- `src/index.ts` — host Loader seat; no runtime API.

<a id="further-exploration"></a>
## Further Exploration

- `brand` in the Grok Harness runtime — the precedent this package follows.
- `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` — the slots' host surfaces and stock fallbacks.
- `packages/client/ui-theme/src/styles/design-platform.css` — the token vocabulary the ramp override targets.

## Model Experience

### Composition effects

#### What the model sees

Only browser identity and theme slots change. The plugin contributes no prompt, tool schema, or model message.

#### Token effect

`gh-brand` makes no independent model calls. The selected capability owners determine token use.

#### KV Cache effect

This layer does not serialize requests. Changes to selected model-facing capabilities can change prefixes; their owners document that effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The framework-free boot page keeps the platform wordmark `HARNESS`; it is product-neutral and shared across harness products.
- The launcher's `dsh` bin name and console prefixes stay upstream; product command naming (`glmh`) belongs to the packaging task.
- The update/install and welcome desktop windows are verified at the asset and copy level on this machine (no display, no Electron binary); runtime screenshots of those windows arrive with the packaged desktop build.

<a id="dev-note"></a>
### Dev Note

Keep business behavior in its owning plugins and verify the composed profile.
