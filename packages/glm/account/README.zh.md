---
description: "GH 账号与项目令牌 owner：两个服务域上的 OAuth 授权码 + PKCE 登录、单飞刷新与按调用方取消、按域账号代次，以及请求级短期 PAT 解析与拒绝即失效——令牌绝不进入会话、日志或快照。"
kind: "package-reference"
---

# @glm-harness/gh-account

[English](README.md) | 中文

<a id="summary"></a>
## 概述

拥有 GH 的账号生命周期与由它派生的短期凭据。每个服务域（`bigmodel`、`zai`）各持一份 OAuth 授权，经凭据缝的记录半边持久化；刷新单飞且按调用方取消，每次登录或注销都会提升该域的代次并丢弃被取代的结果。短期项目令牌（PAT）按物理模型请求解析，一旦传输层报告拒绝即被丢弃——下一次尝试重新铸造。所有公开面在构造上就不含令牌。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

这是一个组合行：gh-base 挂载它，常驻服务通过 `ghAccount` Remote 命名空间（`status`、`beginLogin`、`completeLogin`、`logout`）供已连接客户端驱动。

### 何时选择它

每个 profile 都携带该行；它是否起作用取决于配置。未配置任何域时 owner 空挂载——其余功能照常启动，模型调用走静态密钥路径（或以 `MISSING_CREDENTIAL` 显式失败）。

### 最小配置

```yaml
- id: gh-account
  config:
    domains:
      - domain: bigmodel
        authorizeUrl: https://account.bigmodel.cn/oauth/authorize
        tokenUrl: https://account.bigmodel.cn/oauth/token
        clientId: gh-harness
```

端点是配置而非代码：生产指向真实服务，验证指向回环 fixture。PAT 授权为同一 token 端点上的 `urn:glm-harness:pat`，由 access token 认证、按 `project_id` 限定。GLM 路由以 `preferAccountPat` 加 `accountDomain` 与 `patProjectId` 启用；未登录的域回落到静态密钥路径，绝不回落到上游实现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现 internals——点击展开</summary>

`src/service.ts` 为每个域保存一份状态：持久化授权、单调代次、共享的在途刷新、以及待完成登录的 PKCE verifier。`beginLogin` 构造带 S256 challenge 的授权 URL；`completeLogin` 校验 CSRF state、交换 code、提升代次（取代前一授权的在途刷新）并把轮换后的授权写入 `gh-account/<domain>` 凭据记录。`accessToken` 在距过期超过刷新余量时直接返回缓存令牌；否则所有并发调用方共享一次刷新交换，每个调用方的 `AbortSignal` 只停止自己的等待——交换为其他调用方跑完。`src/pat.ts` 按域缓存一枚 PAT 直到过期余量；`rejectPat` 只移除被服务端拒绝的那枚令牌，被拒凭据绝不复用。`src/oauth.ts` 以纯 `fetch` 函数承载 PKCE 助手与两种 token 交换。

| 文件 | 角色 |
|---|---|
| [`src/service.ts`](src/service.ts) | 域状态、登录生命周期、代次、单飞刷新、授权持久化 |
| [`src/pat.ts`](src/pat.ts) | 请求级 PAT 解析、过期余量缓存、拒绝失效 |
| [`src/oauth.ts`](src/oauth.ts) | PKCE 对生成、code 与 refresh 交换 |
| [`tests/account.spec.ts`](tests/account.spec.ts) | 登录往返、单飞、调用方取消、代次取代、冷启动水合、PAT 生命周期（回环签发方） |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`@glm-harness/gh-model-glm`](../model-glm/README.zh.md) — 在静态密钥之前先解析 PAT 的 provider 路由
- [`dsh-credentials`](../../credentials/credentials/README.zh.md) — 记录半边存储授权的缝
- [`@glm-harness/gh-remote-app`](../remote-app/README.zh.md) — 常驻服务上的 `ghAccount` Remote 命名空间

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 未接触任何真实 BigModel 或 Z.AI 服务：所有流程均以回环签发方验证；真实账号联测（D01）需要真实凭据。
- 权益事实仅为 token 端点返回的展示性 plan 字符串；额度、计费与套餐执行（E02.7）是独立 owner。
- AUTH 拒绝会使 PAT 失效但不会自动重试请求；用新 PAT 做一次有界重试属于重试策略 owner（E02.5）。
- 桌面本地回调登录（相对于经 RPC 驱动的轮询/重定向流）随桌面账号 UI 到来。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

令牌材料只存在于搬运它的两个模块：`service.ts` 持有授权值，`pat.ts` 持有 PAT 值；其余所有面——快照、RPC 命名空间、日志——只接收身份、套餐与代次事实。单飞刷新在某个调用方取消时仍故意继续跑完，因为一个调用方的取消不应烧掉所有人的轮换。测试用真实 `fetch` 驱动回环签发方而非 mock 客户端，wire 形状因此保持诚实。

</details>
