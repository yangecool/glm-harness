---
description: "GLM Harness 共享核心：以不含 DeepSeek 业务的显式闭包组合 dsh 公共基础设施，供自行组合模型、账号与遥测层的 GH profile 使用。"
kind: "package-bundle"
---

# @glm-harness/gh-base

[English](README.md) | 中文

## 概述

GH profile 通过这层显式公共 DSH 组合共享会话、工具、工作区执行、设置和 GH 原生 GLM 适配器。`scripts/gh-init-profiles.ts` 为 GH home 选择此层。闭包门禁排除上游模型、重试、账号和遥测实现。无 GLM 凭据时显式失败。GH 账号与 ZCode 权限策略仍需分别实现;GH 自有有界重试已随本层交付。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

GH profile 先写 `@glm-harness/gh-base`，再写它的界面 bundle；`scripts/gh-init-profiles.ts` 会把这些 profile manifest 写入 GH 自己的 Harness home。其余行为与 `dsh-base` 一致：后续 bundle 和 profile 的 `cordis.patch.yml` 按 id 引用这里的行，patch 会整体替换目标行的 config。

### 你会得到什么

dsh 核心减去上游业务行：会话、工具、沙箱与审批策略、技能、子代理、后台任务、工作流、spill、存储、设置和凭据——以及 LLM 接缝本身（`dsh-llm`、`dsh-agent-default-model`），以及 GH 原生的 `gh-model-glm` 适配器、`model-retry` 重试执行器和 `gh-persona` 工作策略。默认路由为 `provider: glm`、`model: glm-4.6`；无凭据时以 `MISSING_CREDENTIAL` 显式失败。上游重试执行器已排除;GH 自有的有界执行器(`gh-model-retry`)在 agent 请求恢复点上运行 GLM 路由的 provider 策略。

### 修改默认值

编辑 profile 的 `cordis.patch.yml` 或添加后续 bundle；本包不是供 import 的库。GH 的模型、账号和遥测决策以独立的 `@glm-harness` 包落地，不得内联到这里。

<a id="understand-the-implementation"></a>
## 理解实现

### 组合机制

`gh-base` 镜像上游 `dsh-base` 的行集，排除了十一条业务行（`deepseek-llm-api-extensions`、`session-log-deepseek`、`plugin-package-inventory-deepseek`、`deepseek-account`、`llm-pi-ai`、`otel`、`session-telemetry-otel`、`web-search-deepseek`、`llm-deepseek`、`llm-deepseek-account`、`llm-retry`），添加 GH 原生 `model-glm` 行，并重述了两条共享行：`web` 只固定 `fetchProvider: http`，`agent-default-model` 指向 GH 供应方 id。`cordis.patch.yml` 的头部注释与 `scripts/check-gh-closure.ts` 维护同一份清单；边界变化时三处必须同步。

### 源码地图

- `cordis.patch.yml` —— 整个 bundle：每个 GH profile 挂载的全部行。
- `src/index.ts` —— 无运行时 API；manifest 的 `dsh.bundle.patch` 才是实质。
- `scripts/check-gh-closure.ts`（仓库根）—— 当被禁上游包重新进入 `@glm-harness` 依赖闭包或组合后的 GH profile 时报错的门禁。

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-base](../../bundle/base/README.zh.md) —— 本层的上游来源；逐行语义请读它。
- [app-boot profiles](../../boot/app-boot/README.zh.md#profiles) —— profile 如何把本 bundle 与界面 bundle、用户 patch 叠加。

<a id="model-experience"></a>
## 模型体验

<a id="composition-effects"></a>
### 组合影响

<a id="what-the-model-sees"></a>
#### 模型所见

本 bundle 选择模型/工具/提示能力，实际请求由对应插件决定，本层不独立添加提示文本。

<a id="token-effect"></a>
#### Token 影响

`gh-base` 不独立调用模型，token 消耗由组合出的能力 owner 决定。

<a id="kv-cache-effect"></a>
#### KV Cache 影响

本层不序列化请求。改变模型可见能力的选择可能改变前缀，具体影响由对应 owner 说明。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 此处已组合 GH 原生文本/工具 GLM 适配器。完整模型配置与账号/PAT 集成尚待完成(计划 E02);GH 自有有界重试已在此交付,purpose 级模型预算随模型工作方式工作交付。当前权限预设仍继承 DSH 行为；ZCode 三种权限需要独立实现策略与 UI。
- 此处不携带遥测。GH 诊断与反馈（计划 E09）将提供带 GH 自有端点的导出器；上游 OTel 包保持闭包之外。
- 在 GH 搜索决策落地前没有网页搜索供应方；`web_fetch` 通过匿名 HTTP fetch 供应方工作。

<a id="dev-note"></a>
### 开发备注

业务行为保留在其所属插件，并验证组合后的 profile。
