---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-gh-permission-mode

English | [中文](2026-10-17-gh-permission-mode.zh.md)

## Summary

Adds the log-only permission/mode session event and the gh-permissions narration source on user messages for GH's ZCode-aligned permission modes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-gh-permission-mode
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "e52a1a0c62710b1cb0a9c9f40b01469b0c68e15bde3a700cbf267023dea9d919"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "5191ed7e7ef25de1d464774eb3ca59e416c578c5d4430cec500b4d9a7bef20cd"
    decision: same-version
  - root: "event:permission/mode"
    previous: null
    after: "4ac920f7ccb18c191ae93b1bf57640cf50acd94bb06f60fd9603a14b1309ec9e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "2f31cfe5ce77d5463a4a8f54bc4d0a4b9c5a413b61a4701a056d84547fce6740"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "53d8eaaaf559768168433f1a8c1355dcfea9180656fcaa4f03446bee7c1b5c3a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain neither and stay valid. permission/mode is a log-only whole-value override in the shape of approval/policy: readers without gh-permissions skip it as an opaque unrelated event and change no model-visible surface; the ghPermissions projection is its only reader. The gh-permissions source is qualified attribution on an ordinary user message; readers without the plugin preserve the message and derive history from its content, and the source kind plays no role in any model request. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

node node_modules/vitest/vitest.mjs run packages/glm/permissions/tests: 66 tests passed, covering the durable fold, legacy preset migration, narration delivery, and executor gate. scripts/persistence-changes.ts --check passes after this record.

<a id="dev-note"></a>
## Dev Note

None.
