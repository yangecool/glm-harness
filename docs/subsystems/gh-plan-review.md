# GH Plan Review

English | [中文](gh-plan-review.zh.md)

GH plan review is the durable ledger around plan-mode's review boundary, owned by [gh-plan-review](../../packages/glm/plan-review) (`ctx.ghPlanReview`, `GhPlanReviewService`). Upstream [plan mode](plan.md) keeps the mode toggle, the model-facing `exit_plan_mode` tool, and the review question; this plugin is a pure observer beside it — it replaces no tool result, prompts nothing, and changes no model-visible behavior. What it adds is the record: a numbered revision for every plan that actually reached the user, a deterministic plan file written on approval, and an outcome event bound to each revision. The [package README](../../packages/glm/plan-review/README.md) owns composition status and limitations.

Source: [`packages/glm/plan-review/src/index.ts`](../../packages/glm/plan-review/src/index.ts)

## Logged state and recovery

Three log-only, non-surface [session events](session.md): `gh-plan/submitted` (`{ revision, planPath, planSha256 }`), `gh-plan/approved` (`{ revision, planPath, planSha256, fileWritten }`), and `gh-plan/rejected` (`{ revision, outcome, feedback }`, with `outcome` one of `keep-planning`, `dismissed`, `failed`). The `ghPlanReview` projection folds them into `{ nextRevision, approvedRevision, writtenSha256, planPath }`; resume and fork restore the ledger by folding the log, and the wire view exposes `{ revision, approvedRevision, planPath }` for clients. The fold's approval guard is the X05 late-result rule: an approval for a revision older than the recorded one, or naming a revision no submission introduced, folds to a no-op — a replayed late approval (reconnect redelivery, fork inheritance) can never demote the ledger. The complete event declarations are in the [persistence log event catalog](../persistence-catalog.md) and the [change record](../persistence-changes/2026-10-19-gh-plan-review.md).

## The observation seam

The service watches two waterfalls and delegates in both. `user-questions/request` recognizes the plan-review question by its intent (`kind: 'plan-review'`, carrying the exit call's `callId`), marks that call as having reached the user, and captures the structured answer — the approve option or a decline, plus free-text feedback — or the `ASK_CANCELLED` dismissal. `tools/post-execute` then runs on the settled `exit_plan_mode` result: a call whose question never reached the user (plan mode off, malformed plan, no answerer channel) leaves no events; a presented plan is assigned the session's next monotonic revision and recorded with its outcome — approval reads `{ approved: true }` from the result, keep-planning and dismissal follow the captured answer, and anything else records `failed` honestly.

## The plan file contract

An approval writes the approved text verbatim to `<session header cwd>/.glm/plans/plan-<sanitized session id>.md` — parents created, temp file plus rename, exactly the bytes the model submitted. The write happens only while the file is absent or still holds the content this session last wrote (`writtenSha256`); any other content is a user or external edit and is preserved untouched, with `fileWritten: false` recording the divergence. The approval itself is never blocked by a write failure. Sessions without a workspace cwd record revisions with a null path and write nothing.

## Configuration

```ts type-equiv
/** Plugin config: where plan files live inside the session's workspace cwd. */
interface GhPlanReviewConfig {
  /**
   * Workspace-relative directory for plan files, joined onto the session's
   * header cwd. Must be a plain relative path: no absolute form, no `..`
   * segments, no platform separators.
   */
  readonly plansDir: string
}
```

The default is `.glm/plans`; an invalid value fails plugin load rather than the first write.

## The service

`ctx.ghPlanReview` exposes the folded ledger (`describe`) and the deterministic path resolution (`planPathOf`) for UI and continuity consumers; signatures are in the generated [service catalog](#ctxghplanreview--ghplanreviewservice).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxghplanreview--ghplanreviewservice"></a>

### `ctx.ghPlanReview` — `GhPlanReviewService`

`ctx.ghPlanReview`: the plan-review ledger. Observes the plan-review question and the exit tool's settled result, assigns one revision per presented plan, appends the `gh-plan/*` events, and maintains the plan file under the session's workspace cwd.

```ts cordis-catalog
/**
 * Read the folded ledger for one agent's session.
 *
 * @param agent - the agent whose plan history is read.
 * @returns the newest revision, the newest approval, and the plan file path.
 */
describe(agent: Agent): GhPlanReviewView

/**
 * Resolve the deterministic plan file path for a session's workspace.
 *
 * @param session - the session whose header cwd anchors the path.
 * @returns `<cwd>/<plansDir>/plan-<sanitized id>.md`, or null without a cwd.
 */
planPathOf(session: Session): string | null
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/glm/plan-review/src/index.ts`](../../packages/glm/plan-review/src/index.ts)
<!-- END GENERATED cordis-surface -->
