# GH 计划审阅

[English](gh-plan-review.md) | 中文

GH 计划审阅是计划模式审阅边界周围的持久台账，由 [gh-plan-review](../../packages/glm/plan-review) 拥有（`ctx.ghPlanReview`，`GhPlanReviewService`）。上游[计划模式](plan.zh.md)保留模式开关、模型侧 `exit_plan_mode` 工具与审阅问题；本插件记录 revision，并在退出工具继续前拒绝已被新版本取代的审阅批准；不新增第二次提问或替换工具结果。它新增的是记录：每个真正到达用户的计划获得一个带编号的 revision，批准时确定性写入计划文件，每个结局都有与 revision 绑定的事件。[包 README](../../packages/glm/plan-review/README.zh.md) 拥有组合状态与限制。

来源：[`packages/glm/plan-review/src/index.ts`](../../packages/glm/plan-review/src/index.ts)

## 记录状态与恢复

三个 log-only、非表面的[会话事件](session.zh.md)：`gh-plan/submitted`（`{ revision, planPath, planSha256 }`）、`gh-plan/approved`（`{ revision, planPath, planSha256, fileWritten }`）、`gh-plan/rejected`（`{ revision, outcome, feedback }`，`outcome` 为 `keep-planning`/`dismissed`/`failed` 之一）。`ghPlanReview` 投影把它们折叠为 `{ nextRevision, approvedRevision, writtenSha256, planPath }`；恢复与 fork 通过折叠日志重建台账，wire 视图向客户端暴露 `{ revision, approvedRevision, planPath }`。折叠的批准守卫即 X05 迟到结果规则：只接受最新已提交 revision 的首次批准；旧、重复、零值或未知 revision 的批准一律折叠为无操作——重放的迟到批准（重连重投、fork 继承）永远无法降级台账。完整事件声明见[持久化日志事件目录](../persistence-catalog.zh.md)与[变更记录](../persistence-changes/2026-10-19-gh-plan-review.zh.md)。

## 审阅顺序

`user-questions/request` 在等待答案前分配 revision 并追加提交。记录按 Session 和 call id 隔离；批准已被新版本取代的审阅会抛出 `ASK_ABORTED`。`tools/post-execute` 将结局绑定原 revision。只有最新且成功被接受的批准可以写计划文件。投影按状态版本 2 重建，事件载荷不变。

## 计划文件契约

批准时把文本原样写入 `<会话 header cwd>/.glm/plans/plan-<净化会话 id>.md`，创建父目录，新文件排他发布，已有文件原子替换。仅在文件不存在或检查时仍为本会话上次写入内容（`writtenSha256`）时写入；发现外部编辑则保留，并记录 `fileWritten: false`。检查后的外部并发写入没有共享锁保护。当前使用本地 Node 文件系统，执行 provider 文件系统尚未验收。写入失败不阻止批准本身；无工作区 cwd 的会话记录空路径，不写文件。

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
