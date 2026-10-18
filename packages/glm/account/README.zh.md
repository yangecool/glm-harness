---
description: "GH 账号与项目令牌 owner：两个服务域上的 OAuth 授权码 + PKCE 登录、单飞刷新与按调用方取消、按域账号代次，以及请求级短期 PAT 解析与拒绝即失效——令牌绝不进入会话、日志或快照。"
kind: "package-reference"
---

# @glm-harness/gh-account

[English](README.md) | 中文

<a id="summary"></a>
## 概述

拥有 GH 的账号生命周期与由它派生的短期凭据。每个服务域（`bigmodel`、`zai`）各持一份 OAuth 授权，经凭据缝的记录半边持久化；刷新单飞且按调用方取消，每次登录或注销都会提升该域的代次并丢弃被取代的结果。短期项目令牌（PAT）按物理模型请求解析，一旦传输层报告拒绝即被丢弃——下一次尝试重新铸造。客户端状态与 RPC 视图不含令牌；凭据解析方法只向请求 owner 返回秘密。

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

每个 profile 都携带该行；不配置域时为空服务，不影响其他功能启动。模型调用使用已配置的静态 API key，或显式 `MISSING_CREDENTIAL`。配置的域必须有有效 URL、client id 和 `requestTimeoutMs`（默认 30,000 ms），期限覆盖 token 请求与响应体。

### 最小配置

```yaml
- id: gh-account
  config:
    domains:
      - domain: bigmodel
        authorizeUrl: https://issuer.example.invalid/oauth/authorize
        tokenUrl: https://issuer.example.invalid/oauth/token
        clientId: gh-harness
```

当前签发协议为 fixture：授权码/PKCE，以及 token 端点上的 `urn:glm-harness:pat` 与 `project_id`。这些不是已验证的 BigModel/Z.AI 端点或 grant。真实适配器需依据已核实的官方协议实现业务 JWT、个人/团队项目选择等，不能只改 URL。GLM 路由通过 `preferAccountPat`、`accountDomain` 与 `patProjectId` 启用；只有未登录的域可回落已配置的静态 API key。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现 internals——点击展开</summary>

`src/service.ts` 在登录或解析凭据前等待冷启动恢复。每域的登录完成、刷新与注销串行写入凭据存储，网络结果和持久化前后均检查代次；旧登录、刷新或 PAT 签发不能在注销或新登录后发布。持久化成功后才发布内存凭据。调用方只取消自己的共享刷新等待；owner 为交换设期限，卸载时取消并等待完成。缺失或非法 TTL 明确拒绝，观察者异常不回滚已接受的账号状态。

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

- 真实 BigModel/Z.AI 适配器尚未验收；回环签发方仅验证生命周期机制。实际 OAuth/JWT/PAT 协议、Coding Plan 与真实账号联调仍待完成（D01）。
- 权益事实仅为 token 端点返回的展示性 plan 字符串；额度、计费与套餐执行（E02.7）是独立 owner。
- AUTH 拒绝会使 PAT 失效但不会自动重试请求；用新 PAT 做一次有界重试属于重试策略 owner（E02.5）。
- RPC 支持获取授权 URL 与手动提交 code；尚无桌面回调监听或轮询登录驱动，桌面账号 UI 需要实现经验证的流程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

令牌材料只存在于搬运它的两个模块：`service.ts` 持有授权值，`pat.ts` 持有 PAT 值；其余所有面——快照、RPC 命名空间、日志——只接收身份、套餐与代次事实。单飞刷新在某个调用方取消时仍故意继续跑完，因为一个调用方的取消不应烧掉所有人的轮换。测试用真实 `fetch` 驱动回环签发方而非 mock 客户端，wire 形状因此保持诚实。

</details>
