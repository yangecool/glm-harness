---
description: "GH 远端进程监护：一个数据根、一个常驻服务——lock 目录单实例声明、identity 文件、stdout 就绪契约、带断路器的有界崩溃退避，以及 SIGTERM 到 SIGKILL 的排水阶梯；纯 Node、零依赖。"
kind: "package-reference"
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

`install` 把源复制进暂存目录后以一次 rename 提交，release 要么完整要么不存在，同 id 重复安装被拒绝。`update` 与 `rollback` 先轮询存活服务的 `ghRemote/activity` RPC 直到没有运行中的 agent（或排水超时），经排水阶梯停止、切换指针、再从新 release 拉起；identity 文件记录当前运行的 release。`gc` 移除中断安装的暂存残留和没有任何钉住的 release——current、回滚目标、以及存活服务仍在运行的 release 都保留。`uninstall` 移除运行时与服务状态但保留数据根的其余字节；`uninstall --purge` 才删除整个数据根。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现 internals —— 点击展开</summary>

`src/index.ts` 以创建目录的方式（POSIX 原子）声明 `<root>/run/supervisor.lock`，并写入含监护进程 pid、全新 nonce 与命令的 `lock.json`。持有者 pid 存活——任何进程——即拒绝；持有者已死的锁被替换。每次拉起都经临时文件 rename 写入 `<root>/run/service.json`（pid、nonce、startedAt、readyAt、restarts、断路状态、readyUrl），读者只会看到完整文档。子进程 stdout 被扫描以 `gh-remote ready: ` 起始的行；该行余下部分是带令牌的服务 URL。崩溃指任何子进程死亡或就绪超时；重启按指数退避（封顶），五分钟窗口内五次崩溃打开断路并结束循环。排水先发 SIGTERM、等满宽限、再 SIGKILL——子进程先退出时每个宽限计时器都会被清除，优雅排水不留任何撑住事件循环的句柄。CLI 的 `stop` 动词停止的是监护进程本身（锁持有者），由它排空自己的子进程，随后清掉被 SIGKILL 的监护留下的孤儿子进程。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 锁、identity、就绪、退避、断路器、排水阶梯、CLI 动词、activity 排水 |
| [`src/releases.ts`](src/releases.ts) | 不可变 release 安装、原子 current 指针、gc 钉住、卸载分离 |
| [`tests/supervisor.spec.ts`](tests/supervisor.spec.ts) | 锁竞争、identity 生命周期、就绪行边界、退避封顶、断路、排水升级、CLI 动词 |
| [`tests/releases.spec.ts`](tests/releases.spec.ts) | 安装不可变、指针链、暂存诊断、gc 钉住、卸载数据保留 |

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
- 陈旧锁窃取只检查 pid 存活，无法区分被复用的 pid；nonce 防同根混淆，但不防崩溃后的 OS pid 回收。
- 断路状态在监护进程内；重启后的监护从全新崩溃窗口开始。
- 就绪契约是一行 stdout，缓冲或重定向 stdout 的服务需要保持 `printUrl` 路径在 stdout 上。
- OS 级自启（systemd/launchd 单元）属于另行记录的部署工作，不在本模块内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

刻意零依赖：模块必须能在工作区 node_modules 之外、任何运行时归档旁运行，因此所有助手（锁、identity、排水）都是纯 `node:` 内建。`lib/index.js` 通过 argv 尾板兼任 CLI，仅在作为程序执行时触发；import 本模块不会武装任何东西。测试拉起真实子进程——排水阶梯时序用例慢是刻意的。

</details>
