---
description: "GH's plan-review ledger: revisioned plan submissions under the session log, a deterministic workspace plan file written on approval without ever clobbering user edits, and durable approval/rejection records bound to their revision."
kind: "package-reference"
---

# @glm-harness/gh-plan-review

English | [中文](README.zh.md)

## Summary

Mount this plugin to give plan review a durable record beside upstream plan mode: every plan that reaches the user becomes a numbered `gh-plan/*` revision under the session log, an approval writes the approved text verbatim to `<workspace>/.glm/plans/plan-<id>.md` — atomically, and never over user edits — and every outcome (approval, keep-planning feedback, dismissal, failure) is recorded bound to its revision. Replayed late approvals update nothing: the fold accepts only revisions at least as new as the recorded one.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

<a id="use-this-package"></a>

`@glm-harness/gh-base` composes the plugin for every shipped profile, right beside the plan gate (`@glm-harness/gh-permissions` composes the gate; `dsh-plan-mode` owns the mode).

### When to choose it

Choose it when a composition wants plan review to leave a durable trail — a revisioned history, a plan file in the workspace, and feedback annotations. Without it, plan review stays exactly upstream: the plan text lives only inside the tool call, and nothing is written to disk.

### Minimal configuration

```yaml
- id: gh-plan-review
  name: '@glm-harness/gh-plan-review'
```

`plansDir` defaults to `.glm/plans`; any workspace-relative directory without `..` segments works.

## Understand the implementation

<a id="understand-the-implementation"></a>

The service (`ctx.ghPlanReview`) registers the `ghPlanReview` projection and two observers:

- `user-questions/request` — recognizes the plan-review question by its intent, marks the exit call as having reached the user, and captures the structured answer (approve label vs decline, free-text feedback) or the dismissal (`ASK_CANCELLED`). It always delegates; it never answers.
- `tools/post-execute` — on a settled `exit_plan_mode` whose question actually reached the user, assigns the next revision (monotonic per session, seeded from the durable fold), appends `gh-plan/submitted`, then the outcome event. An approval writes the plan file first (temp file + rename; skipped when the file holds unrecognized content) and appends `gh-plan/approved` with `fileWritten` recording the truth. Calls that failed validation before any review (plan mode off, malformed plan) leave no events.

The plan file path is `<session header cwd>/<plansDir>/plan-<sanitized id>.md`; sessions without a workspace cwd record revisions with a null path and write nothing. The session id is reduced to `A-Za-z0-9._-` for the filename.

## Further Exploration

<a id="further-exploration"></a>

- `packages/glm/plan-review/tests/plan-review.spec.ts` — full-loop composition against the real agent loop, real user-questions service, and a scripted reviewer: approval/file/exact-text, keep-planning feedback, dismissal, the never-clobber sequence, monotonic revisions, no-review no-events, and the no-cwd case; plus pure fold tests for the X05 replay guard.
- `docs/subsystems/gh-plan-review.md` — the ledger's product contract and boundaries.
- `docs/persistence-changes/2026-10-19-gh-plan-review.md` — the three log-only events' compatibility record.

## Model Experience

### Plan-review ledger context

#### What the model sees

Nothing new. The plugin registers no prompt section, no tool, and no schema, rewrites no tool result, and asks no question. The model-facing behavior of `exit_plan_mode` (review question, approval exit, keep-planning error with feedback, dismissal turn end) is entirely upstream's. The `gh-plan/*` events are log-only and never enter a model request; the plan file is for the user and future continuity surfaces, not the request path.

#### Token effect

Zero: no prompt bytes, no message inserts, no request-shape changes.

#### KV Cache effect

None: the plugin contributes no prefix or history content, so cached request prefixes stay valid across every plan review.

## Known Limitations and Deferred Work

- No post-compaction reminder references the plan file yet (upstream compaction exposes no injection seam; recorded as GH-008 follow-up with the plan-file continuity design).
- Keep-planning feedback returns to the model as the upstream tool error in the same turn; the ZCode-style refinement (feedback as a real next user message, plain rejection ends the turn) is deferred to the workbench slice.
- Subagent sessions have no live human answerer upstream, so they cannot reach a review; the ledger simply records nothing there.
- No UI surface yet: the plan-file path and revision history are exposed through the projection (`ghPlanReview`) and `ctx.ghPlanReview.describe(agent)` for the client slice to render.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fold's approval guard is the X05 (late-result) rule in miniature: `revision < approvedRevision` or `revision >= nextRevision` folds to a no-op, so an old approval replayed after a newer one — or one naming an unknown future revision — cannot demote the ledger. The same conservatism drives the file write: the digest of what this session last wrote is the only content an approval may replace.

</details>
