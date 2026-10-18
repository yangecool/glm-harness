---
description: "GH's ZCode-aligned permission modes — full access (yolo), autonomous (guarded), and confirm-before-changes (build) — with an independent plan gate, a structured dangerous-command grammar, and executor-level enforcement in the tools pre-execute waterfall."
kind: "package-reference"
---

# @glm-harness/gh-permissions

English | [中文](README.zh.md)

## Summary

Mount this plugin to give GH sessions the three ZCode-aligned permission modes plus an independent plan restriction, enforced where it counts: the `tools/pre-execute` waterfall, before any tool dispatch. `yolo` runs general tools directly; `guarded` adds one confirmation when the structured dangerous-command grammar matches; `build` (the default) auto-runs only proven read-only tools and asks for everything else. Plan mode denies state changes in every mode. The mode is a durable per-session selection with narrated switches, and asks settle through the shared approval chain, failing closed when nobody answers.

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

`@glm-harness/gh-base` composes the plugin for every shipped profile; it replaces the upstream `dsh-permission-presets` row, which GH disables.

### When to choose it

Choose it when a composition wants the GH permission surface. Without it, tool calls run under the upstream sandbox and approval knobs only, and `/permission` reports the composition default instead of a GH mode.

### Minimal configuration

```yaml
- id: gh-permissions
  name: '@glm-harness/gh-permissions'
```

Sessions without a logged selection use `build`. The composition default can be overridden (an invalid value fails plugin load rather than being ignored), and the `rules` table adds per-tool `deny`/`ask`/`allow` subjects consulted in `build` mode:

```yaml
- id: gh-permissions
  name: '@glm-harness/gh-permissions'
  config:
    defaultMode: !!js "process.env.GH_PERMISSION_MODE"
    rules:
      deny:
        - tool: bash
          subject: 'git push*'
      allow:
        - tool: write
          subject: '/tmp/*'
```

Subjects content-match the call's `command`, `url`, `file_path`, `path`, `pattern`, or `patch_text`: exact, `prefix:*` for command prefixes, or `*` wildcards. Switch the live session with `/permission yolo|guarded|build`; plan stays separate under `/plan`. Legacy selections (`edit`, DSH preset names) migrate interpretably and never reappear as menu options.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/index.ts` owns the `permission/mode` session event, the `ghPermissions` projection (with legacy `permission/preset` migration), the `glm:permission-mode` runtime-context statement, the `/permission` command, and the gate registered on `tools/pre-execute`. The decision order mirrors ZCode's permission service: plan-transition policy, the plan read-only gate (all modes), `guarded`'s dangerous-rule ask, the `yolo` direct run, the rule table (`deny` → `ask` → `allow`), then `build`'s class proofs. An `ask` is resolved by the tool runtime through `ctx.approval`, so every ask is audited as an `approval/asked`/`approval/decided` pair and fails closed without an answerer.

`src/analysis.ts` is a native POSIX analyzer: quote/escape-aware word facts (`dynamic`, unquoted globs), segmentation over `;`/newline/pipes with control-keyword stripping, wrapper and env-assignment unwrapping, redirection scanning with static heredoc skipping, and recursive analysis of `$(...)`/backtick and `shell -c` payloads — a dangerous command hidden in a substitution still matches. Anything outside the grammar marks the analysis `unsupported`, which never reads as safe: `build` asks, and no read-only proof is granted. The dangerous grammar covers `rm` (recursive, multi-target, glob), forced git history/tree loss (`reset --hard`, `clean -f`, forced push, `checkout`/`restore` tree discards, `stash clear`, `worktree remove -f`), `find -delete`/`-exec`, the `dd`/`mkfs` family, and rsync `--delete`, mirroring ZCode's option-table semantics.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Modes, durable fold, narration, prompt statement, `/permission`, and the executor gate |
| [`src/analysis.ts`](src/analysis.ts) | POSIX segmentation, word facts, dangerous grammar, read-only classification |
| [`tests/permissions.spec.ts`](tests/permissions.spec.ts) | Grammar table tests and real-composition gate tests across all modes |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@glm-harness/gh-base`](../base/README.md) — the composition that mounts this plugin and keeps the sandbox/approval services underneath
- [`dsh-user-approval`](../../interaction/user-approval/README.md) — the approval chain every ask settles through
- [`dsh-plan-mode`](../../plan/plan-mode/README.md) — the independent plan state the gate reads
- [`dsh-tools`](../../core/tools/README.md) — the `tools/pre-execute` waterfall the gate enforces in

-----

<a id="model-experience"></a>
## Model Experience

### GH permission mode statement

#### What the model sees

One runtime-context sentence (`glm:permission-mode`) stating the live mode: `Permission mode: full access.` auto-runs tools while noting plan and escalation limits; `Permission mode: autonomous.` notes the dangerous-operation confirmation; `Permission mode: confirm before changes.` names what asks. Switches arrive as a one-line user notice (`The session permission mode changed from "build" to "yolo" (changed by the user).`), and denials carry actionable reasons (plan restrictions name `exit_plan_mode` or `/plan off`).

#### Token effect

The statement is one sentence (~25 tokens) in the post-history runtime context; a switch adds one short notice message rather than rewriting the prefix.

#### KV Cache effect

The mode travels after retained history like the approval-policy statement, so a mid-session switch never rewrites the cached system prefix; only the new notice and future requests differ.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The analyzer covers POSIX bash only; `pwsh` arguments never receive a dangerous-match or read-only claim (build asks, guarded runs them unconfirmed like any unparsed command). CMD/Git Bash dialects land with Windows-shell support.
- The read-only proof is a conservative table: unknown commands, unknown git subcommands, and dynamic-heavy constructs ask in `build` instead of running; ZCode's full read-only policy tables are not ported wholesale. Output-file/execution options, command substitutions, and unknown wrapper syntax withhold that proof; sed needs explicit `--sandbox`. Plan also denies agent delegation and messaging until inherited read-only delegation is implemented.
- `build` mode asks are fail-closed in unattended runs by design; a headless confirmation flow (non-interactive defaults or queued approvals) is deferred with the remote work. Delegated subagent children keep the composition default and the upstream `never` approval pin — child approval routing to the user lands with the GH subagent slice.
- The composer mode control is wired through `@glm-harness/gh-ui-permissions` (three-option menu plus independent plan toggle, verified on the real Electron desktop); PER05/06/07/10 (draft/queue semantics, receipt replay, workspace identity, real-remote end-to-end) remain open acceptance gates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

PER02/03/04 local coverage lives in `tests/permissions.spec.ts` (real `ctx.tools.execute` through the gate); the built-profile evidence (build denial failing closed, yolo write-through, the mode sentence in the real system prompt) lives with the product smoke's `permission-build-denied` and `permission-yolo-writes` scenarios.

</details>
