# GH-001 验证摘要:派生仓库与最小产品组合

日期:2026-10-17。运行目录:`artifacts/gh-validation/gh001-20261017-171001/`。

## 改动目的

从 DSH `dsh-v0.2.1-rc.1`(`1600d8a1e140dcde43a1a0941940a0480712c011`)派生 `glm-harness/runtime` 仓库(分支 `gh/bootstrap`),交付 GLM Harness 的最小产品组合:`@glm-harness/gh-base` bundle、GH profile 初始化、独立数据根与 GH 产品组约束规则。

## 交付内容

- `packages/glm/base`(`@glm-harness/gh-base`):镜像 dsh-base 行集,移除 10 个上游模型/账号/遥测业务包;`web` 行只保留 HTTP fetch;`agent-default-model` 指向未注册的 `glm` provider(显式失败,无回退)。
- `scripts/gh-init-profiles.ts`:向 GH 自有 Harness home 写入 `gh-web`(`gh-base` + `dsh-web-app`)与 `gh-headless`(`gh-base` + `dsh-headless`)profile manifest;不修改 app-boot 的 PROFILE_TEMPLATES。
- `scripts/check-gh-closure.ts`:常设门禁——`@glm-harness` 依赖闭包与组合后 profile 树均不得出现 10 个被禁上游包;bundle layer 未加载也报错。
- `scripts/check-workspace-constraints.ts`:新增"限定到 GH 产品组"规则——`packages/glm/*` 与 `@glm-harness/*` 双向绑定、必须 `private: true`、沿用 dsh 包结构规则(cordis peer/dev、module 入口、payload files);不关闭任何全局门禁。
- `apps/cli` 挂 `@glm-harness/gh-base` 安装依赖;`tsconfig.host.json` 加构建面引用。

## 通过项

1. **无 Key 启动**:gh-web 完整启动,HTTP 服务就绪,带 token 探测 200(37KB 工作台页面);gh-headless 启动至任务接纳,模型请求显式 `NO_ADAPTER: no adapter registered for provider "glm"`。
2. **数据根分离**:fixture home 与用户 `~/.dsh` 完全隔离。
3. **激活树/依赖闭包**:gh-web 组合 178 行、gh-headless 组合干净;`check-gh-closure` 通过;dump 证据存档。
4. **无 pi-ai**:三层证据(依赖闭包、组合树、dump grep)均为空;由常设门禁守护。
5. **门禁**:`constraints`、`typecheck`(host+client)、`build`、`verify-translation-pairing`(1011 对)通过;`gen-dependency-catalog`/`gen-plugin-packages` 重生成无漂移。

## 行为差异(相对 DSH)

- GH profile 启动后无任何模型 provider;新建会话的模型请求显式失败(见上)。这是 GH-003(E02.1/2 自写 GLM 路由)落地前的预期状态。
- 唯一 optional 未激活项:`account-controller` 等待 `deepseekAccount` 服务——上游账号平台被排除的直接可见后果,不影响文件/会话/工具路径。
- `web_search` 无 provider(`web_fetch` 正常);上游 OTel 遥测全部不在闭包内,`desktop-product-telemetry`/`product-analytics` 在非 desktop profile 本就禁用。
- Web 前端仍为 DSH 品牌("DSH Local Build");品牌替换属 E01。

## 未达项与下一步

- 本票不含真实 GLM 请求、远端部署、内存基线(GH-002)、账号(GH-007)。
- lint 全仓结果见后台记录(如失败另行修复)。
- 下一票 GH-002(资源基线与可重复 fixture)可直接使用本次的 profile 启动方法;GH-003 在 `ctx.llm` 上注册 GLM adapter 后,`agent-default-model` 的 `glm` 路由即生效。

## 尚未提供的业务服务

GLM/BigModel/Z.AI 的模型端点、账号 OAuth、PAT、权益——全部未接入(D01 台账);本票验证的是"没有它们时系统行为正确"。
