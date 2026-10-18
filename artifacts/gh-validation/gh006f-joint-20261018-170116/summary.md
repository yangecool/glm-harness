# GH-006-F 联验与资源——断线/崩溃/重启矩阵 + 真常驻内存采样证据

范围：`@glm-harness/gh-remote-supervisor` 两处产品修复（死监护的孤儿保护 + 孤儿根的 stop 清理），新增联验驱动 scripts/gh-remote-joint-verify.ts。矩阵腿全部跑真实 supervisor CLI + 真实 `gh-remote` profile；OpenSSH 腿用重建的运行时制品（27,776 文件，含 C/D/E 语义）经 fixture sshd 真实部署，客户端仅经 `ssh -L` 隧道访问；systemd 腿是真实 `systemctl --user` 瞬态单元。内存口径为 /proc smaps_rollup 整树求和（supervisor+service）。

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| desktop-client-process-exit | PASS | 独立客户端进程（与桌面同 HTTP/WS 传输）回合中 SIGKILL；回合完成、文件写入、模型 fixture 无中止 |
| supervisor-crash-orphan-finishes-and-takeover-refused | PASS | 监护 SIGKILL 后孤儿跑完回合；第二个 run 退出 69（新拒绝语义）；stop 排空孤儿并清根 |
| runtime-crash-restarts-preserves-session | PASS | 服务 SIGKILL 后监护重启（restarts=1，新 pid/端口）；admission 查询应答（found=false 为设计内：崩溃落在执行中，接纳已退役入持久会话日志）；turn/start 保留；新回合完成 |
| user-service-restart-preserves-state | PASS | `systemctl --user restart`：pid 更换、会话事件全量保留、重启后新回合完成 |
| mem03-idle-service-tree | PASS | 空闲整树 PSS 中位 **111 MiB**（12 样本/60s 空闲；预算 256；supervisor 8 MiB + service 103 MiB） |
| mem04-task-peak-and-recovery | PASS | 2401 次模型调用的工具循环，**11,122 行持久 journal**（≥10,000 口径）；峰值整树 PSS **435 MiB**（预算 512）；任务后 120s 空闲中位 139 MiB，较任务前 +27 MiB |
| openssh-disconnect-matrix | PASS | 真实 OpenSSH 部署 + detached 常驻 + 隧道中 SIGKILL；服务 pid 不变，新隧道观察到回合完成且文件写入 |
| openssh-stop-cleans-remote-root | PASS | 远端 stop 清除 identity |

边界（如实记录）：机器重启未模拟（需物理主机或容器权限，docker socket 拒绝）；用户服务重启为真实 systemd。桌面退出以整客户端进程 SIGKILL 等价覆盖，真实 Electron 对常驻服务的退出随桌面远端连接 UI（GH-012）。MEM03/04 无同载体 ZCode Server 基线，按绝对值对照计划预算；长期回收为 120s 空闲观测，会话空闲处置与缓存预算属 GH-009。

单元与门禁：remote-supervisor 27（新增孤儿保护用例）；account 10 + model-glm 46（GH-007 并行树）；host 聚合 typecheck 通过；oxlint 0；gh-closure 通过；doc-sync 仅余既有 GH-018 repository references（38 处历史 pin，不在本片新增文件中）。
