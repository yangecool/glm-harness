---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-gh-plan-review

English | [中文](2026-10-19-gh-plan-review.zh.md)

## Summary

Adds the log-only gh-plan/submitted, gh-plan/approved, and gh-plan/rejected session events: the plan-review revision ledger that records every plan presentation, its outcome bound to its revision, and the workspace plan-file write on approval.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-gh-plan-review
baseline: false
changes:
  - root: "event:gh-plan/approved"
    previous: null
    after: "538d8678429406dbd4b1181f47cf0a2942fe8da56d6829dec6abc9577953de29"
    decision: same-version
  - root: "event:gh-plan/rejected"
    previous: null
    after: "c4406d4c8aa51bb47db7ef7cd9f159fdbb035b3c6d530cb7bfa5c294a746f53d"
    decision: same-version
  - root: "event:gh-plan/submitted"
    previous: null
    after: "b7050859976b1f19641d9517d4d02b8741cbcacbd1c0b5fab77521bff4c99c7f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain none of the three events and stay valid; all are log-only, non-surface, whole-record appends in the shape of permission/mode. Readers without gh-plan-review skip them as opaque unrelated events and change no model-visible surface; the ghPlanReview projection is their only reader, folds them tolerantly (unknown revisions and replayed older approvals are no-ops), and the plan file lives outside the session log entirely. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

node node_modules/vitest/vitest.mjs run packages/glm/plan-review: 12 tests passed, covering the full-loop composition (approval writes the exact text, keep-planning feedback, dismissal, never-clobber, monotonic revisions, no-review no-events, no-cwd) and the X05 fold replay guard. scripts/persistence-changes.ts --check passes after this record.

<a id="dev-note"></a>
## Dev Note

None.
