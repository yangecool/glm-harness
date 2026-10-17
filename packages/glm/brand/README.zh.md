---
description: "GLM Harness 产品身份：通用品牌槽位的浏览器占据者加上作为运行时级联覆盖的 GLM 色阶，作为 dsh web-app 表面之上的 bundle 层组合。"
kind: "package-bundle"
---

# @glm-harness/gh-brand

[English](README.md) | 中文

## 概述

dsh 客户端壳之上的 GLM 产品身份，组合方式沿用 Grok Harness 的做法：一个应用在 `@deepseek-ai/dsh-web-app` 之后的 bundle 层，关掉官方品牌行并挂载本包；其浏览器半边用 GLM 火花标记与字标占据通用品牌槽位（侧栏标记与名称、会话空态标记），并以运行时级联覆盖方式安装 GLM 色阶，覆盖平台样式表的强调色自定义属性。不改上游主题文件，不写 Electron main 代码；移除本 bundle 层即整体还原官方身份与色阶。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

`scripts/gh-init-profiles.ts` 在 `gh-web` 与保留名 `desktop` profile 中把本 bundle 列在 `@deepseek-ai/dsh-web-app` 之后；行按 id 寻址、后写胜出，位置靠前会让 web-app patch 重新挂载官方占据者。

```yaml
bundles:
  - '@glm-harness/gh-base'
  - '@deepseek-ai/dsh-web-app'
  - '@glm-harness/gh-brand'
```

### 你得到什么

三个槽位占据者（侧栏标记/名称、空态标记）、覆盖两个主题块的 `--dsw-static-deepseek-*` 与 onboarding 强调色的 GLM 色阶，以及按壳的「产品 + 平台」组合方式呈现的 `GLM` + `HARNESS` 后缀徽标。

<a id="understand-the-implementation"></a>
## 理解实现

### 组合机制

标记使用遮罩（`/glm-mark.svg`、`currentColor` 填充），一份轮廓即可跟随明暗与所有宿主表面；字标字母用随包发布的 Montserrat 品牌字体渲染而非路径字形。色阶覆盖在追加于所有静态样式表之后的样式表里，以相同选择器（`body`、`body[data-ds-dark-theme]`）重新声明相同的自定义属性，按文档顺序胜出；销毁即移除。

### 插件缝之外

没有插件缝的表面通过仓库构建输入中的文案与资产替换承载 GLM 身份，均沿用 Grok Harness 先例：`apps/web/index.html` 的文档标题与 favicon 链接、`apps/web/public/` 的 `glm-*` 资产与 manifest、`apps/desktop/src/locale.ts` 的产品名字符串、`apps/desktop/renderer/` 的欢迎字标资产与更新对话框强调色，以及客户端 locale 文案（品牌回退、空态标题、欢迎说明）。每一项都是字符串或资产替换，没有逻辑改动。

### 源码地图

- `cordis.patch.yml` — 覆盖行（禁用 `ui-brand-official`、插入 `gh-brand`）。
- `src/client/Brand.tsx` — 标记、字标与徽标占据者。
- `src/client/theme.ts` — GLM 色阶及其样式表安装器。
- `src/index.ts` — 宿主 Loader 席位；无运行时 API。

<a id="further-exploration"></a>
## 进一步探索

- Grok Harness 运行时的 `brand` — 本包沿用的先例。
- `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` — 槽位的宿主表面与官方回退。
- `packages/client/ui-theme/src/styles/design-platform.css` — 色阶覆盖所指向的 token 词表。

<a id="model-experience"></a>
## 模型体验

<a id="composition-effects"></a>
### 组合影响

<a id="what-the-model-sees"></a>
#### 模型所见

只改变浏览器身份与主题 slots，不贡献提示、工具 schema 或模型消息。

<a id="token-effect"></a>
#### Token 影响

`gh-brand` 不独立调用模型，token 消耗由组合出的能力 owner 决定。

<a id="kv-cache-effect"></a>
#### KV Cache 影响

本层不序列化请求。改变模型可见能力的选择可能改变前缀，具体影响由对应 owner 说明。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 无框架启动页保留平台词标 `HARNESS`；它是产品中立的，为各 harness 产品共享。
- 启动器的 `dsh` bin 名与控制台前缀保持上游；产品命令命名（`glmh`）属打包任务。
- 更新/安装与欢迎桌面窗在本机以资产与文案级别验证（无显示器、无 Electron 二进制）；这些窗的运行时截图随打包后的桌面构建补齐。

<a id="dev-note"></a>
### 开发备注

业务行为保留在其所属插件，并验证组合后的 profile。
