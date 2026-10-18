---
description: "GH 常驻远端服务面：保留 web 传输的服务端半边并剥离浏览器载荷，自带就绪公告行与 ghRemote 身份 RPC，面向无头部署。"
kind: "package-bundle"
---

# @glm-harness/gh-remote-app

[English](README.md) | 中文

## 概述

挂载本包即可把 web 传输变成无头常驻服务。它禁用静态客户端、模块图、HMR 链、客户端插件运行器以及继承的遥测/分析/账号行，保留 webserver、gateway 与 session/job/terminal/workspace 控制器。它认领 webserver 的 fallback 席位，用最小根路由完成启动令牌到会话 cookie 的兑换，打印监守方观察的 `gh-remote ready:` 行，并向连接方暴露 `ghRemote/identity`。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

GH Harness home 中的 `gh-remote` profile 组合 `@glm-harness/gh-base`、`@deepseek-ai/dsh-web-app`，再叠加本包：

```bash
node apps/cli/lib/bin.js --profile gh-remote --no-open --host 127.0.0.1 --port 0
# gh-remote ready: http://127.0.0.1:<port>/?token=<launch-token>
```

打印 URL 中的令牌在根路径兑换会话 cookie；此后所有 API 调用走 `POST /api/<命名空间>/<方法>`，与浏览器客户端完全一致。

### 何时选择它

部署需要常驻服务时选择它：GH-006 的持续执行、重附着与监护都以本组合为目标。`gh-headless` 仍是一次性运行器；`gh-web` 仍是完整浏览器面。

<a id="understand-the-implementation"></a>
## 理解实现

补丁层在 `dsh-web-app` 生效后按 id 移除行：`web-runtime`（静态 dist、URL 行、打开浏览器）、`modules`、`client-hmr`、`cordis-client-runner`，以及桌面层同样移除的遥测/分析/账号行。插件随后认领空出的 webserver fallback 席位：未认证根路径收到 connection 的最小 401，有效启动令牌以标准 303 铸造 cookie，已认证根路径收到明确的“无静态内容”应答。就绪行只在 Loader 落定且 webServer 与 connection 服务存活时打印，与 dsh web 行的契约一致。`GhRemoteIdentityService` 发布 `ghRemote` Remote 命名空间，仅一个 `identity()` 方法，返回产品、profile、运行时、node、平台、架构、pid 与启动时间。

<a id="further-exploration"></a>
## 延伸阅读

- `scripts/gh-remote-service-verify.ts` 对真实 profile 驱动全流程：就绪行、无静态根路径、身份、经 HTTP RPC 的会话回合、第二条连接附着同一会话、干净停机。
- `docs/subsystems/gh-remote-bootstrap.md` 讲解把本 profile 送到目标主机的归档链。
- `packages/glm/desktop` 展示同一 web-app 面上 Electron 壳的兄弟 GH 层。

<a id="dev-note"></a>
## 开发备注

`static inject` 同时要求 `webServer` 与 `connection`，因此本插件无法在没有 web 传输的组合上激活——失败表现为 fiber 停车而非崩溃。Remote 边界类型放在 `./types`，因为 Typert 工作区生成器要求边界类型位于非根公开子路径；生成的 `./typert` 与 `./remote` 面由工作区构建产出。

<a id="model-experience"></a>
## 模型体验

### Identity RPC 面向运维

#### What the model sees

本包对模型不可见：会话在 `gh-base` 组合下与任意面完全一致地运行；`ghRemote/identity` 与就绪行是传输层事实。

#### Token effect

无请求形状影响；本包新增的 RPC 面不改变任何工具目录与提示前缀。

#### KV Cache effect

无：身份查询不触碰会话转录。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 身份快照是进程本地的；目标与安装事实属于部署记录而非本服务（GH-006 监护工作）。
- 除方法可用性外无能力协商；按 generation 作用域的附着语义随 GH-006-D 到来。
- 当前证据覆盖 Linux 回环与同机部署；跨主机 TLS 服务未验证。
- 无静态根路径以纯文本 404 应答；设计上不存在 HTML 外壳。
