---
description: "Revision-bound plan reviews, a durable approval ledger, and workspace plan files with external-edit detection."
kind: "package-reference"
---

# @glm-harness/gh-plan-review

English | [中文](README.zh.md)

## Summary

Mount this plugin beside upstream plan mode to record each presented plan as a numbered `gh-plan/*` revision. Revisions are allocated before awaiting an answer; superseded approvals are aborted before continuing the exit tool. Accepted approvals write the text verbatim to `<workspace>/.glm/plans/plan-<id>.md` after checking for external edits. The fold accepts only the newest submitted revision’s first approval.

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

The service (`ctx.ghPlanReview`) registers the `ghPlanReview` projection and two waterfall listeners:

- `user-questions/request` — allocates and logs the submission before delegating, then captures approval, feedback, or dismissal. In-flight records are scoped by Session and call id. An approval for a superseded revision throws `ASK_ABORTED` before the upstream exit tool continues.
- `tools/post-execute` — records the outcome against the revision allocated at presentation. Only a successful, accepted result for the latest revision may write a plan file and append approval. Rejected or failed results append rejection; calls that never reached this listener’s review flow leave no events.

The plan file path is `<session header cwd>/<plansDir>/plan-<sanitized id>.md`; sessions without a workspace cwd record revisions with a null path and write nothing. The session id is reduced to `A-Za-z0-9._-` for the filename.

## Further Exploration

<a id="further-exploration"></a>

- `packages/glm/plan-review/tests/plan-review.spec.ts` — full-loop composition against the real agent loop, real user-questions service, and a scripted reviewer: approval/file/exact-text, keep-planning feedback, dismissal, the never-clobber sequence, monotonic revisions, no-review no-events, and the no-cwd case; plus pure fold tests for the X05 replay guard.
- `docs/subsystems/gh-plan-review.md` — the ledger's product contract and boundaries.
- `docs/persistence-changes/2026-10-19-gh-plan-review.md` — the three log-only events' compatibility record.

## Model Experience

### Plan-review ledger context

#### What the model sees

The plugin adds no prompt section, tool, schema, or second question. Normal review responses stay upstream-owned. A superseded approval now returns an aborted-review error through the upstream tool path; it cannot approve the newer plan. The `gh-plan/*` events remain log-only. The plan text is reconstructable from the logged tool call.

#### Token effect

Normal reviews add no prompt bytes or messages. An aborted stale review produces an upstream tool error; there is no fixed zero-token guarantee for that failure path.

#### KV Cache effect

No static prefix changes. A stale-review error is ordinary tool history and affects the suffix from that point.

## Known Limitations and Deferred Work

- Plan files currently use the local Node filesystem, not the execution provider’s filesystem. Remote-container/provider paths are unqualified. New files use exclusive publication; existing files are checked before atomic replacement, so edits detected at the check are preserved, while an external write after the check is not protected by a shared lock.
- No post-compaction reminder references the plan file yet (upstream compaction exposes no injection seam; recorded as GH-008 follow-up with the plan-file continuity design).
- Keep-planning feedback returns to the model as the upstream tool error in the same turn; the ZCode-style refinement (feedback as a real next user message, plain rejection ends the turn) is deferred to the workbench slice.
- Subagent sessions have no live human answerer upstream, so they cannot reach a review; the ledger simply records nothing there.
- No UI surface yet: the plan-file path and revision history are exposed through the projection (`ghPlanReview`) and `ctx.ghPlanReview.describe(agent)` for the client slice to render.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Projection state version 2 rebuilds the ledger using contiguous submissions and latest-only approvals. File-write failure records `fileWritten: false` without revoking an otherwise valid approval.

</details>
