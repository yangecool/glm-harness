---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-18-rpc-admission-fingerprint

English | [中文](2026-10-18-rpc-admission-fingerprint.zh.md)

## Summary

Retains the original RPC prompt fingerprint in an optional user-rpc source field for durable retry reconciliation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-18-rpc-admission-fingerprint
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-gh-permission-mode"
    after: "ad781c6220c9ea8164c2043a9b4bd921c92356fc0ca9ca6d64b4fbd9902352de"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-gh-permission-mode"
    after: "ffd6ae72b28e5cc7592879a37e93f6b821295443ad69c8f1cc968968c192995a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-gh-permission-mode"
    after: "0e6db2637cd127e0c356c7a401c4563c9afe94f8294fa204d9da82c8c65d4839"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-gh-permission-mode"
    after: "49f395ac8a12deff0f4a9e57844e3165b9e280f33d6c201e60c62fc8a7dfc237"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The field is optional and extra source metadata does not affect message rendering or model input. Existing records retain legacy text reconciliation; attachment records without an identity remain explicitly unverifiable. No released generation is rewritten and no replay executes tools.

<a id="verification"></a>
## Verification

Focused admission, pending-submission, supervisor, release and bundle-roster regressions: 6 files / 100 tests passed; broader Session and Gateway regressions run separately.

<a id="dev-note"></a>
## Dev Note

None.
