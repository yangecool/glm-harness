# GH 远端运行时自举

[English](gh-remote-bootstrap.md) | 中文

远端运行时自举是 E04.2 的制品链，把一份完整的 GH 运行时放到没有任何 Node 的 SSH 可达 Linux 主机上：一个可重定位归档（staging 出来的 CLI 闭包、自带的 `bin/node`、初始化好的 profile home 模板、POSIX 安装器、逐文件摘要清单），一条走真实 OpenSSH 的控制器部署管线，以及验收工具。控制器侧位于 [`scripts/gh-remote/`](../../scripts/gh-remote)，构建入口是 [`scripts/build-gh-remote-archive.ts`](../../scripts/build-gh-remote-archive.ts)；它有意复用上游 [SSH subsystem](ssh.zh.md) 的工具模式，但交付的是完整运行时而不是传输 helper。

来源：[`scripts/gh-remote/artifact.ts`](../../scripts/gh-remote/artifact.ts)、[`scripts/gh-remote/bootstrap.ts`](../../scripts/gh-remote/bootstrap.ts)、[`scripts/gh-remote/deploy.ts`](../../scripts/gh-remote/deploy.ts)

## 归档

先 `pnpm run build`，再 `node --import tsx/esm scripts/build-gh-remote-archive.ts`：以 SSH helper 同款的 legacy-deploy 步骤 staging `@deepseek-ai/dsh` CLI 闭包，修复该部署会丢掉的部分（工作区拥有的 peer 与传递依赖物化到不动点；GH 禁用的上游业务包被剪除），用真实 `gh-headless` profile 对回环 GLM fixture 启动 staging 闭包自检，全部通过后才把 `gh-remote/`（bootstrap、`bin/node`、`runtime/`、`home-template/`、`LICENSES/`）连同 `.sha256` 边车打包成 `dist-exe/gh-remote/gh-remote-<version>-<target>.tar.gz`。载荷内的 `manifest.json` 固定格式、版本、commit、目标、node 版本以及每个文件的 SHA-256 与权限；`verifyPayload` 在激活前拒绝缺失、多余、重复、被改动或权限不符的文件。

## Bootstrap

`bootstrap.sh` 由 `scripts/gh-remote/bootstrap.ts` 生成为 POSIX sh，在目标机上无 Node 运行：`install` 探测内核/架构/libc，校验归档摘要与解压后的文件清单（awk 从 manifest 解出 `sha256sum` 核对表逐字节核对），在 `flock` 下 staging，把 release 移入 `releases/<时间戳>-<commit>`，原子翻转 `current` 符号链接，并只在首次播种 `home/`。`run`/`start`/`stop`/`status` 通过自带 node 管理运行器；`rollback` 重新校验后回激活上一个 release。每次失败都报出所属阶段并以该阶段的退出码结束（probe 90 …… usage 98），控制器据此定位错误而不是猜（F24）。目前仅支持 Linux glibc 目标；mac/windows 远端随平台资格（E04.6）接入。

## 控制器管线

`scripts/gh-remote-deploy.ts` 是用户命令：`--save-as/--list/--remove` 管理 SSH 目标记录（只有坐标与密钥路径——绝不存密钥材料）于 `~/.glmh/remote-targets.json`；`--target <名称|user@host:port> --archive <路径>` 首次连接时展示指纹并固定主机密钥（不信任即拒绝、变更即硬失败——R02），探测主机、上传、安装并报告激活的 release。连接细节委托给系统 `ssh`/`scp`（agent、配置别名、`ProxyJump`），非标准端口是一等公民（R01/R03/R04 前段）。验收驱动 `scripts/gh-remote-verify.ts` 在一个非特权 fixture sshd 上、经一个可证明没有 Node 的 PATH 监牢跑完整矩阵：TOFU 拒绝、探测、安装、原子激活、真实 `gh-headless` 回合在目标机写文件、篡改归档拒绝、并发安装串行化、回滚。`scripts/gh-remote-mem.ts` 采集 MEM03/MEM04 样本（来自 `/proc/*/smaps_rollup` 的进程树 Rss/Pss），覆盖就绪保持与长脚本任务。

## 与 SSH helper 的关系

上游 SSH helper 归档只承载传输侧运行时；GH 远端自举组合的是 helper 所连接的产品运行时。两者共享发布纪律——manifest 校验的载荷、阶段化的失败、原子激活——但 GH 归档从 GH profile 闭包构建，带被禁包剪除与 profile home 模板，两个制品独立演进版本。
