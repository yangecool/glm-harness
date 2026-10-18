# GH-004-C 干净桌面安装入口 — 验收证据

日期：2026-10-18。范围：桌面产品 profile 接缝（product-profile）、干净 home 首启与恢复。对照计划 11.8 C / RV25 的"干净桌面 home 仍选上游 WEB_PROFILE"缺口。

## 接缝设计

- `apps/desktop/src/product-profile.ts`：`ProductProfile`（bundles、homeDirName、homeProfiles、profilePatch、productName）。解析顺序 `$DSH_DESKTOP_PRODUCT_PROFILE` → `<runtime>/product-profile.json` → 上游默认（与既有行为逐字节一致）。`productPinnedHome` 只在用户未设 `$DSH_HOME` 时给出产品 home（`.glmh`）。坏元数据响亮失败，绝不猜组合。
- `packages/boot/app-boot`：新增导出 `applyProfilePatchIfPristine`（只在 pristine 用户 patch 层上播种产品 patch，永不覆盖用户编辑）。
- `DesktopProjectManager`：外部 profile（disableAllPlugins/applyRelease/createPluginProfile）与项目元数据（runtime/development）全部改用产品组合；默认参数保持上游构建流不变。
- `main.ts`：启动即解析产品、必要时钉 `process.env.DSH_HOME`（Electron、Host 子进程、CLI 一致）、播种 homeProfiles。
- `scripts/gh-init-profiles.ts`：`renderGhProductProfile()` 输出 GH 产品文档（desktop 组合、`.glmh`、五个 home profile 及各自 patch）；`--product-profile <path>` 写盘供打包与验证。
- `apps/desktop/scripts/dev.ts`：与打包后相同的优先级（显式 `$DSH_HOME` > 产品 home > 开发默认）。

## 验证（本目录）

`DISPLAY=:99 node --import tsx/esm scripts/gh-desktop-run.mjs <out> --clean-home`（真实 Electron、Xvnc、回环 GLM fixture、CDP 驱动）：

1. **干净 home 首启**：不预播种任何 profile；`HOME` 指向 fixture 用户 home；仅经 `DSH_DESKTOP_PRODUCT_PROFILE` 驱动。首启后断言：`~/.glmh` 存在且 `~/.dsh` 未被触碰；`profiles/{desktop,gh-web,gh-headless,gh-remote,gh-supervisor}` 全部播种 GH 组合；desktop profile 含 `@glm-harness/gh-brand` 与产品 patch（`- id: system-prompt`）。
2. **产品功能**：GLM 模型入目录、真实任务经 write 工具完成（fixture 文件内容相符、系统提示含 "powered by GLM Harness"）、权限芯片三模式 + 独立 Plan、yolo 双确认、审批面板——截图 01–09。
3. **恢复**：向 desktop profile 的 `cordis.patch.yml` 追加用户标记，SIGTERM 停止，二次启动：composer 回来、用户 patch 原样保留（截图 10–11、run.log）。

`result.json`：`{"passed":true,"cleanHome":true,"home":"…/userhome/.glmh"}`。普通模式（预播种 home）同脚本同样通过（normal-mode.log）。

## 单元

`apps/desktop/tests/product-profile.spec.ts` 6/6：上游回退、runtime 旁读取、env 覆盖优先、坏元数据响亮拒绝、home 钉住优先级、播种幂等且保留用户编辑。

## 本轮修复的既有缺陷（先于本切片存在，HEAD 复现确认）

1. **桌面欢迎流硬失败**：web-app 组合的上游 `account-controller` 在 GH 组合中因缺少 `deepseekAccount` owner 永远 pending，`account/getState` 使 boot 硬失败。修复：GH profile patch 禁用该行（与 `ui-permission` 同型）；welcome 容错同时接受 envelope 的 `gateway/invocation-unavailable` 与传输层 404（`WelcomeHttpError`），其余仍硬失败。
2. **桌面测试快照/期望漂移**：品牌化（DeepSeek→GLM）后 fatal-recovery/welcome-renderer/tray/quit-confirmation/background-notice/main-startup 的快照与内联期望未更新（HEAD 复现确认）。已更新为当前产品输出；`about-panel` 中来自 mock app name 的 `applicationName` 保留上游值。
3. **既有失败（未修复，准确记录）**：`macos-notarization-proxy.spec.ts` 15 例在 HEAD 同样失败——其 flock addon 探测路径与构建产物布局不匹配，且 `pnpm --dir` 调用与当前 pnpm 不兼容；属 macOS 打包工具（本会话明确暂缓的平台），留待该平台恢复时修复。

## 边界

- 本平台验证走未打包开发入口（Linux）；Windows 安装包与发版按指令暂缓。
- 打包发行（product-profile.json 随 runtime 描述符入包、签名、安装器）是发版切片的工作；本切片交付接缝、元数据生成器与干净 home 验证。
