# GH-004 桌面最小完整工作流 — 验证记录

运行：2026-10-17，gh004-20261017-200400。载体：gh-web（gh-base + dsh-web-app），GLM 路由指向本机有状态 chat-completions mock（`/tmp/gh004-mock-glm.mjs`，key 为合成值 test-key-gh004）。全部操作经由真实浏览器（Playwright + 本机 Chrome 通道）驱动，非静态截图。

## 主工作流（验收原文：打开测试仓库→输入→工具修改→验证→审阅）

一次连续会话完成：Add workspace 浏览对话框打开 `~/gh004-e2e-repo` → 在该工作区新建会话 → 模型选择器分组 GLM 下选 GLM-4.6 → 输入「请在仓库里 WRITEFILE 创建笔记文件。」→ mock 首轮回 `write` 工具调用（分片 JSON）→ 工具在工作区内执行（workspace-write 下工作区内写自动允许，无审批弹窗）→ mock 次轮收 tool result 回结束文案 → 会话标题由 aux 调用生成「GH004 桌面工作流」。磁盘逐字校验 `notes/gh004.txt`。逐相位截图 `e2e-shots/01..07`，wire 证据 `mock-wire.log`，会话日志含完整事件链（turn/start → tool/call → tool/result → workspace/changes → turn/end）。

## 锁定本地数据（E01.2 首批）

`chmod 000` sessions+storages 后：webserver 仍启动、失败在启动诊断中显式列出；工作台静态壳、导航、空态 hero、Plugins 诊断页（含 failed 条目）可用；发送路径显式失败（~38.6s 浮出——见发现）；锁定目录权限不变、无恢复性副产物（credentials 域未锁定，正常初始化自身的 `.credentials.yaml`，属不同数据域）。同期独立入口：另一 home 的 gh-headless 完整跑通 GLM 轮（exit 0）。

## 草稿与停止

未发送草稿在「切换会话再切回」与「整页重载」后逐字还原（上游 per-session localStorage 机制在 GH 组合下原样工作）。停止：慢流（400ms/片段）进行中点击 Stop generating，传输层在首个片段内中断（mock 侧 `slow-aborted at 0`），UI 该轮呈现中断态、无助手输出。

## MEM01/02（web 载体口径）

| 指标 | server 树 (gh-web node) | Chromium 页树 | 合计 | 预算 | 判定 |
| --- | --- | --- | --- | --- | --- |
| MEM01 空闲 5 分钟 | 167.5 MiB (median, 末 60s, 59 样本) | 409.7 MiB | ≈577 MiB | ≤450 MiB | **未达标** |
| MEM02 千会话索引 | 155.0 MiB | 406.8 MiB | ≈562 MiB | ≤600 MiB | 达标（web 载体） |

要点：GH 服务树本身（167.5/155.0 MiB）远低于预算；MEM01 超额 128 MiB 全部来自浏览器载体进程组。MEM02 的 1,000 会话（635,126 事件、压缩 296.8 MiB）在正文未打开时不抬升服务树常驻（155.0 < 167.5 MiB），且列表操作期间服务树进程数恒为 1——零 Agent 激活。ZCode 相对值（-35%）因 D02（需 Node≥24）保持 not-run。预算的正式判定载体是 Electron 桌面树，本机无显示环境且应用未打包，Electron 载体测量 deferred——不以 web 载体数字宣称达标或失败终局。

## 保留名 desktop 组合（薄原生 seam）

`scripts/gh-init-profiles.ts` 新增保留名 `desktop` profile：gh-base + dsh-web-app + 新 bundle `@glm-harness/gh-desktop`（行覆盖层，把以保留名为启用条件的上游遥测/分析两行无条件 disabled——GH 不继承上游生产埋点）。Electron main 零改动：上游壳只读取 `$DSH_HOME/profiles/desktop` 并 spawn desktop-host；CLI 按上游设计拒绝终端启动保留名 profile，组合验证以别名副本 dump（`desktop-profile-dump.yml`），overlay 行按 last-write-wins 落位于末层。闭包门禁覆盖该 profile（`gh-closure.log`）。

## 发现（移交后续票）

1. **changed-files 卡片渲染间歇**：数据链（workspace/changes 事件 + /api/changes.summary 响应）稳定可查；卡片在部分运行渲染、部分运行 60s 不出现（同构建同流程）。归上游 ui-deliverables 客户端触发面时序，登记到 GH-008（任务审查）。
2. **锁定态错误浮出慢**（~38.6s）：工作区添加失败经由 RPC 重试后才可见。即时性属连接/重试策略，登记到 GH-006/007。
3. **MEM01 web 载体合计超预算**：归因浏览器载体树；待 Electron 载体测量后再判预算（GH-009/E01.4 内存门禁）。
4. **品牌仍是上游壳**（DSH Local Build / Preview 文案）：gh-brand 层计划内独立任务。

## 复现锚点

- mock：`node /tmp/gh004-mock-glm.mjs 18631 <wire-log>`（工具轮/慢流/标题分类；本卡期间三次修正：补 `data: [DONE]` 终止帧、marker 优先于 tool-result、工具轮仅首触发）
- 实例：`DSH_HOME=<home> GLM_BASE_URL=http://127.0.0.1:18631/v1 GLM_API_KEY=test-key-gh004 node apps/cli/lib/bin.js gh-web --port <p> --no-open`（cwd=测试仓库）
- 驱动：`/tmp/gh004-e2e-drive.mjs`、`/tmp/gh004-locked-drive.mjs`、`/tmp/gh004-mem.mts`（采样器与语料来自 `benchmarks/glm`、`benchmarks/session-corpus`）
