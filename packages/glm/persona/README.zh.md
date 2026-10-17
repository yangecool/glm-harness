---
description: "GLM Harness 的模型身份与工作策略，作为两个静态系统提示段：目标推进、先定位再修改、自我验证与如实汇报，不承诺组合未授予的任何能力。"
kind: "package-reference"
---

# @glm-harness/gh-persona

[English](README.md) | 中文

## 概述

挂载本插件后，GLM 会话获得 GLM Harness 的身份与编码工作策略：先理解再改动、做可审阅的最小修改、报告前自我验证、尊重实际工具目录。两个段落是静态文本，请求前缀逐字节稳定以利于提供商缓存；卸载插件即一并移除，无残留。本插件不拥有工具、权限或模型路由。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

GH profile 在 GLM adapter 旁以一行挂载本插件；`@glm-harness/gh-base` 已为全部出厂 profile 组合它。

### 何时选择

需要 GLM Harness 工作行为的组合选择它。要替换 persona 的部署应禁用本行并注册自己的段落；两者并存会重复指导。

### 最小配置

本插件没有配置项；段落是产品内容而非可调参数。在 `cordis.yml` 中组合：

```yaml
- id: gh-persona
  name: '@glm-harness/gh-persona'
```

base bundle 同时把 `dsh-system-prompt` 的 `includeHarnessIdentity` 设为 `false`，因此本插件的身份段是替换而非叠加上游声明。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

`src/index.ts` 通过 `ctx.systemPrompt.section()` 在调用上下文的作用域注册两个段落：`glm:identity` 位于 harness 身身序位，`glm:work-policy` 位于部署 persona 前缀序位。两个注册都走 `ctx.effect()`，卸载时一并回退。工作策略不点名任何工具、平台、目录或权限——这些事实属于工具目录与运行时上下文，这正是组合授予更少能力时文案仍保持诚实的原因。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 段名、身份文案、工作策略文案与注册 |
| [`tests/persona.spec.ts`](tests/persona.spec.ts) | 顺序、字节稳定性、不承诺未有能力、卸载、重复注册拒绝 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`@glm-harness/gh-base`](../base/README.zh.md) —— 挂载本插件并固定工具顺序的组合
- [`dsh-system-prompt`](../../core/system-prompt/README.zh.md) —— 段落落入的注册表
- [`dsh-persona`](../../preset/persona/README.zh.md) —— 面向 agent preset 的作用域 persona 行

-----

<a id="model-experience"></a>
## 模型体验

### GH persona 段落

#### 模型看到什么

每次组装由两个静态段落(`glm:identity`、`glm:work-policy`)开头：身份声明，随后是六条工作策略，覆盖目标推进、最小可审阅修改、完成前自我验证、工具纪律、不声称目录之外的能力、只把真正属于用户的决定交给用户。文本在所有轮次与组装间完全一致。

#### Token 影响

两个段落每请求一次性增加约 200 token 的固定前缀；没有任何随轮次、工具或文件变化的部分。

#### KV Cache 影响

静态文本使系统前缀跨请求逐字节一致，保住前缀缓存资格。实际提供商缓存命中以返回计数器为准，不因稳定而假定。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 策略是英文模型指导；尚无按项目的 persona 覆盖（随 GH model-work-policy 的模型设置工作规划）。
- 工具方言变体（精简或 hashline schema）是后续工作；本策略配合标准工具描述工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 —— 点击展开</summary>

TOK01 证据随产品 smoke 保存：built profile 的首个主请求必须携带身份与工作策略，且上游身份缺席。

</details>
