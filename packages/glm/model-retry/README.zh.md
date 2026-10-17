---
description: "GLM Harness 自写的有界模型请求重试执行器：在 agent 请求恢复点上执行 provider 声明的 normal 模式策略，重试事件持久化、等待可取消、显式拒绝无界重试。"
kind: "package-reference"
---

# @glm-harness/gh-model-retry

[English](README.md) | 中文

## 概述

挂载本执行器后，瞬态 GLM 请求失败会按 provider 声明的预算重试：每次重试在可取消等待之前先落会话日志，重启后从重放的事件恢复预算，token 计量与重试 UI 看到的是同一条物理尝试链。超过策略上限的 provider `Retry-After`、耗尽的预算或 `always` 策略都会显式失败本步——GH 展示重试状态，而不是 invisible 地等待。

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

GH profile 在 GLM adapter 旁以一行挂载本执行器；`@glm-harness/gh-base` 已为全部出厂 profile 组合它。

### 何时选择

希望对瞬态模型失败做有界、可观察恢复的组合选择它。倾向立即显式失败的部署禁用本行；GLM 路由随后在第一次尝试就呈现每个失败。

### 最小配置

执行器没有配置；各 provider 注册拥有自己的重试策略（provider 配置下的 `retryPolicy`，经公共 `RetryPolicySchema` 解析）。在 `cordis.yml` 中组合：

```yaml
- id: model-retry
  name: '@glm-harness/gh-model-retry'
```

`glm` 路由默认 normal 模式三次重试，覆盖 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` 与 `STREAM_CLOSED`；鉴权、配额、请求形状与截断失败保持终态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

`src/index.ts` 监听 `agent/request-error` waterfall——loop 的请求恢复扩展点——并执行失败步捕获的 provider 策略。持久计数键是 `(provider, 策略内容)`：`llmRetry` 会话投影折叠已提交的 `llm/retry` 事件，重启后延续同一预算而不是重置，`step/start` 重置链条。重试身份（`RetryId`）在一条链内稳定，经 provider 中立的 Agent 类型契约与既有重试 UI 和 token 计量消费者共享。卸载时中止所有活跃等待并排水被跟踪的恢复。

有界-only 规则有两处边界：`always` 策略被大声拒绝（记录日志并委托，步骤失败而不是无预算重试）；超过 `maxDelayMs` 的 provider `Retry-After` 令步骤失败，而不是让会话停泊在长等待上。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 策略执行、持久事件、可取消等待、卸载排水 |
| [`tests/retry.spec.ts`](tests/retry.spec.ts) | 恢复、预算耗尽、retry-after 上限、取消、重放、配置拒绝 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`@glm-harness/gh-model-glm`](../model-glm/README.zh.md) —— 本执行器运行其策略的路由
- [`dsh-llm` 重试策略](../../llm/llm/README.zh.md) —— 公共策略 schema 与解析
- [`dsh-agent-loop`](../../core/agent-loop/README.zh.md) —— 请求恢复扩展点

-----

<a id="model-experience"></a>
## 模型体验

### GH 有界重试执行器

#### 模型看到什么

没有新内容：重试在等待后重发同一组装请求。失败尝试的部分输出结算为持久 `assistant/attempt` 记录，绝不提交为 assistant 消息，因此模型历史始终是一条完整请求链。

#### Token 影响

每个报告用量的物理尝试由 token 计量分别记账；无用量信息的失败尝试保持未知而非零。重试只在 provider 最终应答时增加请求成本。

#### KV Cache 影响

重试重发完全相同的请求字节，前缀缓存资格不变；本包不创建或失效任何 provider 缓存条目。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 执行器只重试模型请求；副作用发生后失败的工具往返不会被重放（该边界属于会话连续性工作）。
- 重试预算与等待是 provider 策略字段，尚无用户可见设置；在模型设置页呈现是后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 —— 点击展开</summary>

上游 `dsh-llm-retry` 执行器仍被 GH 闭包门禁禁止；本包是 E02.5 要求的 GH 自有替代，不得长出账号、路由或遥测业务。

</details>
