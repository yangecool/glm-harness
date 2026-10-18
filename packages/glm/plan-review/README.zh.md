---
description: "按 revision 绑定的计划审阅、持久审批台账与检测外部编辑的工作区计划文件。"
kind: "package-reference"
---

# @glm-harness/gh-plan-review

[English](README.md) | 中文

## 概述

在上游计划模式旁挂载本插件，每个呈现的计划成为带编号的 `gh-plan/*` revision。分配发生在等待答案之前；已被新版本取代的批准会在退出工具继续前中止。有效批准在检查外部编辑后，把文本逐字写入 `<workspace>/.glm/plans/plan-<id>.md`。折叠只接受最新已提交 revision 的首次批准。

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

服务（`ctx.ghPlanReview`）注册 `ghPlanReview` 投影和两个瀑布监听器：

- `user-questions/request` —— 委托前分配 revision 并记录提交，随后捕获批准、反馈或驳回。在途记录按 Session 和 call id 隔离。已被新版本取代的批准会在上游退出工具继续前抛出 `ASK_ABORTED`。
- `tools/post-execute` —— 结局绑定呈现时分配的 revision。只有最新 revision 的成功且被接受的结果可以写计划文件并记录批准；拒绝或失败结果记录拒绝。未进入该监听器审阅流程的调用不留事件。

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

本插件不新增提示词段、工具、schema 或第二次提问。正常审阅响应仍由上游拥有。对旧 revision 的迟到批准经上游工具路径返回审阅中止错误，不能批准新计划。`gh-plan/*` 事件仍为 log-only；计划正文可从已记录的工具调用重建。

#### Token 影响

正常审阅不新增提示词字节或消息。旧审阅中止会产生上游工具错误，该失败路径不承诺固定零 token。

#### KV Cache 影响

不改变静态前缀。旧审阅错误属于普通工具历史，从该位置影响后缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 计划文件目前使用本地 Node 文件系统，不使用执行 provider 的文件系统；远端容器/provider 路径尚未验收。新文件以排他发布创建；已有文件在原子替换前检查内容，检查时发现的外部编辑会保留，检查之后的并发外部写入没有共享锁保护。
- 尚无压缩后 reminder 引用计划文件（上游 compaction 没有注入接缝；连同计划文件连续性设计记为 GH-008 后续）。
- 继续规划的反馈当前按上游行为在同回合以工具错误回到模型；ZCode 式改进（反馈成为真实的下一条用户消息、无反馈拒绝结束回合）延后到工作台切片。
- 上游子代理会话没有存活的人类应答者，无法到达审阅；台账在那里不记录任何内容。
- 尚无 UI 表面：计划文件路径与 revision 历史经投影（`ghPlanReview`）与 `ctx.ghPlanReview.describe(agent)` 暴露，待客户端切片渲染。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

投影状态版本 2 按连续提交和只接受最新批准的规则重建台账。写文件失败会记录 `fileWritten: false`，不撤销其他条件有效的批准。

</details>
