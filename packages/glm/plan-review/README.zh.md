---
description: "GH 的计划审阅台账：会话日志下的带 revision 计划提交、批准时确定性写入工作区计划文件且绝不覆盖用户编辑、与 revision 绑定的批准/拒绝记录。"
kind: "package-reference"
---

# @glm-harness/gh-plan-review

[English](README.md) | 中文

## 概述

挂载本插件，在上游计划模式旁为计划审阅留下持久记录：每个到达用户的计划成为会话日志中带编号的 `gh-plan/*` revision；批准时把批准文本逐字写入 `<workspace>/.glm/plans/plan-<id>.md` —— 原子写、绝不覆盖用户编辑；每个结局（批准、继续规划反馈、驳回、失败）都与 revision 绑定记录。重放的迟到批准不改变任何状态：折叠只接受不早于已记录批准的 revision。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## 使用本包

<a id="use-this-package"></a>

`@glm-harness/gh-base` 为所有发行 profile 组合本插件，紧邻计划门（`@glm-harness/gh-permissions` 组合执行门；`dsh-plan-mode` 拥有模式）。

### 何时选择它

当组合希望计划审阅留下持久轨迹——带 revision 的历史、工作区中的计划文件、反馈批注——时选择它。没有它，计划审阅保持上游原样：计划文本只存在于工具调用内，不写盘。

### 最小配置

```yaml
- id: gh-plan-review
  name: '@glm-harness/gh-plan-review'
```

`plansDir` 默认 `.glm/plans`；任何不含 `..` 段的工作区相对目录均可。

## 理解实现

<a id="understand-the-implementation"></a>

服务（`ctx.ghPlanReview`）注册 `ghPlanReview` 投影和两个观察者：

- `user-questions/request` —— 通过 intent 识别计划审阅问题，把该次退出调用标记为"已到达用户"，并捕获结构化答案（批准标签或拒绝、自由文本反馈）或驳回（`ASK_CANCELLED`）。它始终委托，从不代答。
- `tools/post-execute` —— 对问题确实到达用户且已结算的 `exit_plan_mode`，分配下一个 revision（每会话单调，从持久折叠播种），追加 `gh-plan/submitted`，再追加结局事件。批准先写计划文件（临时文件 + 重命名；文件内容无法识别时跳过），再追加携带真实 `fileWritten` 的 `gh-plan/approved`。在到达审阅前就验证失败的调用（计划模式未开、计划格式错误）不留任何事件。

计划文件路径为 `<会话 header cwd>/<plansDir>/plan-<净化 id>.md`；无工作区 cwd 的会话以空路径记录 revision，不写盘。会话 id 在文件名中只保留 `A-Za-z0-9._-`。

## 延伸阅读

<a id="further-exploration"></a>

- `packages/glm/plan-review/tests/plan-review.spec.ts` —— 对真实 agent loop、真实 user-questions 服务与脚本化审阅者的完整回环组合：批准/文件/精确文本、继续规划反馈、驳回、不覆盖序列、单调 revision、未审阅无事件、无 cwd 用例；以及 X05 重放防护的纯折叠测试。
- `docs/subsystems/gh-plan-review.md` —— 台账的产品契约与边界。
- `docs/persistence-changes/2026-10-19-gh-plan-review.md` —— 三个 log-only 事件的兼容性记录。

## 模型体验

<a id="model-experience"></a>

### 计划审阅台账上下文

#### 模型看到什么

没有新增内容。本插件不注册提示词段、工具或 schema，不改写任何工具结果，也不发起提问。`exit_plan_mode` 的模型侧行为（审阅问题、批准退出、继续规划错误带反馈、驳回结束回合）完全属于上游。`gh-plan/*` 事件是 log-only，绝不进入模型请求；计划文件服务的是用户与后续连续性表面，不是请求路径。

#### Token 影响

零：无提示词字节、无消息插入、无请求形状变化。

#### KV Cache 影响

无：本插件不贡献任何前缀或历史内容，缓存请求前缀在每次计划审阅前后保持有效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 尚无压缩后 reminder 引用计划文件（上游 compaction 没有注入接缝；连同计划文件连续性设计记为 GH-008 后续）。
- 继续规划的反馈当前按上游行为在同回合以工具错误回到模型；ZCode 式改进（反馈成为真实的下一条用户消息、无反馈拒绝结束回合）延后到工作台切片。
- 上游子代理会话没有存活的人类应答者，无法到达审阅；台账在那里不记录任何内容。
- 尚无 UI 表面：计划文件路径与 revision 历史经投影（`ghPlanReview`）与 `ctx.ghPlanReview.describe(agent)` 暴露，待客户端切片渲染。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

折叠中的批准守卫是 X05（迟到结果）规则的缩影：`revision < approvedRevision` 或 `revision >= nextRevision` 一律折叠为无操作，因此晚于新批准重放的旧批准——或指向未知未来 revision 的批准——都无法降级台账。同样的保守性驱动文件写入：本会话上次写入内容的摘要，是批准唯一可以替换的内容。

</details>
