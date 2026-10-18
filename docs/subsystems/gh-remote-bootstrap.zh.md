# GH 远端运行时自举

[English](gh-remote-bootstrap.md) | 中文

远端运行时自举是 E04.2 的制品链，把一份完整的 GH 运行时放到没有任何 Node 的 SSH 可达 Linux 主机上：一个可重定位归档（staging 出来的 CLI 闭包、自带的 `bin/node`、初始化好的 profile home 模板、POSIX 安装器、逐文件摘要清单），一条走真实 OpenSSH 的控制器部署管线，以及验收工具。控制器侧位于 [`scripts/gh-remote/`](../../scripts/gh-remote)，构建入口是 [`scripts/build-gh-remote-archive.ts`](../../scripts/build-gh-remote-archive.ts)；它有意复用上游 [SSH subsystem](ssh.zh.md) 的工具模式，但交付的是完整运行时而不是传输 helper。

来源：[`scripts/gh-remote/artifact.ts`](../../scripts/gh-remote/artifact.ts)、[`scripts/gh-remote/bootstrap.ts`](../../scripts/gh-remote/bootstrap.ts)、[`scripts/gh-remote/deploy.ts`](../../scripts/gh-remote/deploy.ts)

## 归档

先 `pnpm run build`，再 `node --import tsx/esm scripts/build-gh-remote-archive.ts`：以 SSH helper 同款的 legacy-deploy 步骤 staging `@deepseek-ai/dsh` CLI 闭包，修复该部署会丢掉的部分（工作区拥有的 peer 与传递依赖物化到不动点；GH 禁用的上游业务包被剪除），用真实 `gh-headless` profile 对回环 GLM fixture 启动 staging 闭包自检，全部通过后才把 `gh-remote/`（bootstrap、`bin/node`、`runtime/`、`home-template/`、`LICENSES/`）连同 `.sha256` 边车打包成 `dist-exe/gh-remote/gh-remote-<version>-<target>.tar.gz`。载荷内的 `manifest.json` 固定格式、版本、commit、目标、node 版本以及每个文件的 SHA-256 与权限；`verifyPayload` 在激活前拒绝缺失、多余、重复、被改动或权限不符的文件。

## Bootstrap

`bootstrap.sh` 由 `scripts/gh-remote/bootstrap.ts` 生成为 POSIX sh，在目标机上无 Node 运行：`install` 探测内核/架构/libc，校验归档摘要与解压后的文件清单（awk 从 manifest 解出 `sha256sum` 核对表逐字节核对），在 `flock` 下 staging，把 release 移入 `releases/<时间戳>-<commit>-<唯一后缀>`，并只在首次播种 `home/`；激活本身委托给自带的 supervisor CLI——其 `commit` 动词在一个生命周期事务内封缄 release 清单并切换 `releases/current.json` 指针（POSIX 层只做解压与校验，一切共享状态变更都归 supervisor）。`run`/`start` 经自带 node 执行常驻 `gh-supervisor` profile，由 supervisor 插件看护服务子进程、其崩溃退避与就绪；`stop` 先杀 runner 再委托 supervisor 停止（排空可能被孤立的 service）。`update` staging 并校验新归档后交给 supervisor 的 `install`+`update` 动词——先经服务的 `ghRemote/admission` RPC 关闭新接纳、等运行中活动归零、停止、切换指针、再从新 release 重新看护；`rollback`、`gc`、`uninstall`、`status` 同样委托。每次失败都报出所属阶段并以该阶段的退出码结束（probe 90 …… usage 98），控制器据此定位错误而不是猜（F24）。目前仅支持 Linux glibc 目标；mac/windows 远端随平台资格（E04.6）接入。

## 控制器管线

`scripts/gh-remote-deploy.ts` 管理目标、首次指纹确认、探测、上传和安装。当前验证路径是直接 host/port/私钥；完整部署在扫描/上传前拒绝 SSH config alias 与 ProxyJump，其指纹发现和上传尚未实现。密码、agent、交互认证、跳板与独立主机保持未验收。`scripts/gh-remote-verify.ts` 使用真实回环 OpenSSH 与无 Node PATH 监牢验证；`scripts/gh-remote-mem.ts` 对 supervisor 常驻服务采样 MEM03/04（`/proc/*/smaps_rollup` 的进程树 Rss/Pss）——`gh-supervisor` profile 下的就绪保持，以及经 `ssh -L` 隧道以普通 prompt 驱动的合成长任务。

## 与 SSH helper 的关系

上游 SSH helper 归档只承载传输侧运行时；GH 远端自举组合的是 helper 所连接的产品运行时。两者共享发布纪律——manifest 校验的载荷、阶段化的失败、原子激活——但 GH 归档从 GH profile 闭包构建，带被禁包剪除与 profile home 模板，两个制品独立演进版本。

控制器先按已知摘要校验上传归档，再提取安装器。安装拒绝链接/特殊条目，即使带 `--force` 也使用唯一 staging，不覆盖旧 release；rollback 在安装锁内读状态并按实际激活顺序回滚。生命周期参数与 `--set-env KEY=value` 值按字面传递，包括空白和空参数。探测与安装器共用必需工具清单，包含 `mktemp`。

常驻 supervisor 是产品接缝：`gh-supervisor` profile（单行 Cordis 组合，[`packages/glm/remote-supervisor-app`](../../packages/glm/remote-supervisor-app/README.zh.md)）认领数据根、铸造持久 runtime id，让恰好一个服务子进程熬过断线与桌面退出；每个变更动词都经 supervisor 的生命周期锁（[`gh-remote-supervisor`](../../packages/glm/remote-supervisor/README.zh.md)）串行化，并发动词相互等待，被中断的事务经 `status` 保持可诊断。PTY/全局 lease 与完整的资源排水覆盖仍属 GH-009；既有 home 仅首次播种，后续仍需保留用户修改的产品层迁移。
