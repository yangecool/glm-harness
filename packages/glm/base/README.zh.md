---
description: "GLM Harness 共享核心：以不含 DeepSeek 业务的显式闭包组合 dsh 公共基础设施，供自行组合模型、账号与遥测层的 GH profile 使用。"
kind: "package-bundle"
---

# @glm-harness/gh-base

[English](README.md) | 中文

## 概述

每个 GH profile 都运行在 `gh-base` 之上，因此各 GH 界面共享完整的工具集、持久会话历史、工作区安全默认值和同一个供应方中立的 LLM 接缝——同时不携带任何上游模型、账号或遥测业务。本 bundle 的依赖清单就是产品对 dsh 公共包的最小闭包：`@deepseek-ai/dsh-llm-pi-ai`、DeepSeek 模型适配器与账号平台、DeepSeek 会话日志扩展、DeepSeek 网页搜索供应方和 OTel 导出器既不在本 manifest 中，也不在组合出的树里；`scripts/check-gh-closure.ts` 会在它们任何一方重新出现时报错。模型接入不是回退决策：GLM 路由以 `@glm-harness` 模型插件的形式挂载到同一个 `ctx.llm` 接缝上；在该层挂载之前，模型请求会显式失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

GH profile 先写 `@glm-harness/gh-base`，再写它的界面 bundle；`scripts/gh-init-profiles.ts` 会把这些 profile manifest 写入 GH 自己的 Harness home。其余行为与 `dsh-base` 一致：后续 bundle 和 profile 的 `cordis.patch.yml` 按 id 引用这里的行，patch 会整体替换目标行的 config。

### 你会得到什么

dsh 核心减去上游业务行：会话、工具、沙箱与审批策略、技能、子代理、后台任务、工作流、spill、存储、设置和凭据——以及 LLM 接缝本身（`dsh-llm`、`dsh-llm-retry`、`dsh-agent-default-model`），但不注册任何适配器。默认模型路由为 `provider: glm`，当前没有任何层提供它，因此在 GH 模型路由落地之前，新建 agent 会以"供应方未注册"错误显式失败，而不是触达上游端点。

### 修改默认值

编辑 profile 的 `cordis.patch.yml` 或添加后续 bundle；本包不是供 import 的库。GH 的模型、账号和遥测决策以独立的 `@glm-harness` 包落地，不得内联到这里。

<a id="understand-the-implementation"></a>
## 理解实现

### 组合机制

`gh-base` 镜像上游 `dsh-base` 的行集，移除了十行（`deepseek-llm-api-extensions`、`session-log-deepseek`、`plugin-package-inventory-deepseek`、`deepseek-account`、`llm-pi-ai`、`otel`、`session-telemetry-otel`、`web-search-deepseek`、`llm-deepseek`、`llm-deepseek-account`），并重述了两行：`web` 只固定 `fetchProvider: http`，`agent-default-model` 指向 GH 供应方 id。`cordis.patch.yml` 的头部注释与 `scripts/check-gh-closure.ts` 维护同一份清单；边界变化时三处必须同步。

### 源码地图

- `cordis.patch.yml` —— 整个 bundle：每个 GH profile 挂载的全部行。
- `src/index.ts` —— 无运行时 API；manifest 的 `dsh.bundle.patch` 才是实质。
- `scripts/check-gh-closure.ts`（仓库根）—— 当被禁上游包重新进入 `@glm-harness` 依赖闭包或组合后的 GH profile 时报错的门禁。

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-base](../../bundle/base/README.zh.md) —— 本层的上游来源；逐行语义请读它。
- [app-boot profiles](../../boot/app-boot/README.zh.md#profiles) —— profile 如何把本 bundle 与界面 bundle、用户 patch 叠加。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 此处不携带任何模型适配器。GLM 供应方路由、目录、wire 协议和账号属于 `@glm-harness` 模型包（计划 E02）；在它们落地之前，GH profile 可以启动并运行工具，但每个模型请求都会显式失败。
- 此处不携带遥测。GH 诊断与反馈（计划 E09）将提供带 GH 自有端点的导出器；上游 OTel 包保持闭包之外。
- 在 GH 搜索决策落地前没有网页搜索供应方；`web_fetch` 通过匿名 HTTP fetch 供应方工作。
