---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-18-rpc-admission-fingerprint

[English](2026-10-18-rpc-admission-fingerprint.md) | 中文

## 概述

在 user-rpc 来源的可选字段中保留原始请求指纹，用于跨重启的持久接纳对账。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

字段可选；额外来源元数据不改变消息渲染与模型输入。已有记录保留旧文本比较；缺失原始身份的附件明确返回不可比较。不会重写已发布代际，也不会因回放执行工具。

<a id="verification"></a>
## 验证

接纳、待确认提交、Supervisor、版本与 bundle-roster 定向回归：6 文件 / 100 测试通过；更广 Session/Gateway 回归单独记录。

<a id="dev-note"></a>
## 开发备注

无。
