# GH 权限模式

[English](gh-permissions.md) | 中文

GH 权限模式是由 [gh-permissions](../../packages/glm/permissions)（`ctx.ghPermissions`，`GhPermissionService`）持有的 ZCode 对齐权限表面：三种模式——完全访问（`yolo`）、自主模式（`guarded`）、变更前确认（`build`）——加独立的 Plan 限制，全部在 `tools/pre-execute` 瀑布、任何工具派发之前执行。本插件取代 GH 对[权限预设](permission-presets.zh.md)的使用：GH 组合它而不是 `dsh-permission-presets`，模式是执行器裁决而非底层[沙箱模式](sandbox.zh.md)与[审批策略](approval.zh.md)旋钮的打包，两个底层服务保留各自的行与语义。[包 README](../../packages/glm/permissions/README.zh.md) 持有组合状态、分析器细节与限制。

Source: [`packages/glm/permissions/src/index.ts`](../../packages/glm/permissions/src/index.ts)

## Logged state and recovery

`permission/mode`（`{ mode }`）是 log-only、整值替换的[会话事件](session.zh.md)：持久、可重放，从不出现在模型转写中。`ghPermissions` 投影单元折叠最新值，并按可解释映射迁移旧 `permission/preset` 选择（`edit` 与 `read-only` → `build`、`workspace-write` → `guarded`、`danger-full-access` → `yolo`），而不是复活预设菜单。`ctx.ghPermissions` 通过 `stateOf()` 读取折叠值；首次依赖访问在注册表或键缺失时失败。无记录选择的会话使用组合默认（未配置即 `build`），委派子会话同样从默认开始而不继承父会话模式。完整事件声明见[持久化日志事件目录](../persistence-catalog.zh.md)。

## The decision order

门禁为每个带调用方 agent 的工具调用运行，顺序对齐 ZCode 的 permission service。`exit_plan_mode` 仅在 Plan 模式已记录激活时放行。Plan 激活期间——任何模式下——被证明只读的工具与用户交互运行，所有状态变更被拒绝，理由会指出 `exit_plan_mode` 或 `/plan off`。其余情况：`yolo` 直通一般工具；`guarded` 直通，除非危险命令文法命中——命中时询问一次；`build` 先查规则表（`deny`、再 `ask`、再 `allow`），然后只自动运行只读类工具与分析器证明只读的 shell 命令，其余全部询问，包括一切未解析内容。工具自有的升级审批与沙箱保持独立，不受模式影响。每次 `ask` 经[审批接缝](approval.zh.md)结算，因此有 `approval/asked`/`approval/decided` 审计对，未组合应答者时失败关闭——是拒绝，不是静默运行。

## Shell analysis

内置 POSIX 分析器产出词法事实（引号/转义处理后的值、展开与未引用通配标记），按分隔符与管道分段并剥离控制关键字，解包 wrapper 与环境变量赋值，扫描重定向并跳过静态 heredoc 内容。命令替换、反引号与 `shell -c` 载荷被递归分析，藏在展开里的危险命令同样命中。危险文法覆盖递归/多目标/通配 `rm`、强制 git 历史与树丢失、`find -delete`/`-exec`、`dd`/`mkfs` 族与 rsync `--delete`，采用 ZCode 的选项表语义；help、dry-run 与查询形式豁免。文法之外的一切标记 `unsupported`，绝不读作安全：不宣称危险命中，也不授予只读证明，`build` 因此询问。

## Configuration

```ts type-equiv
/** Plugin config: composition default mode and the rule table. */
interface Config {
  /** Mode for sessions without a logged selection; `build` when unset. */
  readonly defaultMode: Volatile<GhPermissionMode | undefined>
  /** Structured rules consulted in `build` mode (and recorded for all modes). */
  readonly rules: PermissionRules
}
```

`defaultMode` 部署覆盖遇到非法值时使插件加载失败，而不是被忽略。规则主题按调用的 `command`、`url`、`file_path`、`path`、`pattern` 或 `patch_text` 做内容匹配——精确、命令前缀 `prefix:*` 或 `*` 通配——规则评估仅在 `build` 模式先于只读证明；`yolo` 与 `guarded` 绕过规则表，对齐 ZCode 的判定顺序。

## The `/permission` command

组合 [`ctx.commands`](commands.zh.md) 时，插件注册 `/permission [<mode>]`：无参数时报告生效模式与 Plan 状态；带 `yolo`、`guarded` 或 `build` 时追加持久选择，并以一条用户通知向模型叙述切换。旧名称经迁移映射解析，结算文本带显式的 "(migrated …)" 而不是报错。该命令不触碰在途调用：已派发的工具保留其裁决，新模式约束下一次门禁评估。

## The service

`ctx.ghPermissions` 持有带叙述的持久模式选择、`glm:permission-mode` 运行时上下文语句、`/permission` 命令与执行器门禁；`get`/`set`/`effectiveMode` 签名见生成的[服务目录](#ctxghpermissions--ghpermissionservice)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxghpermissions--ghpermissionservice"></a>

### `ctx.ghPermissions` — `GhPermissionService`

`ctx.ghPermissions`: the durable mode selection, its narration and prompt statement, the `/permission` command, and the executor-level gate.

```ts cordis-catalog
/**
 * The session's effective mode: its folded selection (migrated when legacy),
 * else the composition default.
 * @param session - the exact accepted session.
 * @returns the mode every gate decision for this session uses right now.
 */
effectiveMode(session: Session): GhPermissionMode

/**
 * Read one agent's current mode and plan state for display.
 * @param agent - the agent whose session is read.
 * @returns the effective mode and whether plan mode is logged active.
 */
get(agent: Agent): { mode: GhPermissionMode; plan: boolean }

/**
 * Switch one live agent's mode: append the durable selection and narrate the
 * change for the next model step. Switching does not touch an in-flight
 * call — already-dispatched tools keep their decision.
 * @param agent - the live agent whose mode changes.
 * @param mode - the new effective mode.
 */
set(agent: Agent, mode: GhPermissionMode): void
```

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/glm/permissions/src/index.ts`](../../packages/glm/permissions/src/index.ts)
<!-- END GENERATED cordis-surface -->
