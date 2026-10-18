# GH 计划审阅

[English](gh-plan-review.md) | 中文

GH 计划审阅是计划模式审阅边界周围的持久台账，由 [gh-plan-review](../../packages/glm/plan-review) 拥有（`ctx.ghPlanReview`，`GhPlanReviewService`）。上游[计划模式](plan.zh.md)保留模式开关、模型侧 `exit_plan_mode` 工具与审阅问题；本插件是它旁边的纯观察者——不改写任何工具结果、不发起提问、不改变任何模型可见行为。它新增的是记录：每个真正到达用户的计划获得一个带编号的 revision，批准时确定性写入计划文件，每个结局都有与 revision 绑定的事件。[包 README](../../packages/glm/plan-review/README.zh.md) 拥有组合状态与限制。

来源：[`packages/glm/plan-review/src/index.ts`](../../packages/glm/plan-review/src/index.ts)

## 记录状态与恢复

三个 log-only、非表面的[会话事件](session.zh.md)：`gh-plan/submitted`（`{ revision, planPath, planSha256 }`）、`gh-plan/approved`（`{ revision, planPath, planSha256, fileWritten }`）、`gh-plan/rejected`（`{ revision, outcome, feedback }`，`outcome` 为 `keep-planning`/`dismissed`/`failed` 之一）。`ghPlanReview` 投影把它们折叠为 `{ nextRevision, approvedRevision, writtenSha256, planPath }`；恢复与 fork 通过折叠日志重建台账，wire 视图向客户端暴露 `{ revision, approvedRevision, planPath }`。折叠的批准守卫即 X05 迟到结果规则：早于已记录批准的 revision、或指向没有任何提交引入过的 revision 的批准，一律折叠为无操作——重放的迟到批准（重连重投、fork 继承）永远无法降级台账。完整事件声明见[持久化日志事件目录](../persistence-catalog.zh.md)与[变更记录](../persistence-changes/2026-10-19-gh-plan-review.zh.md)。

## 观察接缝

服务观察两个瀑布并在两者中都保持委托。`user-questions/request` 通过 intent（`kind: 'plan-review'`，携带退出调用的 `callId`）识别计划审阅问题，标记该调用已到达用户，并捕获结构化答案——批准选项或拒绝，连同自由文本反馈——或 `ASK_CANCELLED` 驳回。`tools/post-execute` 随后在已结算的 `exit_plan_mode` 结果上运行：问题从未到达用户的调用（计划模式未开、计划格式错误、无应答者通道）不留任何事件；到达用户的计划被分配会话的下一个单调 revision 并按结局记录——批准从结果读取 `{ approved: true }`，继续规划与驳回跟随捕获的答案，其余诚实记录为 `failed`。

## 计划文件契约

批准时把批准文本原样写入 `<会话 header cwd>/.glm/plans/plan-<净化会话 id>.md` —— 创建父目录、临时文件加重命名、逐字节保留模型提交内容。仅当文件不存在或仍保持本会话上次写入的内容（`writtenSha256`）时才写入；任何其他内容都是用户或外部编辑，原样保留并以 `fileWritten: false` 记录分歧。写入失败绝不阻塞批准本身。无工作区 cwd 的会话以空路径记录 revision，不写任何文件。

## 配置

```ts type-equiv
/** Plugin config: where plan files live inside the session's workspace cwd. */
interface GhPlanReviewConfig {
  /**
   * Workspace-relative directory for plan files, joined onto the session's
   * header cwd. Must be a plain relative path: no absolute form, no `..`
   * segments, no platform separators.
   */
  readonly plansDir: string
}
```

默认为 `.glm/plans`；非法值在插件加载时失败，而不是等到第一次写入。

## 服务

`ctx.ghPlanReview` 向 UI 与连续性消费者暴露折叠台账（`describe`）与确定性路径解析（`planPathOf`）；签名见生成的[服务目录](#ctxghplanreview--ghplanreviewservice)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxghplanreview--ghplanreviewservice"></a>

### `ctx.ghPlanReview` — `GhPlanReviewService`

`ctx.ghPlanReview`: the plan-review ledger. Observes the plan-review question and the exit tool's settled result, assigns one revision per presented plan, appends the `gh-plan/*` events, and maintains the plan file under the session's workspace cwd.

```ts cordis-catalog
/**
 * Read the folded ledger for one agent's session.
 *
 * @param agent - the agent whose plan history is read.
 * @returns the newest revision, the newest approval, and the plan file path.
 */
describe(agent: Agent): GhPlanReviewView

/**
 * Resolve the deterministic plan file path for a session's workspace.
 *
 * @param session - the session whose header cwd anchors the path.
 * @returns `<cwd>/<plansDir>/plan-<sanitized id>.md`, or null without a cwd.
 */
planPathOf(session: Session): string | null
```

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/glm/plan-review/src/index.ts`](../../packages/glm/plan-review/src/index.ts)
<!-- END GENERATED cordis-surface -->
