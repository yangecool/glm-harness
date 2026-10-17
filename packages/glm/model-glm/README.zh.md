# GLM 模型适配器

[English](README.md) | 中文

`@glm-harness/gh-model-glm` 拥有 `glm` provider 路由:GH 自写的 chat-completions 请求序列化器、Server-Sent-Events 解析器与流转译器,绑定到 DSH 的 `LlmAdapter` 接缝。本包不 import、不转发 `llm-pi-ai` 或 `llm-deepseek`;线协议(BigModel / Z.AI 的 `POST {baseURL}/chat/completions`,OpenAI 兼容帧,含 `reasoning_content` 与 `tool_calls` 增量,以 `data: [DONE]` 终止)在本包内按自己的类型实现。

## 行为

请求始终流式(`stream: true` + `stream_options.include_usage`),携带 harness 归属头与逐请求解析的 Bearer 密钥,并在流空闲看门狗之下尊重调用方的中止信号。该协议的推理是二值的:模型目录暴露 `off`/`high` 两档并映射到 GLM 的 `thinking` 开关;`reasoning_content` 增量成为推理块,且绝不回传到后续请求。工具调用分片按线序号组装;终止原因映射 `stop`/`tool_calls`/`length`,而 provider 侧拒绝(如 `content_filter`)会让调用显式失败,而不是伪装成空成功。用量拆分为互斥计数——缓存提示词记入 `cacheReadTokens` 并从 `inputTokens` 中扣除——每个畸形情形(无终止原因、无内容块、工具参数非对象、`[DONE]` 之后仍有帧、流未带 `[DONE]` 就关闭)都是一次明确的分类失败。

密钥逐请求经凭据服务解析(回退到启动环境的 `GLM_API_KEY`);没有密钥时模型调用以 `MISSING_CREDENTIAL` 显式失败——没有上游回退。配置:`baseURL`(默认 `https://open.bigmodel.cn/api/paas/v4`,环境变量 `GLM_BASE_URL`;Z.AI 部署指向 `https://api.z.ai/api/paas/v4`)、`apiKeyEnv`(默认 `GLM_API_KEY`)、`streamIdleTimeoutMs`(默认 120000)。

静态目录(glm-4.6、glm-4.5-air、glm-4.5-flash)陈述的是公开文档能力;尚无真实服务验证(阻塞项 D01),数字应视为声明值而非实测值。未编目的模型 id 解析为纯文本负能力,仍可路由。

## 使用本包

`model-glm` 插件由 `@glm-harness/gh-base` 组合;基于它的 profile 无需额外接线即可获得该路由。无 Key 测试套件(`tests/stream.spec.ts`、`tests/runtime.spec.ts`)驱动纯协议函数,并让适配器对回环 chat-completions 端点运行——在仓库根目录执行 `pnpm exec vitest run --config vitest.config.ts packages/glm/model-glm/tests`。完整无 Key 产品闭环的复现方法:把 `GLM_BASE_URL` 指向本地线协议 mock,再运行 `gh-headless` profile。
