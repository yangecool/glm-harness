---
description: "GH 远端进程监护：一个数据根、一个常驻服务——串行 install/update/rollback/gc/uninstall/stop 的生命周期事务、lock 目录单实例声明、identity 文件、stdout 就绪契约、版本切换前关闭接纳的排水、持久 runtime id、带断路器的有界崩溃退避，以及 SIGTERM 到 SIGKILL 的排水阶梯；纯 Node、零依赖。"
kind: "package-library"
---

# @glm-harness/gh-remote-supervisor

[English](README.md) | 中文

## 概述

运行这个模块，让常驻 gh-remote 服务独立于任何 SSH 会话或桌面进程存活。一个数据根只接纳一个被监护的子进程：lock 目录拒绝并发持有者，identity 文件发布存活 pid 与就绪 URL，就绪等待一行 stdout 契约，崩溃按封顶指数退避重启，窗口化断路器在阈值处终止循环。`stop` 与 `restart` 通过 SIGTERM 到 SIGKILL 阶梯排空所指名的子进程。任何服务必须活得比起始连接更久的场合都用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

这是一个纯 Node 模块兼 CLI，不是组合行：把 `lib/index.js` 部署在运行时归档旁边运行，指向服务的数据根。

### 何时选择

服务需要熬过断连与桌面退出时选择它。一次性调用（GH-005 的 `bootstrap.sh run`）不需要；任何常驻部署都需要。

### 最小配置

```sh
node lib/index.js --root "$GH_REMOTE_HOME/data" run -- \
  node "$GH_REMOTE_HOME/runtime/lib/bin.js" --profile gh-remote \
  --no-open --host 127.0.0.1 --port 0
```

没有配置文件；行为是固定产品策略（就绪超时 60s，退避 1s 翻倍至 60s，排水宽限 10s，5 分钟 5 次崩溃断路）。动词：`run`、`stop`、`restart`、`status` 读取或作用于数据根的 lock 与 identity 文件；退出码 0 干净、64 用法、69 锁被拒（或不可变 release 冲突）、75 断路打开、76 拉起失败。

### 版本生命周期

不带显式 `-- CMD` 的 `run` 启动当前 release：`<root>/releases/<id>/` 下的不可变运行时目录（各以 `gh-release.json` 清单封缄，入口 `lib/bin.js`，可带自带 `bin/node`），由一次 rename 原子写成的 `<root>/releases/current.json` 指针选定，并链出上一个 release 供回滚。

```sh
node lib/index.js --root "$GH_REMOTE_HOME/data" install --from "$EXTRACTED_RUNTIME" --id r-1
node lib/index.js --root "$GH_REMOTE_HOME/data" update --from "$NEXT_RUNTIME" --id r-2 --drain-timeout 30000
node lib/index.js --root "$GH_REMOTE_HOME/data" rollback
node lib/index.js --root "$GH_REMOTE_HOME/data" gc
node lib/index.js --root "$GH_REMOTE_HOME/data" uninstall          # data kept
```

`install`、`commit`、`use`、`stop`、`restart`、`gc` 与卸载变更通过排他发布获取 `<root>/locks/lifecycle.lock`。声明包含 pid、进程出生身份、nonce、动词与受保护 release。回收在独立排他回收声明下复核旧 nonce；不可读或损坏声明拒绝变更。`status` 可诊断中断持有者，不会自动恢复事务。

`update` 与 `rollback` 先鉴权、确认支持关闭接纳，再关闭新接纳，等待运行回合、pending inbox、直到持久 ACK 的在途 prompt 及组合的 Workspace 活动归零。单一期限覆盖鉴权和 RPC。活动未知、鉴权失败或超时均拒绝切换。关闭后的失败会尝试恢复原先的开放状态，无法确认恢复时明确报告；原本关闭的服务保持关闭。存活的旧版本若不支持关闭接纳，必须先显式停止。

`ensureRuntimeId` 排他发布一个完整持久 id，损坏或持久化失败时拒绝，不重铸替代身份。GC 在生命周期锁内读取保护信息，即使子进程处于退避也保留存活监护器占用的 release，并保留无法确认归属的 staging。损坏的 current 指针拒绝变更；重复选择当前 release 保留回滚目标。只有显式 `--purge` 才删除数据。Bootstrap stop 委托已验证的进程控制，诊断性 `runner.pid` 永不作为信号目标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现 internals —— 点击展开</summary>

