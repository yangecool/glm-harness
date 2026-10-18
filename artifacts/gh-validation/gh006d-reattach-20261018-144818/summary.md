# GH-006-D 持续执行与重附着——真服务联验证据

范围：真实常驻 gh-remote profile + GH-006-B supervisor；流式 loopback GLM fixture（真实 SSE 分片驱动完整 turn 生命周期）；guarded 权限模式；合成凭据 synthetic-reattach-key。驱动 scripts/gh-remote-reattach-verify.ts，通过裸 HTTP RPC 与最小 /api/remote.mux WebSocket mux 客户端（follow 流与 \ waterfall）操作服务。

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| turn-survives-client-drop | PASS | 提示连接（HTTP+mux follow）全部销毁后，turn 继续写日志至 turn/end（seq 11→15），无客户端也在执行 |
| reconnect-baseline-cursor | PASS | 新连接 follow 快照 cursor=15，随后首条 live 事件 seq=16=baseline+1：无缺口、无重放 |
| dual-connection-single-execution | PASS | 两条独立连接以同一 requestId 提交均 accepted；日志恰好 1 条 user/message、1 个新 turn/start |
| disconnect-never-cancels | PASS | 观察 follow 连接中途销毁，turn 照常完成；fixture 无 abort |
| explicit-cancel-stops | PASS | 全新连接 session/cancel 后 5ms 内 turn/end，reason=aborted-by-user（自然时长 3200ms） |
| approval-waterfall-reattach | PASS | guarded 危险规则命中→approval/request waterfall；应答客户端断开→重连客户端收到同 eventId/agentId 重投递；allowed-once 回执后 bash rm -rf 真实执行（探针目录消失）、turn 完成 |

单元与门禁：session-controller/gateway/ui-conversation 93 文件 1929 用例通过；typecheck 5/5；oxlint 0 error（1 条 import 基线既有 warning）；gh-closure 0。

客户端接线（单元覆盖）：prompt 载波丢失→session/admission-unknown，echo 保持 pending，重连 handleConnected 清扫 session/admission 对账（found→observed 退役、not-found→failed 退役、队列中→观察路径带附件退役）；ui-conversation sendSession 未知结果不还原草稿。
