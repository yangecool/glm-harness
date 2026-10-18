# GH Permission Modes

English | [中文](gh-permissions.zh.md)

GH permission modes are the ZCode-aligned permission surface owned by [gh-permissions](../../packages/glm/permissions) (`ctx.ghPermissions`, `GhPermissionService`): the three modes — full access (`yolo`), autonomous (`guarded`), and confirm-before-changes (`build`) — plus an independent plan restriction, all enforced at the `tools/pre-execute` waterfall before any tool dispatch. The plugin replaces GH's use of [permission presets](permission-presets.md): GH composes it instead of `dsh-permission-presets`, and the modes are executor decisions rather than bundles of the underlying [sandbox mode](sandbox.md) and [approval policy](approval.md) knobs, which keep their own rows and semantics. The [package README](../../packages/glm/permissions/README.md) owns composition status, the analyzer detail, and limitations.

Source: [`packages/glm/permissions/src/index.ts`](../../packages/glm/permissions/src/index.ts)

## Logged state and recovery

`permission/mode` (`{ mode }`) is a log-only, whole-value-replace [session event](session.md): durable and replayable, never in the model transcript. The `ghPermissions` projection unit folds the latest value and migrates legacy `permission/preset` selections interpretably (`edit` and `read-only` → `build`, `workspace-write` → `guarded`, `danger-full-access` → `yolo`) instead of resurrecting the preset menu. `ctx.ghPermissions` reads the fold through `stateOf()`; the first dependent access fails if the registry or the key is absent. Sessions without a logged selection use the composition default (`build` unless configured), and a delegated child starts from that same default rather than inheriting the parent's mode. The complete event declaration is in the [persistence log event catalog](../persistence-catalog.md).

## The decision order

The gate runs for every tool call with a caller agent, mirroring ZCode's permission-service order. `exit_plan_mode` passes only while plan mode is logged active. While plan is active — in every mode — proven read-only tools and user interaction run and every state change is denied with a reason naming `exit_plan_mode` or `/plan off`. Otherwise `yolo` runs general tools directly; `guarded` runs them unless the dangerous-command grammar matches, which asks once; `build` consults the rule table (`deny`, then `ask`, then `allow`), then auto-runs only read-class tools and shell commands the analyzer proves read-only, and asks for everything else, including anything unparsed. Tool-owned escalation approvals and the sandbox stay independent and unaffected by the mode. Every `ask` settles through the [approval seam](approval.md), so it is audited as an `approval/asked`/`approval/decided` pair and fails closed — a denial, never a silent run — when no answerer is composed.

## Shell analysis

The bundled POSIX analyzer produces word facts (quote/escape-processed values, expansion and unquoted-glob markers), segments commands over separators and pipes while stripping control keywords, unwrappers and env assignments, and scans redirections including static heredoc bodies. Command substitutions, backticks, and `shell -c` payloads are analyzed recursively, so a dangerous command hidden inside an expansion still matches. The dangerous grammar covers recursive/multi-target/glob `rm`, forced git history and tree loss, `find -delete`/`-exec`, the `dd`/`mkfs` family, and rsync `--delete`, using ZCode's option-table semantics; help, dry-run, and query forms are exempt. Anything outside the grammar marks the analysis `unsupported`, which never reads as safe: no dangerous match is claimed and no read-only proof is granted, so `build` asks.

## Configuration

```ts type-equiv
/** Plugin config: composition default mode and the rule table. */
interface Config {
  /** Mode for sessions without a logged selection; `build` when unset. */
  readonly defaultMode: Volatile<GhPermissionMode | undefined>
  /** Structured rules consulted in `build` mode (and recorded for all modes). */
  readonly rules: PermissionRules
}
```

The `defaultMode` deployment override fails plugin load on an invalid value rather than being ignored. Rule subjects content-match a call's `command`, `url`, `file_path`, `path`, `pattern`, or `patch_text` — exact, `prefix:*` for command prefixes, or `*` wildcards — and rule evaluation precedes the read-only proofs in `build` mode only; `yolo` and `guarded` bypass the table, matching the ZCode decision order.

## The `/permission` command

When [`ctx.commands`](commands.md) is composed, the plugin registers `/permission [<mode>]`: without an argument it reports the effective mode and plan state; with `yolo`, `guarded`, or `build` it appends the durable selection and narrates the switch to the model as one user notice. Legacy names resolve through the migration mapping with an explicit "(migrated …)" settlement instead of erroring. The command never touches an in-flight call: already-dispatched tools keep their decision, and the new mode governs the next gate evaluation.

## The service

`ctx.ghPermissions` owns the durable mode selection with narration, the `glm:permission-mode` runtime-context statement, the `/permission` command, and the executor gate; `get`/`set`/`effectiveMode` signatures are in the generated [service catalog](#ctxghpermissions--ghpermissionservice).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxghpermissions--ghpermissionservice"></a>

### `ctx.ghPermissions` — `GhPermissionService`

`ctx.ghPermissions`: the durable mode selection, its narration and prompt statement, the `/permission` command, and the executor-level gate.

```ts cordis-catalog
/**
 * The session's effective mode: its folded selection (migrated when legacy),
 * else the composition default.
 * @param session - the exact accepted session.
 * @returns the mode every gate decision for this session uses right now.
 */
effectiveMode(session: Session): GhPermissionMode

/**
 * Read one agent's current mode and plan state for display.
 * @param agent - the agent whose session is read.
 * @returns the effective mode and whether plan mode is logged active.
 */
get(agent: Agent): { mode: GhPermissionMode; plan: boolean }

/**
 * Switch one live agent's mode: append the durable selection and narrate the
 * change for the next model step. Switching does not touch an in-flight
 * call — already-dispatched tools keep their decision.
 * @param agent - the live agent whose mode changes.
 * @param mode - the new effective mode.
 */
set(agent: Agent, mode: GhPermissionMode): void
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/glm/permissions/src/index.ts`](../../packages/glm/permissions/src/index.ts)
<!-- END GENERATED cordis-surface -->
