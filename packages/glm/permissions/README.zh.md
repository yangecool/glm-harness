---
description: "GH 的 ZCode 对齐权限模式——完全访问（yolo）、自主模式（guarded）、变更前确认（build）——含独立 Plan 门禁、结构化危险命令文法，以及在 tools pre-execute 瀑布的执行层裁决。"
kind: "package-reference"
---

# @glm-harness/gh-permissions

[English](README.md) | 中文

## 概述

组合本插件后，GH 会话获得三种 ZCode 对齐权限模式与独立的 Plan 限制，并在真正起作用的位置——`tools/pre-execute` 瀑布、任何工具派发之前——执行。`yolo` 直接运行一般工具；`guarded` 在结构化危险命令文法命中时增加一次确认；`build`（默认）只自动运行被证明只读的工具，其余全部询问。Plan 模式在所有模式下拒绝状态变更。模式是持久的按会话选择，切换会向模型叙述；询问经共享审批链结算，无人应答时失败关闭。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`@glm-harness/gh-base` 为每个发布 profile 组合本插件；它取代上游 `dsh-permission-presets` 行，GH 已禁用该行。

### When to choose it

需要 GH 权限表面时选用。缺少它时，工具调用只受上游沙箱与审批旋钮约束，`/permission` 报告组合默认值而非 GH 模式。

### Minimal configuration

```yaml
- id: gh-permissions
  name: '@glm-harness/gh-permissions'
```

无记录选择的会话使用 `build`。组合默认值可被覆盖（非法值使插件加载失败而不是被忽略）；`rules` 表为 `build` 模式增加按工具的 `deny`/`ask`/`allow` 主题：

```yaml
- id: gh-permissions
  name: '@glm-harness/gh-permissions'
  config:
    defaultMode: !!js "process.env.GH_PERMISSION_MODE"
    rules:
      deny:
        - tool: bash
          subject: 'git push*'
      allow:
        - tool: write
          subject: '/tmp/*'
```

主题按调用的 `command`、`url`、`file_path`、`path`、`pattern` 或 `patch_text` 做内容匹配：精确、命令前缀 `prefix:*` 或 `*` 通配。用 `/permission yolo|guarded|build` 切换在线会话；Plan 保持独立，走 `/plan`。旧选择（`edit`、DSH 预设名）按可解释映射迁移，不再作为菜单选项出现。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部——点击展开</summary>

`src/index.ts` 持有 `permission/mode` 会话事件、`ghPermissions` 投影（含旧 `permission/preset` 迁移）、`glm:permission-mode` 运行时上下文语句、`/permission` 命令，以及注册在 `tools/pre-execute` 上的门禁。判定顺序对齐 ZCode 的 permission service：Plan 转换策略、Plan 只读门（全模式）、`guarded` 的危险规则询问、`yolo` 直通、规则表（`deny` → `ask` → `allow`）、再到 `build` 的类别证明。`ask` 由工具运行时经 `ctx.approval` 结算，因此每次询问都有 `approval/asked`/`approval/decided` 审计对，无应答者时失败关闭。

`src/analysis.ts` 是原生 POSIX 分析器：带引号/转义事实的词法（`dynamic`、未引用通配）、按 `;`/换行/管道分段并剥离控制关键字、wrapper 与环境变量前缀解包、重定向扫描与静态 heredoc 跳过，以及对 `$(...)`/反引号与 `shell -c` 载荷的递归分析——藏在替换里的危险命令同样命中。文法之外的一切标记 `unsupported`，绝不读作安全：`build` 询问，也不授予任何只读证明。危险文法覆盖 `rm`（递归、多目标、通配）、强制 git 历史/树丢失（`reset --hard`、`clean -f`、强推、`checkout`/`restore` 树丢弃、`stash clear`、`worktree remove -f`）、`find -delete`/`-exec`、`dd`/`mkfs` 族与 rsync `--delete`，语义对齐 ZCode 的选项表。

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 模式、持久折叠、叙述、提示语句、`/permission` 与执行器门禁 |
| [`src/analysis.ts`](src/analysis.ts) | POSIX 分段、词法事实、危险文法、只读分类 |
| [`tests/permissions.spec.ts`](tests/permissions.spec.ts) | 文法表测试与跨全部模式的真实组合门禁测试 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@glm-harness/gh-base`](../base/README.zh.md) — 组合本插件并在底层保留沙箱/审批服务的组合层
- [`dsh-user-approval`](../../interaction/user-approval/README.zh.md) — 所有询问经其结算的审批链
- [`dsh-plan-mode`](../../plan/plan-mode/README.zh.md) — 门禁读取的独立 Plan 状态
- [`dsh-tools`](../../core/tools/README.zh.md) — 门禁执行所在的 `tools/pre-execute` 瀑布

-----

<a id="model-experience"></a>
## Model Experience

### GH 权限模式语句

#### What the model sees

运行时上下文中的一句话（`glm:permission-mode`）说明当前模式：`Permission mode: full access.` 直通工具并说明 Plan 与升级限制；`Permission mode: autonomous.` 说明危险操作确认；`Permission mode: confirm before changes.` 说明哪些动作会询问。切换以一行用户通知到达（`The session permission mode changed from "build" to "yolo" (changed by the user).`），拒绝携带可行动的理由（Plan 限制会指出 `exit_plan_mode` 或 `/plan off`）。

#### Token effect

语句是历史之后运行时上下文里的一句话（约 25 token）；切换只追加一条短通知，不重写前缀。

#### KV Cache effect

模式与审批策略语句一样位于保留历史之后，会话中切换不会重写已缓存的系统前缀；只有新通知与后续请求不同。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- 分析器仅覆盖 POSIX bash；`pwsh` 参数不会获得危险命中或只读证明（build 询问，guarded 像任何未解析命令一样直通）。CMD/Git Bash 方言随 Windows shell 支持补齐。
- 只读证明是保守表：未知命令、未知 git 子命令与重动态结构在 `build` 下询问而不是运行；ZCode 的完整只读策略表未整体迁入。
- `build` 模式在无人值守运行中按设计失败关闭；headless 确认流（非交互默认或排队审批）随远端工作延后。委派子代理保持组合默认与上游 `never` 审批钉死——子代理向用户的审批路由随 GH 子代理切片落地。
- Composer 模式控件经 `@glm-harness/gh-ui-permissions` 接线（三选项菜单加独立 Plan 勾选，已在真实 Electron 桌面验证）；PER05/06/07/10（草稿/队列语义、回执重放、工作区身份、真实远端端到端）仍是未完成的验收门。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

PER02/03/04 的本地覆盖在 `tests/permissions.spec.ts`（真实 `ctx.tools.execute` 过门禁）；构建产物证据（build 询问失败关闭、yolo 直写、真实系统提示中的模式语句）在产品 smoke 的 `permission-build-denied` 与 `permission-yolo-writes` 场景。

</details>
