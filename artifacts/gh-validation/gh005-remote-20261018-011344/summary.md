# GH-005 完整远端制品与 SSH 自举 — 验证摘要

对应 E04.1（前段：目标探测）/ E04.2（制品自举）/ F24（SSH 目标、认证、探测、上传、部署、启动，错误定位到阶段）/ R01–R02、R04、R07、R08（前段）/ MEM03–04。

## 交付

- `scripts/gh-remote/artifact.ts`：远端运行时归档清单（format 1，逐文件 SHA-256 + 权限，必需文件断言）与载荷校验。
- `scripts/gh-remote/bootstrap.ts`：生成的 POSIX 安装器（目标机无需 Node）：install（探测内核/架构/libc → 归档摘要 → 防逃逸解包 → 逐文件清单核对 → flock 串行 → staging→releases 原子激活 → 首次播种 home）、run/start/stop/status、rollback（先重校验再翻转）；所有失败带 stage= 前缀与阶段退出码（probe 90 … usage 98）。
- `scripts/gh-remote/{targets,probe,deploy}.ts` + `scripts/gh-remote-deploy.ts`：目标记录（无密钥材料）、ssh-keyscan TOFU 指纹固定（不信任即拒绝）、远端探测、scp 上传、阶段化安装、运行器生命周期；连接委托系统 ssh/scp（agent/别名/ProxyJump、非标端口）。
- `scripts/gh-remote/sshd-fixture.ts`：非特权 fixture sshd（自备主机密钥/authorized_keys，无 PAM，不碰系统状态）+ 无 Node PATH 监牢。
- `scripts/build-gh-remote-archive.ts`：legacy-deploy staging → 工作区传递/peer 包不动点物化（本次补 25 个）→ 被禁上游业务包剪除（本次 11 个）→ 真实 gh-headless 闭包对回环 fixture 启动自检 → 组装（bin/node、runtime、home-template、LICENSES、bootstrap、manifest）→ tar.gz + sha256 边车。产物 166.7 MiB / 27,761 文件 / node v22.23.2。
- `scripts/gh-remote-verify.ts`：真实 OpenSSH 验收（12/12）。`scripts/gh-remote-mem.ts`：进程树 Rss/Pss 采样。
- 文档：docs/subsystems/gh-remote-bootstrap(.zh).md + 索引与 pairing。

## 验证结论（全部真实执行）

- 单测 20/20（dash 实跑 install/回滚/篡改/并发矩阵）；oxlint 0/0；closure/constraints 通过；doc-sync 42 过/1 失败（仅既有 repository references 11 处历史 pin，GH-018 台账项）。
- 真实 sshd 验收 12/12：TOFU 未确认指纹在 connect 阶段拒绝；探测 linux-x64/glibc 2.39；安装原子激活（release id 带 commit 短哈希）；PATH 监牢内 `command -v node` 为空；**真实 gh-headless 回合在无 Node 目标上完成并在目标机写盘**；篡改归档在 verify-archive 阶段拒绝；并发安装经 flock 串行；三 release 并存，rollback 重校验后回激活。
- MEM：10,263 事件任务峰值 PSS 353.9 MiB（预算 512 ✓）；就绪态（首次模型响应保持中）PSS 中位 102.0 MiB（预算 256 ✓；口径为一次性 gh-headless 运行器，Supervisor 属 GH-006；本机无同载体 ZCode Server 基线，按绝对值对照产品预算）。

## 明确边界（未验收项）

- 目标为本机回环 fixture sshd：真实 OpenSSH 传输/认证/非标端口，但非独立主机与真实网络；独立主机联调待真实远端（docker 无权限，无法起容器目标）。
- 仅上传模式（离线归档）；目标侧 URL 拉取模式未实现（无分发端点）。
- 密码/keyboard-interactive 认证委托 OpenSSH 未实测；agent/跳板机同理（无环境）。
- R06 磁盘满/目标目录只读路径未模拟（需 root 构造 tmpfs/只读挂载）；权限拒绝仅由阶段化设计覆盖。
- 仅 linux-x64（构建规则要求目标与构建主机一致；linux-arm64 需其原生主机）。
- 卸载、更新 GC、崩溃预算、断线不杀（E04.3）随 GH-006 Supervisor。
