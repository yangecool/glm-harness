# GH-006-C 验收摘要：持久命令接纳与查询

在既有 seam 上扩展（不另造业务队列）：`dsh-api-session-controller` 的 prompt 准入现在按 Agent 串行、按 `requestId` 对账，并可选等待 Session flush 后才回执。

## 能力面

- 串行接纳：`serializeAdmission`（原 `serializeImageAdmission` 推广）为每个 Agent 提供唯一 check-then-place 链，并发同 requestId 重提交原子对账，不再越过检查竞态。
- 冲突检测：服务内 journal（原始负载 sha256 指纹：mode+文本+图片/文件身份，每会话上限 4096 条、越界淘汰回日志扫描）捕获同服务不同负载 → `session/request-conflict`；跨重启以持久日志中 user 消息文本通道对比（附件负载不可比 → 幂等接受，不误判）。
- flush 前回执：`durableAdmission` 配置（默认 false 保持上游语义）开启后，回执等待 `ctx.sessions.flush`——无持久化写入者 → `session/no-durable-writer`；flush 抛错 → `session/flush-failed`。接纳已发生（消息已入 inbox），丢失回执由对账恢复，绝不重复执行。
- 查询动词：`session/admission`（新 Remote 方法）返回 `{found, fingerprint?, admittedAt?}`——先查 journal（原始指纹+时间），再查持久日志（文本指纹）；未知结果先查 receipt，不盲重发。
- profile 接线：gh-remote-app 补丁行按 id 重指 `session-controller` 行并置 `durableAdmission: true`。

## 验证

- 单元 9/9（admission.host.spec.ts）：并发同请求只执行一次、ACK 丢失后重试幂等、同服务不同负载冲突、日志去重/冲突、查询三态（journal/日志/不存在）、默认语义不变、无写入者拒绝但接纳可对账、flush 失败映射、有写入者回执。
- 全量回归 998/998（session-controller 44 文件）；既有 fixture“同 rpcId 不同文本仍接受”按新契约改为一致文本（冲突语义本身有专项用例）。
- 真服务联验 8/8：真实 gh-remote profile + GH-006-B 监护——prompt 回执（flush 策略下）、独立连接重试幂等、查询 found+指纹、不同负载 `session/request-conflict`、kill -9 后新 pid 恢复且查询 found、重启后重发幂等、重启后不同负载仍冲突（持久文本对比）、不存在查询 found=false。
- 闸门：build 9/9、oxlint 0、gh-closure/约束清、doc-sync 除既有 GH-018 repository-references 外全过（含 cordis catalog/persistence catalog/doc graphs/config catalog/pairing 再生成）。

## 边界（如实记录）

- 跨重启冲突检测仅覆盖文本通道：日志中接纳的是附件引用而非上传凭证，附件负载重启后不可比 → 幂等接受（宁可不误判，不放过可控冲突）。
- journal 不跨服务重启（持久事实在 Session 日志）；每会话 4096 条上限后回日志扫描。
- queue edit 路径（updateQueue）不带 requestId，不在对账面内（与上游一致）。
- 真服务上未构造“无持久化写入者”场景（gh-base 恒挂 jsonl）；该路径由单元覆盖。
- 桌面/web 客户端尚未接入 `session/admission` 调用面（GH-006-D 重附着接线）。
