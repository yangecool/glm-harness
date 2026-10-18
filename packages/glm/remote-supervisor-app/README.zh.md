---
description: "gh-supervisor 产品形态：一个极简 Cordis 插件，把纯 Node 看护库作为常驻组合运行——认领数据根、铸造持久的 runtime id、从当前 release 拉起 gh-remote 服务子进程，并以看护循环自身的退出码结束 runner；所有可调参数都是经过校验的 Config。"
kind: "package-bundle"
---

# @glm-harness/gh-remote-supervisor-app

[English](README.md) | 中文

## 概述

把这个插件作为整个 `gh-supervisor` profile 运行：一行 Cordis 组合保活已部署的 gh-remote 服务。启动时它解析数据根（Config、`GH_REMOTE_ROOT`、然后是 `~/.glmh-remote`），铸造持久 runtime id，读取当前 release 指针，并在共享 home 下拉起该 release 的 `gh-remote` 服务子进程。profile 的存活与看护循环完全一致：显式停止、崩溃熔断或锁被拒都以循环自身的退出码结束 runner。退避、排水预算、就绪超时与子进程绑定地址都是 Config——profile 补丁即可调整，无需重建。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知局限与遗留工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

这是单行组合插件，不是供导入的库：它存在是为了让 `gh-supervisor` 以一棵完整的 Cordis 树启动、不叠加任何基础层，把常驻看护的内存压到插件下限。

### 何时选择它

当运行时归档的常驻看护需要成为产品形态时选择它——POSIX bootstrap 的 `run`/`start` 动词执行的正是这个 profile（`lib/bin.js --profile gh-supervisor --no-open --host 127.0.0.1 --port 0`）。已经自持进程看护的部署可以改用纯 `gh-remote-supervisor` 库。

### 最小配置

```sh
DSH_HOME=/srv/gh/home GH_REMOTE_ROOT=/srv/gh \
  node <release>/runtime/lib/bin.js --profile gh-supervisor --no-open --host 127.0.0.1 --port 0
```

profile 的 Config 承载看护契约：`root`（数据根；留空依次读 `GH_REMOTE_ROOT`、`~/.glmh-remote`）、`home`（子进程的 `DSH_HOME`；留空时存在 `<root>/home` 则使用它）、`childProfile`（`gh-remote`）、`host`/`port`（子进程绑定地址；`0` 取空闲端口）、`readyTimeoutMs`（60 秒）、`baseBackoffMs`/`maxBackoffMs`（1 秒翻倍封顶 60 秒）、`drainTimeoutMs`（SIGTERM 到 SIGKILL 的 10 秒宽限）、`crashThreshold`/`crashWindowMs`（5 分钟窗口 5 次崩溃触发熔断）。profile 补丁可以在不重建的情况下覆盖其中任意一项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`GhSupervisorAppService` 启动时解析数据根、调用库的 `ensureRuntimeId` 并读取当前 release 指针；没有当前 release 的数据根是一次响亮的启动失败（exit 70 直写 stderr——该 profile 不组合任何 logger 控制台出口）。子进程通过 `launcherFor(releaseDir)` 拉起（优先使用 release 自带的 `bin/node`），并导出 `GH_REMOTE_ROOT`、`GH_REMOTE_RELEASE_ID` 与解析出的 `DSH_HOME`，让服务子进程在 `ghRemote/describe` 握手中报告自己的 release 身份。看护结果映射到 CLI 的退出码契约（0 已停止、69 锁被拒、75 熔断打开、76 拉起失败），并经由注入的 `appExit` 可调用接口结束 runner；销毁时停止看护器并排水子进程。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config 模式、启动序列、看护接线、结果到退出码的映射 |
| [`cordis.patch.yml`](cordis.patch.yml) | 唯一的 `gh-supervisor-runner` 行：本插件即完整树 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`@glm-harness/gh-remote-supervisor`](../remote-supervisor/README.zh.md) —— 本 profile 运行的看护库与 CLI，含在其之下切换 release 的生命周期动词
- [`@glm-harness/gh-remote-app`](../remote-app/README.zh.md) —— 常驻服务子进程、它的就绪行与 `ghRemote` 身份 RPC
- [gh-remote 运行时归档](../../bundle/base/README.zh.md) —— 由 bootstrap 执行本 profile 的可重定位部署

## 已知局限与遗留工作

<a id="known-limitations-and-deferred-work"></a>

- 仅限 POSIX，继承自看护库：生命周期信号基于 SIGTERM/SIGKILL。
- profile 只在启动时解析 release；release 切换经由看护 CLI 的 `update`/`rollback` 动词完成——它们会停掉当前 runner 并从新 release 重新拉起。
- 每个数据根一个看护器：第二个看护器对同一数据根认领失败而非共享。
- 操作系统级自启（systemd/launchd 单元）属于另行记录的部署工作，不在本 profile 内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

插件注入 `dsh-cmdline` 的 `appExit` 可调用接口而非直接 `process.exit`，让每种 profile 启动器（Electron、CLI）都拥有真正的收尾路径。启动失败直写 stderr，因为极简 profile 不组合 logger 出口——归档运维读 `log/runner.log` 即可看到原因，无需打开调试器。Config 默认值与库 CLI 的固定策略一致，除非补丁另有说明，profile 与纯 CLI 的看护行为完全相同。

</details>
