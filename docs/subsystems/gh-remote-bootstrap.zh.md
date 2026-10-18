# GH 远端运行时自举

[English](gh-remote-bootstrap.md) | 中文

远端运行时自举是 E04.2 的制品链，把一份完整的 GH 运行时放到没有任何 Node 的 SSH 可达 Linux 主机上：一个可重定位归档（staging 出来的 CLI 闭包、自带的 `bin/node`、初始化好的 profile home 模板、POSIX 安装器、逐文件摘要清单），一条走真实 OpenSSH 的控制器部署管线，以及验收工具。控制器侧位于 [`scripts/gh-remote/`](../../scripts/gh-remote)，构建入口是 [`scripts/build-gh-remote-archive.ts`](../../scripts/build-gh-remote-archive.ts)；它有意复用上游 [SSH subsystem](ssh.zh.md) 的工具模式，但交付的是完整运行时而不是传输 helper。

来源：[`scripts/gh-remote/artifact.ts`](../../scripts/gh-remote/artifact.ts)、[`scripts/gh-remote/bootstrap.ts`](../../scripts/gh-remote/bootstrap.ts)、[`scripts/gh-remote/deploy.ts`](../../scripts/gh-remote/deploy.ts)

## 归档

先 `pnpm run build`，再 `node --import tsx/esm scripts/build-gh-remote-archive.ts`：以 SSH helper 同款的 legacy-deploy 步骤 staging `@deepseek-ai/dsh` CLI 闭包，修复该部署会丢掉的部分（工作区拥有的 peer 与传递依赖物化到不动点；GH 禁用的上游业务包被剪除），用真实 `gh-headless` profile 对回环 GLM fixture 启动 staging 闭包自检，全部通过后才把 `gh-remote/`（bootstrap、`bin/node`、`runtime/`、`home-template/`、`LICENSES/`）连同 `.sha256` 边车打包成 `dist-exe/gh-remote/gh-remote-<version>-<target>.tar.gz`。载荷内的 `manifest.json` 固定格式、版本、commit、目标、node 版本以及每个文件的 SHA-256 与权限；`verifyPayload` 在激活前拒绝缺失、多余、重复、被改动或权限不符的文件。

## Bootstrap

`bootstrap.sh` 由 `scripts/gh-remote/bootstrap.ts` 生成为 POSIX sh，在目标机上无 Node 运行：`install` 探测内核/架构/libc，校验归档摘要与解压后的文件清单（awk 从 manifest 解出 `sha256sum` 核对表逐字节核对），在 `flock` 下 staging，把 release 移入 `releases/<时间戳>-<commit>-<唯一后缀>`，原子翻转 `current` 符号链接，并只在首次播种 `home/`。`run`/`start`/`stop`/`status` 通过自带 node 管理运行器；`rollback` 重新校验后回激活上一个 release。每次失败都报出所属阶段并以该阶段的退出码结束（probe 90 …… usage 98），控制器据此定位错误而不是猜（F24）。目前仅支持 Linux glibc 目标；mac/windows 远端随平台资格（E04.6）接入。

## 控制器管线

`scripts/gh-remote-deploy.ts` 管理目标、首次指纹确认、探测、上传和安装。当前验证路径是直接 host/port/私钥；完整部署在扫描/上传前拒绝 SSH config alias 与 ProxyJump，其指纹发现和上传尚未实现。密码、agent、交互认证、跳板与独立主机保持未验收。`scripts/gh-remote-verify.ts` 使用真实回环 OpenSSH 与无 Node PATH 监牢验证；`scripts/gh-remote-mem.ts` 测的是一次性 headless 就绪和合成长任务，只是阶段样本，不能算常驻服务 MEM03/04 通过。

## 与 SSH helper 的关系

上游 SSH helper 归档只承载传输侧运行时；GH 远端自举组合的是 helper 所连接的产品运行时。两者共享发布纪律——manifest 校验的载荷、阶段化的失败、原子激活——但 GH 归档从 GH profile 闭包构建，带被禁包剪除与 profile home 模板，两个制品独立演进版本。

控制器先按已知摘要校验上传归档，再提取安装器。安装拒绝链接/特殊条目，即使带 `--force` 也使用唯一 staging，不覆盖旧 release；rollback 在安装锁内读状态并按实际激活顺序回滚。生命周期参数与 `--set-env KEY=value` 值按字面传递，包括空白和空参数。探测与安装器共用必需工具清单，包含 `mktemp`。

PID/日志 runner 命令属于自举预览，目前尚无独立常驻 runtime、Supervisor、持久命令 ACK、断线/重连保证或可靠进程身份检查，均由 GH-006 继续实现。既有 home 仅首次播种，后续需保留用户修改的产品层迁移。
