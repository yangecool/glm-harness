---
description: "通过公共 LLM 接口提供原生 GLM 文本/工具请求、流、推理回传和用量计量。"
kind: "package-reference"
---

# GLM 模型适配器

[English](README.md) | 中文

<a id="summary"></a>
## 概述

通过公共 LLM 服务调用 GLM 文本和工具模型，请求/SSE 由 GH 自有实现处理。GH base 默认挂载本适配器并选择 `glm-4.6`。请求逐次解析凭据、有界等待、回传同模型推理，并按真实字段记录用量。真实 GLM 服务集成、其他协议、账号和多模态尚未验证或完成。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

`model-glm` 插件由 `@glm-harness/gh-base` 组合;基于它的 profile 无需额外接线即可获得该路由。无 Key 测试套件(`tests/stream.spec.ts`、`tests/runtime.spec.ts`)驱动纯协议函数,并让适配器对回环 chat-completions 端点运行——在仓库根目录执行 `pnpm exec vitest run --config vitest.config.ts packages/glm/model-glm/tests`。完整无 Key 产品闭环的复现方法:把 `GLM_BASE_URL` 指向本地线协议 mock,再运行 `gh-headless` profile。

<a id="understand-the-implementation"></a>
## 理解实现

请求始终流式(`stream: true` + `stream_options.include_usage`),携带 harness 归属头与逐请求解析的 Bearer 密钥,并遵守调用方的取消信号。取凭据、响应头和 HTTP 错误正文共享请求期限，响应流另有空闲看门狗。该协议的推理是二值的:模型目录暴露 `off`/`high` 两档并映射到 GLM 的 `thinking` 开关;`reasoning_content` 增量成为推理块。同一 provider/model 的 assistant 消息在后续请求中按原顺序回传这些字节；切模型则省略该推理。端点特有的 preserved-thinking 控制仍需实现与真实验证。工具调用分片按线序号组装;终止原因映射 `stop`/`tool_calls`/`length`,而 provider 侧拒绝(如 `content_filter`)会让调用显式失败,而不是伪装成空成功。原始用量分片先合并再投影；缺失计数保持未知，已知缓存零值保留。合法 null 内容/推理增量不产生文本，其他非字符串值显式失败。用量拆分为互斥计数——缓存提示词记入 `cacheReadTokens` 并从 `inputTokens` 中扣除——每个畸形情形(无终止原因、无内容块、工具参数非对象、`[DONE]` 之后仍有帧、流未带 `[DONE]` 就关闭)都是一次明确的分类失败。

密钥逐请求经凭据服务解析(回退到启动环境的 `GLM_API_KEY`);没有密钥时模型调用以 `MISSING_CREDENTIAL` 显式失败——没有上游回退。配置:`baseURL`(默认 `https://open.bigmodel.cn/api/paas/v4`,环境变量 `GLM_BASE_URL`;Z.AI 部署指向 `https://api.z.ai/api/paas/v4`)、`apiKeyEnv`(默认 `GLM_API_KEY`)、`requestTimeoutMs`(默认 30000)、`streamIdleTimeoutMs`(默认 120000)和 `retryPolicy`(默认 normal 模式三次重试,覆盖 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` 与 `STREAM_CLOSED`;上游重试执行器仍被禁止,由 `gh-model-retry` 的 GH 执行器运行该策略)。

静态目录(glm-4.6、glm-4.5-air、glm-4.5-flash)陈述的是公开文档能力;尚无真实服务验证(阻塞项 D01),数字应视为声明值而非实测值。未编目的模型 id 在上游 I/O 前以 `UNSUPPORTED_MODEL` 失败，不虚构上下文或输出上限。GH 默认选择 `glm-4.6`。

<a id="further-exploration"></a>
## 延伸阅读

- [LLM 服务](../../llm/llm/README.zh.md) —— 公共适配器契约。
- [GH base](../base/README.zh.md) —— 产品组合。

<a id="model-experience"></a>
## 模型体验

<a id="glm-request-and-replay"></a>
### GLM 请求与回传

<a id="what-the-model-sees"></a>
#### 模型所见

适配器不添加 persona 提示或工具。它转换 canonical 请求并回传同模型推理，保留工具续轮所需上下文。用量分别记录非缓存输入和缓存读取；推理 token 是输出的子集，不重复计费。路由到 `glm` 的辅助请求也使用同一适配器。

<a id="token-effect"></a>
#### Token 影响

原始提示/输出/缓存计数先合并再投影。缺失保持未知；缓存输入与非缓存输入互斥，推理是输出的子集。

<a id="kv-cache-effect"></a>
#### KV Cache 影响

相对以前丢弃推理的行为，推理回传会改变实际请求前缀。稳定序列化本身不能证明 provider 缓存命中，需读取真实计数。模型/端点特有的缓存控制尚未验证。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 真实 GLM、Coding Plan/PAT、多模态、完整 provider 配置、persona/工具策略和端点特有的 preserved-thinking 控制尚待完成。当前不提供自动请求重试：上游重试实现已排除，GH 自有有界重试作为后续任务。零值或过期的 Retry-After 不施加额外服务端等待，也不改变 HTTP 错误分类。

<a id="dev-note"></a>
### 开发备注

协议行为属于适配器；共享 loop 改动需要公共契约与消费者测试。
