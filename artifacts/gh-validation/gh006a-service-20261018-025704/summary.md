# GH-006-A 常驻远端服务组合 — 验证摘要

对应计划 11.8 GH-006-A：最小 `gh-remote` 常驻服务 profile（不是一次性 gh-headless）。

## 交付

- `packages/glm/remote-app`（`@glm-harness/gh-remote-app`）：web-app 面之上的 GH 常驻服务层——禁用 web-runtime（静态 dist/URL 行/开浏览器）、modules（浏览器模块图）、client-hmr、cordis-client-runner，以及桌面层同样移除的 telemetry/analytics/account 行；插件认领 webserver fallback 席位，最小根路由完成启动令牌→会话 cookie 兑换（未认证 401、已认证明确“无静态内容”）；Loader 落定后打印 `gh-remote ready: <authenticated URL>`（监守方观察契约，替代 dsh web 行）；`ghRemote/identity` Remote 方法返回 product/profile/runtime/node/pid/startedAt。
- `gh-remote` profile 注册进 `scripts/gh-init-profiles.ts`（gh-base + dsh-web-app + gh-remote-app；纳入 web 面禁用集）；apps/cli 依赖与 tsconfig.host 引用接线。

## 验证（全部真实执行）

- 服务验收 6/6（`scripts/gh-remote-service-verify.ts`，真实 profile 进程 + 真实 HTTP RPC + 回环 GLM）：就绪行、无静态（未认证根 401 纯文本）、identity（pid 与进程一致）、经 RPC 的会话回合在会话工作区写盘、**第二条独立连接（新 cookie）经 session/list 附着同一会话**、SIGTERM 干净退出 0。
- 单测 29/29（含审查加固后的 bootstrap/deploy 矩阵）；smoke 5/5；closure（gh-remote profile 纳入检查，无被禁包）/constraints/oxlint 0/0；doc-sync 42 过/1 失败（仅既有 repository references，GH-018 台账项）。

## 边界

- Supervisor 独立进程、持久接纳/回执、持续执行与断线重附着、版本生命周期、断线/崩溃/内存联验（GH-006-B..F）未开始；本切片的“附着”是第二条连接读同一会话，断线续跑语义属 D。
- 回环同机部署；跨主机 TLS 服务未验证。
