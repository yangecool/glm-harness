# GH-008-B 验证摘要：计划审阅台账（plan-review ledger）

日期：2026-10-19。范围：E03.2 切片 —— Plan 草稿 revision、计划文件、审批绑定 revision、拒绝/反馈批注与 X05 迟到结果防护。全部无真实 Key：模型走回环 fixture，凭据为合成值。

## 交付

- **`@glm-harness/gh-plan-review`**（`packages/glm/plan-review`，`ctx.ghPlanReview`）：纯观察者插件。`user-questions/request` 瀑布捕获计划审阅问题与结构化答案（批准标签/拒绝/自由文本反馈/`ASK_CANCELLED` 驳回），`tools/post-execute` 在已结算的 `exit_plan_mode` 上分配单调 revision 并追加 `gh-plan/submitted|approved|rejected`（log-only）；批准时把批准文本逐字原子写入 `<workspace>/.glm/plans/plan-<净化会话id>.md`，仅当文件仍为本会话上次写入内容——用户编辑永不覆盖（`fileWritten:false` 记录分歧）；未到达审阅的调用（模式未开/格式错误/无应答通道）零事件。
- **`ghPlanReview` 投影**：`{nextRevision, approvedRevision, writtenSha256, planPath}`；折叠守卫实现 X05 规则——早于已记录批准或指向未知 revision 的批准事件折叠为无操作（重放/迟到结果不降级台账），wire 视图 `{revision, approvedRevision, planPath}`。
- **组合接线**：gh-base profile 新行（所有 GH profile 继承）；tsconfig.host 引用；known-event-types/persistence-catalog/cordis-catalog/config-catalog/plugin-packages/doc-graphs/capability-seams 再生成；持久化变更记录 `2026-10-19-gh-plan-review`（same-version）。

## 证据

| 项 | 结果 | 出处 |
| --- | --- | --- |
| 单元/组合（真实 AgentLoop+UserQuestionService+plan-mode，mock 模型） | 12/12 | `gates.log` |
| glm 全套 + closure spec | 236/236 | `gates.log` |
| 端到端（真实 gh-remote 常驻服务 + supervisor + 回环 GLM + 真实 user-questions 中继） | 3/3 | `verify.log` / `plan-review-verify.json` |
| 产品 smoke 回归（gh-headless 组合含新插件） | 5/5 | `product-smoke.json` |
| doc-sync / closure / persistence-changes / oxlint / host 聚合 typecheck | 全过 | `gates.log`（doc-sync 43/43 见会话记录） |

端到端三用例：批准写文件逐字节精确+双事件（revision 1, fileWritten true）；拒绝带反馈记录 `keep-planning`+反馈文本且无文件；用户编辑后批准不覆盖（revision 2, fileWritten false，文件保持用户文本）。

## 复现（在 `runtime/`）

```bash
pnpm run build
node node_modules/vitest/vitest.mjs run packages/glm
timeout 240 node --import tsx/esm scripts/gh-plan-review-verify.ts --report /tmp/plan-review.json
node --import tsx/esm scripts/gh-product-smoke.mjs /tmp/smoke.json
```

## 边界（如实）

- 压缩后 plan-file reminder 未做：上游 compaction 无注入接缝（`compaction/summary-error` 之外无 post-compact 事件），随计划文件连续性设计记为 GH-008 后续。
- 拒绝反馈仍按上游行为同回合以工具错误回到模型；ZCode 式"反馈成为真实下一条用户消息、无反馈拒绝结束回合"延后到工作台切片（docs 参考 `ZCode/docs/plan-mode-approval-boundary.md`）。
- 子代理无存活应答者，无法到达审阅，台账不记录（上游限制）。
- UI 表面（计划文件路径/revision 历史渲染）待客户端切片；投影与 `describe()` 已就绪。
- E2E 使用回环 GLM fixture：校验事件、文件与中继行为，不证明真实 GLM 服务（D01 未解除）。
