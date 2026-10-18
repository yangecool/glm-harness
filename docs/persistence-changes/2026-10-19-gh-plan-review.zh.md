---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-gh-plan-review

[English](2026-10-19-gh-plan-review.md) | 中文

## 概述

新增 log-only 的 gh-plan/submitted、gh-plan/approved、gh-plan/rejected 会话事件：计划审阅 revision 台账，记录每次计划呈现、与 revision 绑定的结局，以及批准时的工作区计划文件写入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

既有日志不含这三个事件，保持有效；三者均为 log-only、非表面、整记录追加，形态与 permission/mode 一致。没有 gh-plan-review 的读取方将它们当作不透明无关事件跳过，不改变任何模型可见表面；ghPlanReview 投影是唯一读取方，折叠保持容忍（未知 revision 与重放的旧批准均为无操作），计划文件本身在会话日志之外。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run packages/glm/plan-review：12 用例通过，覆盖完整回环组合（批准精确写文本、继续规划反馈、驳回、不覆盖、单调 revision、未审阅无事件、无 cwd）与 X05 折叠重放防护。本记录后 scripts/persistence-changes.ts --check 通过。

<a id="dev-note"></a>
## 开发备注

无。
