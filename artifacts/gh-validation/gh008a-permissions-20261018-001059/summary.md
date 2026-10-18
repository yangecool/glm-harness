# GH-008-A 证据：ZCode 三种权限与独立 Plan（本地切片）

Run: `gh008a-permissions-20261018-001059`（见 run.json）。基于 `main` @ `0813632f52` 的工作树；ZCode 对照 `aac47556`（v3.15.1）。

## 交付

- `packages/glm/permissions`（`@glm-harness/gh-permissions`）：`permission/mode` 持久事件 + `ghPermissions` 投影（含旧 preset 迁移）、`glm:permission-mode` 运行时上下文语句、`/permission` 命令、`tools/pre-execute` 执行门（ZCode 判定顺序：plan-exit 策略 → plan 只读门（全模式）→ guarded 危险询问 → yolo 直通 → deny/ask/allow 规则 → build 类别证明）。
- 原生 POSIX 分析器：引号/转义词法、分段与控制关键字剥离、wrapper/env 解包、重定向与 heredoc 扫描、`$()`/反引号/`shell -c` 载荷递归；危险文法（rm/git/find/dd 族/rsync，ZCode 选项表语义）；`unsupported` 绝不判安全。
- 组合接线：gh-base 新增 `gh-permissions` 行（`GH_PERMISSION_MODE` 覆盖默认，非法值加载失败）；`dsh-permission-presets` 行禁用；approval 行改为字面 `ask`（工具自有升级审批在 yolo 下仍询问）；sandbox 行不动（非机械映射）。
- smoke 新场景 `permission-build-denied` / `permission-yolo-writes`；持久化记录 `2026-10-17-gh-permission-mode`；subsystems 页 `gh-permissions(.zh).md`；README/配置目录/事件图/服务目录/清单全部再生成。

## 验证

见 gates.log：445 项受影响测试（permissions 66）、build 9/9+328 制品、闭包、持久化 66/16、persistence-formats、constraints、lint、smoke 5/5、doc-sync 42/1（仅已知 repository references）。

复现（runtime/）：

```bash
node node_modules/vitest/vitest.mjs run packages/glm scripts/check-gh-closure.spec.ts packages/interaction/user-approval/tests packages/plan/plan-mode/tests
pnpm run build
node --import tsx/esm scripts/check-gh-closure.ts
node --import tsx/esm scripts/gh-product-smoke.mjs /tmp/gh-product-smoke.json
node --import tsx/esm scripts/persistence-changes.ts --check
```

## 边界（未完成）

PER05/07/09/10 与大部分 PER06 保持开放（见 cases.json）；pwsh/CMD/Git-Bash 方言分析、Web Composer 模式控件、headless 确认流、子代理审批路由、`GH_PERMISSION_MODE` 之外的新会话“最近选择”持久化均未做。真实 GLM（D01）、Electron、远端未测。
