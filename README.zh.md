# GLM Harness

[English](README.md) | 中文

GLM Harness（`glmh`）是一个面向 GLM 大模型的编码 agent harness，提供桌面、Web 与无界面（headless）三种形态。它复用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件运行时——Cordis、启动器、agent 循环与客户端平台——并以 `@glm-harness/*` 插件 bundle 交付所有 GLM 专有产品行为，而不是另起分支改写。

具体来说：

- GLM 模型路由是自实现的 OpenAI 兼容 chat-completions 协议栈（`@glm-harness/gh-model-glm`，默认端点 `https://open.bigmodel.cn/api/paas/v4`），不复用任何上游模型插件；
- 产品 profile（`gh-web`、`gh-headless` 以及保留名 `desktop`）一律从 `@glm-harness/gh-base` 起组合，而非 `@deepseek-ai/dsh-base`；
- 保留名 desktop profile 由 GH overlay 认领，同时关闭该保留名原本会启用的上游遥测行；
- GLM 品牌识别——色阶、标志、字标与产品文案——由品牌 bundle 经插件槽位系统注入，另有少量就地身份修改（文档标题、favicon 与渲染层资产、桌面文案）；
- Electron 主进程、启动器与共享 agent 循环中不含任何 GLM 业务逻辑。

<a id="branches-and-upstream"></a>

## 分支与上游

| 分支 | 内容 |
| --- | --- |
| `main` | GLM Harness 的提交历史：一份压缩为单个提交的 DSH 基线快照，加上 GLM Harness 的各张卡。不包含上游的提交序列。 |
| `upstream` | 本仓库所基于的 DeepSeek Harness 基线，基于 `dsh-v0.2.1-rc.1`，保留完整上游历史。只读参考。 |

`origin` 指向 `deepseek-ai/deepseek-harness`，只拉取，永不推送。

<a id="status"></a>

## 状态

自举阶段。已交付（每张卡的证据都记录在 `artifacts/gh-validation/` 下）：

- 运行时派生与显式无 DeepSeek 依赖的 base bundle（GH-001）；
- 可复用夹具的资源基线（GH-002）；
- 原生 GLM 提供商路由（GH-003）；
- Web 最小工作流原型与保留名桌面组合（GH-004）；
- GLM Harness 初步品牌层与部分界面替换（GH-BRAND）。

实时台账——包括受阻项与未达标预算——见 [docs/glm/delivery-status.json](docs/glm/delivery-status.json)。远端归档、直接 SSH 自举、常驻服务监护与重连已有实现切片；完整远端生命周期和桌面集成仍在审查中。

对真实 GLM API 的验证仍在等待凭据，在台账中保持未决；目前的每一条工作流结论都由证据运行中记录的脚本化 mock 端点支撑。

<a id="run-from-source"></a>

<a id="run"></a>

## 从源码运行

### 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm
- 启动桌面 shell 时需要显示器

### 构建并初始化 profile

```sh
pnpm install
pnpm run build
pnpm tsx scripts/gh-init-profiles.ts
```

最后一条命令把 GH 产品 profile 写入 `~/.glmh`（可用 `--home <dir>` 覆盖）。重复执行不会改动已初始化的 profile。

### 启动

```sh
# Web UI at http://127.0.0.1:3080 by default
DSH_HOME=~/.glmh node apps/cli/lib/bin.js gh-web

# Electron shell over the reserved desktop profile
DSH_HOME=~/.glmh pnpm start:desktop

# Headless agent loop, no UI
DSH_HOME=~/.glmh node apps/cli/lib/bin.js gh-headless
```

这三个 profile 名与任何 DSH profile 的启动方式完全一致，因为它们就是普通 profile：启动器加载某个 home 下 `profiles/<name>` 提供的内容。`desktop` profile 为 Electron shell 保留，终端启动器会拒绝以它启动。

### 配置模型

在 Web UI 的 Settings → Models 中为 GLM 路由存入凭据（默认端点 `https://open.bigmodel.cn/api/paas/v4`）。请求走 GH 自实现的传输层，不涉及其他模型插件。

<a id="repository-layout"></a>

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `packages/glm/base` | `@glm-harness/gh-base`——所有 profile 的起点 base bundle |
| `packages/glm/model-glm` | `@glm-harness/gh-model-glm`——GLM chat-completions 协议栈（transport、SSE、translate） |
| `packages/glm/brand` | `@glm-harness/gh-brand`——品牌识别、主题色阶与槽位占用者 |
| `packages/glm/desktop` | `@glm-harness/gh-desktop`——保留 profile overlay，关闭上游遥测 |
| `scripts/gh-init-profiles.ts` | 写入启动器在运行时发现的 profile 组合 |
| `scripts/check-gh-closure.ts` | 门禁：GLM 闭包必须不含上游模型、账号与遥测包 |
| `docs/glm/delivery-status.json` | 交付台账 |
| `artifacts/gh-validation/` | 已记录的验证运行（配置、用例、日志、截图） |
| `apps/`、`packages/`、`vendor/` | 上游 DSH 运行时，按导入原样保留 |

<a id="development"></a>

## 开发

```sh
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test
pnpm tsx scripts/check-gh-closure.ts
pnpm run constraints
pnpm run verify-translation-pairing
```

`check-gh-closure` 会组合每一个 GH profile，一旦 `@glm-harness` 依赖闭包或组合后的 profile 出现上游模型、账号或遥测包即失败。在让 agent 操作真实工作区之前，请先阅读[安全说明](SAFETY.zh.md)。

主分支推送和手动运行会构建 [Windows x64 未签名预览包](.github/workflows/gh-windows-x64.yml)与 [Linux 运行时归档](.github/workflows/gh-remote-release.yml)。Windows 预览包显式指定独立应用 ID，不需要本地发行账号文件。只有 `gh-v*` tag 才向 GitHub Releases 附加制品；签名安装与自动更新资格单独验收。继承的真实 DeepSeek 测试仅在上游仓库或显式配置 `DSH_ENABLE_REAL_API_E2E=true` 时执行；启用后仍必须提供其 API 密钥。

桌面打包将运行时入口所需的私有工作区插件一起打成本地 tarball，既保留 GH 插件的私有属性，也补齐本地包集合；无关插件不进入集合。Windows 打包失败会保留诊断日志，并在检查注释中显示最后的日志内容。

<a id="license"></a>

## 许可证

MIT，继承自 DeepSeek Harness；第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。GLM Harness 是独立的衍生项目，与 DeepSeek AI 及 GLM 模型厂商无隶属关系。
