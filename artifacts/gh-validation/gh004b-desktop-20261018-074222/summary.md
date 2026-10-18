# GH-004-B 原生桌面、视觉与资源收口 — 验证小结(2026-10-18)

在真实 Electron(解包 dev 启动,linux-x64 开发目标)上首次跑通 GH desktop profile 全链路:GLM 品牌 UI、模型选择菜单、真实 composer 提交(Lexical 输入)、运行中停止控件、build 模式审批面板(Allow once 后工具执行)、完成与逐字落盘校验、GH 权限 chip(三模式+独立 Plan)、yolo 风险确认切换、Plan 开关;全流程四跑可重复(run16/17/18/19 passed)。

## 根因修复

1. **权限 chip 不渲染**:desktop/web 组合把 dsh-plan-mode 挂进 agent preset isolate(planMode:true),全局 planMode 服务不存在,gh-permissions 的 static inject 永远停车(plugin inventory 显示 phase=pending)。修复:去掉 planMode 注入,plan 状态改读共享 `plan` session projection(两个面都发布);plan-inventory 确认 fiber 转active,ghPermissions 出现在会话投影。
2. **changed-files 卡片桌面确定性缺失**(复现历史间歇问题的桌面形态):①桌面会话 cwd 是 default workspace 而 runner 写入 /tmp fixture 之外,workspace-changes recorder 只记工作区内变更;②权限 gate 的 pre-execute 'ask' 短路了后置注册的观察者(workspace-changes 的 capture 注册在 web-app 层、晚于 gh-base 的 gate),捕获永不注册。修复:①runner 经 XDG_CONFIG_HOME 重定向 Documents 并改相对路径写入;②gate 改为 next() 后组合判定(下游 deny/cancel 保留、ask 只让位于本 gate 的 deny)。修复后 workspace/changes 事件入日志、卡片 +0s 出现,3/3 稳定。
3. **锁定态迟报**:chmod 000 sessions+storages 后应用仍启动(boot 40→92.2s),提交的消息无声消失(无任何 UI 错误,90s 无反馈),比 web 的 38.6s 迟报更差;唯一痕迹在渲染器 console。修复(可观测性半):desktop host stderr 直通应用日志,修复后 EACCES 启动期即入日志(提交前 ~105s,此前 0 条)。UI 面错误提示缺口属上游客户端,如实登记未修。

## MEM 重测(全进程树采样,修复后的采样器)

- MEM01 空闲:产品口径(排除 dev 脚手架 ~450-520MiB)中位 **1154.6 MiB**(electron-main 354.9 / host 322.9 / renderer 226.4 / gpu 164.7 / utility 90.6);历史 web 口径 577 MiB。
- MEM02 回合后:中位 **1037.9 MiB**(回合峰值 1146.8;host 回落到 283)。
- 结论:未达 450 MiB 候选,原生桌面约为 web 面两倍;资源削减归 GH-009(按需激活/回收)。泄漏证明需长程进程内测试,不在本切片。

## 门禁

- vitest glm+closure+sampler+desktop-host:12 文件/156 测试 PASS(permissions 包 66)。
- host bundle tsdown 重建 + apps/desktop 完整重建:PASS。
- check-gh-closure:PASS(闭包与组合 profile 无上游业务包)。
- workspace constraints:PASS。
- oxlint 触达面:0 警告 0 错误。
- gh-product-smoke:5/5 PASS(含 permission-build-denied / permission-yolo-writes)。
- doc-sync:20 通过 / 1 失败——仅 verify-repository-references(0813632f52 起既有的 11 处历史 commit pin,GH-018 登记,与本切片无关);本切片新增 ui-permissions 双语 README+i18n 记录,修正 delivery-status 一处含糊来源措辞。

## 遗留(如实登记)

- 锁定态 UI 无用户可见错误(上游客户端面);boot 期锁定重试 92s 的收敛归 GH-009/上游。
- GH 默认工作区路径仍为 `<Documents>/deepseek-harness/default-workspace`(上游常量,GH 改名待议)。
- MEM 远超候选;VIS01/03/05 截图齐(01-home/03-turn-running/04-approval-panel),VIS02/04(恢复/远端)未及。
- 手机远控维持暂缓。
