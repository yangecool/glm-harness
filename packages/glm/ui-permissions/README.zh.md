---
description: "GH 的 Composer 权限控件：在一个会话输入控件里提供三个对齐 ZCode 的模式与独立的 Plan 开关，读取 ghPermissions 与 plan 会话投影，写入走 /permission 与 /plan 命令。"
kind: "package-bundle"
---

# @glm-harness/gh-ui-permissions

[English](README.md) | 中文

## 概述

挂载这个客户端插件，把 GH 权限面放进 Composer：会话输入区的一枚 chip 显示当前模式，菜单包含三个固定模式（`build`、`guarded`、`yolo`）与独立的 Plan 项。chip 呈现的就是执行器实际执行的——`ghPermissions` 与 `plan` 会话投影（都是宿主侧折叠的持久事实）——每次选择都通过会话命令行写入（`/permission <模式>`、`/plan`），因此 chip、斜杠面和会话日志共享同一条路径。`yolo` 选项带与所有完全访问面相同的显式风险确认；宿主 `/permission` 命令获得同一组固定选项的 `popupSelect` 装饰。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

`@glm-harness/gh-base` 为所有出厂 profile 插入本行；它替换 GH 已禁用的上游 `dsh-client-ui-permission-presets` chip 行。

### 何时选择

当一个表面需要暴露 GH 模式时选择它。没有它，Composer 没有权限控件，模式切换只能通过 `/permission` 命令。

### 最小配置

```yaml
- id: ui-gh-permissions
  name: '@glm-harness/gh-ui-permissions'
```

<a id="understand-the-implementation"></a>
## 理解实现

客户端入口注入 `commandUi`、`sessions`、`slots`、`locale`、`remote`、`remote.commands`，注册 `conversation.input.permission` 槽位并按会话注入：`ghPermissions` 投影可观察对象（chip 当前值）、执行 `/permission <模式>` 的 `select`、读 `plan` 投影决定 `/plan` 或 `/plan off` 的 `togglePlan`。组件是固定三模式单选加 Plan 项——模式集是产品常量，没有宿主目录往返。投影未供给时 chip 渲染为空，这正是宿主缺少 GH 权限服务的情形。

<a id="further-exploration"></a>
## 延伸阅读

- `packages/glm/permissions` 拥有模式、闸门与本 chip 写入所走的 `/permission` 命令。
- `packages/client/ui-permission-presets` 是 GH 组合中被本行替换的上游预设 chip。

<a id="dev-note"></a>
## 开发备注

清单中的 `dsh.client.inject` 控制浏览器加载：仅当宿主组合提供 session-controller、remotes、locale、commands 与 conversation 槽位时入口才激活。开发态桌面宿主经 `@glm-harness/gh-base` 依赖链解析本包；上游预设 chip 行在 profile 层保持禁用，启动门只见到一个占位者。

<a id="model-experience"></a>
## 模型体验

### Composer chip 面向用户

#### 模型看到什么

本包不直接产生模型可见内容：面向模型的模式语句、切换叙述与拒绝理由属于 `gh-permissions`。chip 的每次选择追加的持久切换事件与 `/permission` 命令行完全一致，模型看到相同的提示。

#### Token 影响

无请求形状影响；chip 交互不改变工具目录，也不改提示前缀。

#### KV 缓存影响

除 `gh-permissions` 的切换提示外无影响：选择从不改写缓存前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 选项是固定三模式枚举；不建模宿主配置的额外模式或来自动态目录的逐模式描述（设计如此——GH 恰好提供三个模式）。
- `plan` 投影未供给时 Plan 项隐藏；不区分各表面的 plan 实现。
- chip 位于会话输入槽位，只在打开的会话内渲染，工作区首页不出现。
- 词典仅覆盖 `zh` 与 `en`；其他语言回退 `en`。
