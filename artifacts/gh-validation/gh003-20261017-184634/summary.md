# GH-003 运行摘要(gh003-20261017-184634)

改动目的:落地 `glm` provider 路由的原生模型层——`@glm-harness/gh-model-glm`(请求序列化 + 自写 SSE 解析 + 流转译 + LlmAdapter 绑定),替换 GH-001 时代"指向未注册 provider"的占位状态;无 pi-ai/llm-deepseek 的 import 或转发。

方法:协议按 BigModel/Z.AI v4 chat-completions(OpenAI 兼容帧 + `reasoning_content`/`tool_calls` 增量 + `[DONE]` 终止)在本包内自实现;纯函数层(serialize/sse/translate/transport)以事件数组直接单测,适配器层对回环 HTTP 端点测线形状与失败路径;产品级闭环用本地线协议 mock 端点 + `GLM_BASE_URL` 指向完成,无真实凭据。gh-base 组合新增 model-glm 行,apps/cli 与 host 构建面接入;闭包门禁(banned 双向)保持绿色。

结果:33 项单测全过;门禁 constraints/typecheck/lint/i18n/build/gh-closure 全绿;gh-web 组合树 179 行含 model-glm;无 Key gh-headless 由 NO_ADAPTER 变为设计中的 `MISSING_CREDENTIAL`(exit 1);mock 闭环 gh-headless 任务与 session-title 辅助调用都走适配器,stdout `好`、exit 0——完整文本闭环(agent-loop → ctx.llm → adapter → HTTP → SSE → chunks → assistant 消息)在无 Key 环境验证通过。

## 关键语义(实测口径)

- 推理:目录暴露 off/high 两档,映射 `thinking.type`;`reasoning_content` → reasoning 块,历史回传时丢弃。
- 工具:分片按线序号组装;`tool_calls` 终态;空参数记 `{}`;非对象参数(非 max-tokens)→ MALFORMED_RESPONSE。
- 用量:cached_tokens → cacheReadTokens 且从 inputTokens 扣除(互斥口径);reasoning_tokens 单列。
- 失败:401/403→AUTH、429+retry-after→RATE_LIMIT(附 requestId)、quota/context 文本分类、5xx→SERVER、未知状态→HTTP_n;带内 error 帧分类;无 finish/无块/流缺 `[DONE]` 分别 MALFORMED/EMPTY/STREAM_CLOSED;provider 拒绝(content_filter)显式失败不冒充空成功。
- 配置:baseURL 默认 open.bigmodel.cn,`GLM_BASE_URL` 覆盖(Z.AI:api.z.ai/api/paas/v4);密钥 `GLM_API_KEY` 逐请求经凭据服务解析,缺失即显式失败。

## 未达项(如实记录)

- 真实 GLM 服务验证(E02 验收的"受控真实请求")仍阻塞于 D01;目录三模型的上下文窗口等数字为公开文档声明值,未实测。
- 分片 JSON 边界(极长参数跨多帧)已由单测覆盖三片组装,但真实服务的分片粒度未观测。
- adapter 未实现 replayState(GLM 协议无 thinking 签名回传需求);若后续需要冻结回放态再扩展。

## 下一步

GH-004 桌面最小完整工作流(依赖本卡);D01 解锁后补真实 endpoint/access/model 协议表实测与 wire fixture 录制(脱敏)。
