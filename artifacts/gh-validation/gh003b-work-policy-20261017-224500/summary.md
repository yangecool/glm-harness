# GH-003-B（切片一）：GLM 工作策略、有界重试与截断工具批次边界

日期：2026-10-17。运行仓库 `runtime`，分支 `main`，基于 `1db9ff054f` + 工作区未提交的 RV01–08 审查修复（保留未动）。无 Key：全部验证使用内置合成回环 GLM 端点（D01 未解除，真实端点联调保持未完成）。

## 交付

| 单元 | 内容 |
| --- | --- |
| `@glm-harness/gh-persona` | `glm:identity`（"AI coding agent powered by GLM Harness"）+ `glm:work-policy`（目标推进/先定位再修改/自验证/工具纪律/不承诺未授予能力）两个静态段；`ctx.effect` 注册，卸载无残留 |
| `@glm-harness/gh-model-retry` | GH 自写有界重试执行器（E02.5）：挂 `agent/request-error`，执行 provider 策略；`llm/retry`/`llm/retry-started` 持久事件 + `llmRetry` 投影（重启恢复预算、step/start 重置）；等待可取消、卸载排水；拒绝 `always` 模式与超过 `maxDelayMs` 的 Retry-After |
| `gh-model-glm` | `retryPolicy` 配置（volatile，`RetryPolicySchema`）；GLM 默认 normal/3 次重试，覆盖 RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE/STREAM_CLOSED；新增 `TRUNCATED_TOOL_CALLS` 终态码：输出上限截断的工具批次整体不执行 |
| 组合 | gh-base 增加 model-retry、gh-persona 行；`gh-init-profiles` 在 profile 产品层（用户层，仍可编辑）写入 `includeHarnessIdentity: false` + 表面 persona 行 + 固定 `toolOrder`（含平台 shell 选择）；web 系 profile 禁用 `harness-dev-context`（消除模型可见的 "DeepSeek Harness" 残留） |

关键组合发现：dsh-web-app 与 dsh-headless 都会重写 `system-prompt` 行（整配置替换、last-write-wins），因此 bundle 层的 identity/toolOrder 必然被覆盖——产品层（profile 自己的 `cordis.patch.yml`）才是正确 owner，且保留用户可编辑性。

## 验证（证据在本目录）

| 验证 | 结果 |
| --- | --- |
| 单元/组合测试 | 17 文件 313 测试通过（含真实 AgentLoop 驱动的重试组合 8 项）；收尾子集 271 通过 |
| 聚合类型 | host/client tsc -b 均 0 错误 |
| 构建 | 9/9 门禁、328 client 制品 |
| 闭包 | `@glm-harness` 闭包与组合 profile 无禁入上游业务包 |
| lint / constraints / 持久化 | oxlint 0 错误；constraints 通过；65 roots/15 记录一致 |
| 文档 | pairing 1018 对一致；doc-sync 42 过/1 失败（repository references 的 11 处历史 pin，日记已记录的既有项，未触碰） |
| 产品 smoke | tool-round（推理续传、工具轮）；rate-limit-retry（429 一次后有界重试恢复，exit 0）；rate-limit-exhaust（1+3 次尝试后显式失败，exit 1） |
| 组合 dump | gh-web 别名 `--dump-config`：产品层生效（identity 关、toolOrder 固定）、harness-dev-context 禁用、新行在位 |

## 未运行 / 边界

- 真实 GLM（D01 凭据缺失）：一切模型行为结论来自脚本化回环端点，不冒充真实联调。
- Electron 原生运行、内存重测、远端制品（后续卡）。
- 已初始化的旧 GH home 不会自动获得新产品层（`gh-init-profiles` 只在 pristine 模板时写入）；日记已记录升级口径。
- 过程事故（已恢复）：一次 `git checkout` 短暂复活了 RV07 已移除的 `dsh-llm-retry` 依赖，闭包门禁拦截后移除；与会话内记录的 RV07 依赖清单逐项比对，无其他回归。
