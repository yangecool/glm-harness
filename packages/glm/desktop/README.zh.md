---
description: "GH 在 dsh web-app 表面之上的产品层：保留名 desktop 组合的覆盖层，移除上游遥测与分析行，同时让未改动的 Electron 壳启动 GH profile。"
kind: "package-bundle"
---

# @glm-harness/gh-desktop

[English](README.md) | 中文

## 概述

桌面 Electron 壳不承担任何 GH 业务逻辑：它只读取 `$DSH_HOME/profiles/desktop` 提供的组合并据此拉起 desktop host。因此 GH 自有的 Harness home 会用 `@glm-harness/gh-base`、`@deepseek-ai/dsh-web-app` 和本 bundle（最后一层）初始化保留的 `desktop` profile。该覆盖层移除两行以保留 profile 名为启用条件的上游行——OTel 产品遥测导出器与客户端分析信标——因为 GH desktop 组合不得向上游生产端点上报。GH 自有的可观测性作为独立层到来；在那之前组合不装载任何导出器。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

`scripts/gh-init-profiles.ts` 把保留的 `desktop` profile 写入 GH 自有的 Harness home，本 bundle 为最后一层。本 bundle 只有紧跟在 `@deepseek-ai/dsh-web-app` 之后才有意义：行按 id 寻址、后写胜出，位置靠前会让 web-app patch 重新启用被移除的行。

```yaml
bundles:
  - '@glm-harness/gh-base'
  - '@deepseek-ai/dsh-web-app'
  - '@glm-harness/gh-desktop'
```

### 你得到什么

只有两行移除，没有其他：组合后的 profile 中 `desktop-product-telemetry` 与 `product-analytics` 变为 `disabled: true`。工作台、webserver、客户端模块清单和每个工作台表面保持 web-app bundle 的原样。

<a id="understand-the-implementation"></a>
## 理解实现

### 组合机制

上游 web-app patch 用 `profileContext.name !== 'desktop'` 守卫其遥测行，所以这些行在 `gh-web` 下保持关闭，只在保留的 desktop 名下点亮——而 GH desktop home 恰好使用这个名字。在其后按 id 覆盖 `disabled: true`，使移除无条件且可审阅：一个文件、一对行，不改 Electron main，也不编辑上游 patch。

### 源码地图

- `cordis.patch.yml` — 本 bundle 贡献的覆盖行。
- `src/index.ts` — 仅有模块文档；没有运行时 API。

<a id="further-exploration"></a>
## 进一步探索

- `scripts/gh-init-profiles.ts` — GH home 的 profile manifest 写入器。
- `scripts/check-gh-closure.ts` — 证明被禁上游包不再进入组合 GH profile 的门禁。
- `packages/bundle/web-app/cordis.patch.yml` — 被覆盖的行及其 profile 名守卫。

<a id="model-experience"></a>
## 模型体验

<a id="composition-effects"></a>
### 组合影响

<a id="what-the-model-sees"></a>
#### 模型所见

覆盖层停用上游遥测行，不贡献模型上下文。

<a id="token-effect"></a>
#### Token 影响

`gh-desktop` 不独立调用模型，token 消耗由组合出的能力 owner 决定。

<a id="kv-cache-effect"></a>
#### KV Cache 影响

本层不序列化请求。改变模型可见能力的选择可能改变前缀，具体影响由对应 owner 说明。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 产品身份（品牌、窗口标题、深链）仍渲染上游壳外观；替换它的 gh-brand 层是独立的 GH 任务。
- GH 自有的上报与诊断在后续可观测性层替换被移除的导出器；在那之前不装载任何导出器。

<a id="dev-note"></a>
### 开发备注

业务行为保留在其所属插件，并验证组合后的 profile。