`src/index.ts` 以创建目录的方式（POSIX 原子）声明 `<root>/run/supervisor.lock`，并写入含监护进程 pid、全新 nonce 与命令的 `lock.json`。持有者 pid 存活——任何进程——即拒绝；持有者已死的锁被替换。每次拉起都经临时文件 rename 写入 `<root>/run/service.json`（pid、nonce、startedAt、readyAt、restarts、断路状态、readyUrl），读者只会看到完整文档。子进程 stdout 被扫描以 `gh-remote ready: ` 起始的行；该行余下部分是带令牌的服务 URL。崩溃指任何子进程死亡或就绪超时；重启按指数退避（封顶），五分钟窗口内五次崩溃打开断路并结束循环。排水先发 SIGTERM、等满宽限、再 SIGKILL——子进程先退出时每个宽限计时器都会被清除，优雅排水不留任何撑住事件循环的句柄。CLI 的 `stop` 动词停止的是监护进程本身（锁持有者），由它排空自己的子进程，随后清掉被 SIGKILL 的监护留下的孤儿子进程。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 锁、identity、就绪、退避、断路器、排水阶梯、CLI 动词、关闭接纳的 activity 排水 |
| [`src/releases.ts`](src/releases.ts) | 不可变 release 安装、原子 current 指针、gc 钉住、卸载分离 |
| [`src/lifecycle-lock.ts`](src/lifecycle-lock.ts) | 生命周期事务：原子声明、死持有者回收、受保护 release 载荷、中断诊断 |
| [`src/runtime-id.ts`](src/runtime-id.ts) | 持久 runtime id：排他发布、校验、损坏时拒绝 |
| [`tests/supervisor.spec.ts`](tests/supervisor.spec.ts) | 锁竞争、identity 生命周期、就绪行边界、退避封顶、断路、排水升级、CLI 动词 |
| [`tests/releases.spec.ts`](tests/releases.spec.ts) | 安装不可变、指针链、暂存诊断、gc 钉住、卸载数据保留 |
| [`tests/lifecycle.spec.ts`](tests/lifecycle.spec.ts) | 外部持有者等待、重入拒绝、死锁回收、commit 事务、中断动词诊断、runtime id 稳定性 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`@glm-harness/gh-remote-app`](../remote-app/README.zh.md) —— 被监护的常驻服务，及其打印的就绪行
- [gh-remote 运行时归档](../../bundle/base/README.zh.md) —— 监护模块运行其旁的可重定位部署
- [`dsh-session-controller`](../../api/session-controller/README.zh.md) —— 客户端经被监护服务抵达的 RPC 面

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅 POSIX：监护建立在 SIGTERM/SIGKILL 与原子目录创建之上；Windows 服务控制移植是后续工作。
- Linux 控制命令在发信号前核对 boot ID、进程启动 ticks 与所属 nonce；旧记录或无法证明身份时拒绝控制，其他平台需独立验证。identity 含启动令牌，仅 owner 可读。
- 监护被 SIGKILL 后，孤儿服务仍存活时拒绝接管同一数据根，避免并发写同一日志；先用 `stop` 排空孤儿，再重新启动。不支持收养存活孤儿。
- 生命周期尚非一个具有 fencing 的完整事务：`update --from` 安装与切换分次加锁，目标选择、监护器启动与 bootstrap 解压仍存在锁间隙。全量资源/版本 lease、接纳 fencing 与中断事务恢复仍须完成。GC 保守保留 staging；中断回收标记须诊断处理，不静默删除。
- 断路状态在监护进程内；重启后的监护从全新崩溃窗口开始。
- 就绪契约是一行 stdout，缓冲或重定向 stdout 的服务需要保持 `printUrl` 路径在 stdout 上。
- OS 级自启（systemd/launchd 单元）属于另行记录的部署工作，不在本模块内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

刻意零依赖：模块必须能在工作区 node_modules 之外、任何运行时归档旁运行，因此所有助手（锁、identity、排水）都是纯 `node:` 内建。`lib/index.js` 通过 argv 尾板兼任 CLI，仅在作为程序执行时触发；import 本模块不会武装任何东西。测试拉起真实子进程——排水阶梯时序用例慢是刻意的。

</details>
