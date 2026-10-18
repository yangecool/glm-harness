---
description: "The GH composer permission chip: the three ZCode-aligned modes plus an independent plan toggle in one conversation-input control, reading the ghPermissions and plan session projections and writing through the /permission and /plan commands."
kind: "package-bundle"
---

# @glm-harness/gh-ui-permissions

English | [中文](README.zh.md)

## Summary

Mount this client bundle to put the GH permission surface into the composer: one chip showing the live mode, with a menu carrying the three fixed modes (`build`, `guarded`, `yolo`) and an independent plan entry. The chip renders exactly what the executor enforces — the `ghPermissions` and `plan` session projections, both host-folded durable facts — and every pick writes through the session command line (`/permission <mode>`, `/plan`), so the chip, the slash surface, and the session log share one path. `yolo` carries the same explicit risk confirmation as every full-access surface.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

`@glm-harness/gh-base` inserts the row for every shipped profile; it replaces the upstream `dsh-client-ui-permission-presets` chip, whose host row GH disables.

### When to choose it

Choose it when a surface should expose the GH modes. Without it, the composer has no permission control and mode switches happen only through the `/permission` command.

### Minimal configuration

```yaml
- id: ui-gh-permissions
  name: '@glm-harness/gh-ui-permissions'
```

<a id="understand-the-implementation"></a>
## Understand the implementation

The client entry injects `commandUi`, `sessions`, `slots`, `locale`, `remote`, and `remote.commands`. It registers the `conversation.input.permission` slot with a per-session injected face: the `ghPermissions` projection observable (the chip's current value), a `select` that executes `/permission <mode>`, and a `togglePlan` that reads the `plan` projection to pick `/plan` or `/plan off`. The component is a fixed three-mode radio plus the plan entry — the mode set is a product constant, so there is no host catalog round-trip. The chip disappears (renders null) while the projection is unsupplied, which is exactly when the host lacks the GH permission service.

<a id="further-exploration"></a>
## Further Exploration

- `packages/glm/permissions` owns the modes, the gate, and the `/permission` command this chip writes through.
- `packages/client/ui-permission-presets` is the upstream preset chip this row replaces in GH compositions.

<a id="dev-note"></a>
## Dev Note

`dsh.client.inject` in the manifest gates browser loading: the entry activates only on surfaces whose host composition provides the session-controller, remotes, locale, commands, and conversation slots. The development desktop host resolves this package through the `@glm-harness/gh-base` dependency chain; the upstream preset chip's row stays disabled in the profile layer so the boot gate sees one occupant.

<a id="model-experience"></a>
## Model Experience

### Composer chip is user-facing

#### What the model sees

Nothing from this package directly: the model-facing mode statement, switch narration, and denial reasons belong to `gh-permissions`. A chip pick appends the same durable switch events a `/permission` line would, so the model sees the identical notice.

#### Token effect

No request-shape effect; chip interactions change no tool catalog and no prompt prefix.

#### KV Cache effect

None beyond the `gh-permissions` switch notice: picks never rewrite the cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The options are the fixed three-mode enum; host-configured extra modes or per-mode descriptions from a live catalog are not modeled (by design — GH ships exactly three modes).
- The plan entry hides while the `plan` projection is unsupplied; it does not distinguish per-surface plan implementations.
- The chip lives in the conversation input slot, so it renders only inside an open session, never on the workspace home screen.
- Dictionaries cover `zh` and `en` only; other locales fall back to `en`.
