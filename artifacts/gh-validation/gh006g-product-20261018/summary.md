# GH-006-G 产品入口与生命周期事务 — 验收证据

日期：2026-10-18。范围：插件化 Supervisor（`gh-supervisor` 最小 profile）、归档自举到常驻服务、统一身份与生命周期事务、接纳关闭排水。对照计划 11.8 G；RV25 的发行入口缺口。

## 制品与驱动

- 归档 A：`dist-exe/gh-remote-g/gh-remote-0.2.1-rc.1-linux-x64.tar.gz`（27914 文件，携带 `bin/node`、supervisor CLI、`gh-supervisor` profile、home 模板）
- 归档 B：同树 `--variant b` 重建（升级目标；同一 commit 的变体标记）
- 产品驱动：`node --import tsx/esm scripts/gh-remote-product-verify.ts --report …/product-verify.json`（真实 fixture OpenSSH + 无 Node PATH 监牢 + 回环 GLM fixture）
- 生命周期回归：`scripts/gh-remote-lifecycle-verify.ts`（GH-006-E 驱动，对齐新 CLI 语义）
- 引导矩阵：`scripts/gh-remote-verify.ts`；联合验证：`scripts/gh-remote-joint-verify.ts`

## 产品驱动 10/10（product-verify.json，run6 全绿）

| 用例 | 证据要点 |
|---|---|
| from-zero-install-layout | 真实归档从零安装：current.json 指针、单 release、runtimeId、profiles（desktop/gh-headless/gh-remote/gh-supervisor/gh-web）、自带 node |
| resident-supervisor-profile-and-handshake | `bootstrap start` 拉起 gh-supervisor profile；`ghRemote/describe` 应答 runtimeId/releaseId/admission/capabilities（activity-drain+durable-admission+admission-close+runtime-id） |
| tunnel-disconnect-survival | turn 中 SIGKILL 隧道：服务 pid 稳定、新隧道观察到回合干净收尾、fixture 文件写出 |
| runtime-id-survives-crash-restart | SIGKILL 服务：supervisor 重启（restarts=1），握手 runtime id 不变 |
| upgrade-drain-switch-and-data | `bootstrap update`：staging→安装→排水（supervisor 报告 `new admissions closed; activity idle before switch`）→切换；home 标记存活；新服务重新开放接纳、runtime id 不变 |
| rollback-to-previous-release | `bootstrap rollback` 排水后切回 release A，home 数据完整 |
| gc-pins-and-drops | gc 删除 r-junk，保留 current/回滚目标/存活钉住 |
| concurrent-verbs-serialized | 并发 `use`：有效者胜（use-ok=0 use-bad=64），指针不落空 |
| interrupted-transaction-diagnosis | 死持有者锁：status 点名 verb=update interrupted=true；下一动词回收声明并执行 |
| uninstall-preserves-data | 卸载移除运行时与监护状态，数据根其余字节全部存活 |

升级用例的接纳关闭证据：监控客户端的实时轮询在空闲服务上会错过窗口（关闭→确认空闲→停止在同一拍），因此以 supervisor 事务报告（`update.log` 中的 drain 详情行）为准，实时观察作为加分项。驱动对两者都采样。

## 本轮修复的真实缺陷

1. **驱动脚本装配缺陷（非产品缺陷）**：nohup 升级命令被 `\n` join 拆成三行 — 第一行 `env` 无命令打印环境退出；第二行未监牢化的更新在前台跑；第三行空命令重定向创建了 0 字节日志。修正为单行，并补传 B 归档 `.sha256` 边车。
2. **监牢缺 gzip（产品前置缺口）**：GNU tar 的 `-z` 经 PATH 调 `gzip`；无 Node 监牢未含 gzip，导致 stage_archive 在监牢化更新中失败。已加入 `JAIL_TOOLS` 与 `BOOTSTRAP_REQUIRED_TOOLS`（探测同样把关）。
3. **升级等待与接纳观察窗口**：staging+校验+安装 28k 文件需数分钟，原 150s 等待与 20s 接纳轮询均不足；等待放宽并合并轮询，最终以 supervisor 报告为权威证据。

## 回归门禁（本目录 gates.log 汇总）

- 单测：remote-supervisor + remote-app 43/43；bootstrap + session-controller 45 文件 1023/1023；lifecycle.spec 7/7
- lifecycle-verify 10/10（本目录 lifecycle-verify.log / lifecycle-verify.json）
- bootstrap 矩阵与 joint-verify：见 bootstrap-matrix.json 与 gates.log
- typecheck（host/client 双聚合）、oxlint、runtime-closure、doc-sync 43/43

## 边界

- 第二个 release 是同树变体标记重建，不是不同产品版本；release 身份以安装 release id 为准。
- 机器重启未模拟（无容器特权）；服务崩溃重启与 supervisor 管理的切换是真实的。
- 常驻组合不拥有 PTY/全局 lease；其排水覆盖自有活动集（运行 agent + pending inbox）。更广资源 lease 属 GH-009。
