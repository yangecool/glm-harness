---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-gh-permission-mode

[English](2026-10-17-gh-permission-mode.md) | 中文

## 概述

为 GH 的 ZCode 对齐权限模式新增 log-only 的 permission/mode 会话事件，以及用户消息上的 gh-permissions 叙述来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

既有日志两者皆无，保持有效。permission/mode 是与 approval/policy 同形的 log-only 整值覆盖：未组合 gh-permissions 的读取方将其作为无关的未知事件跳过，不改变任何模型可见表面；ghPermissions 投影是它唯一的读取方。gh-permissions 来源是普通用户消息上的限定性归属：未组合该插件的读取方保留消息并从内容推导历史，来源 kind 不参与任何模型请求。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run packages/glm/permissions/tests：66 项测试通过，覆盖持久折叠、旧预设迁移、叙述投递与执行器门禁。本记录生成后 scripts/persistence-changes.ts --check 通过。

<a id="dev-note"></a>
## 开发备注

无。
