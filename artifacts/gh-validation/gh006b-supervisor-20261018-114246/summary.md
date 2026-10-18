# GH-006-B 验收摘要：远端进程监护

交付 `@glm-harness/gh-remote-supervisor`（`packages/glm/remote-supervisor`）：纯 Node、零运行时依赖的监护库兼 CLI（`lib/index.js` 双职责，argv 尾板仅在被执行时武装）。GH-006-A 的常驻 `gh-remote` 服务由此获得独立于 SSH 会话与桌面进程的存活能力。

## 能力面

- 数据根单实例：`run/supervisor.lock` 目录创建原子声明；存活 pid（任意进程）持有即拒绝（exit 69），持有者死亡则替换（陈旧窃取），空目录竞争以 EEXIST 收敛。
- 子进程身份：`run/service.json` 经临时文件 rename 原子重写（pid、nonce、startedAt、readyAt、restarts、circuitOpen、readyUrl）；每次拉起重置 readyUrl——身份永不指向上一代监听器（该缺陷在真服务联验中捕获并修复）。
- 就绪契约：等待 stdout 行 `gh-remote ready: <url>`，默认 60s 超时；超时按崩溃计并排水。
- 崩溃退避：指数退避 1s 翻倍封顶 60s；5 分钟窗口 5 次崩溃打开断路器（exit 75）；spawn 失败（ENOENT）单独归类（exit 76）。
- 排水阶梯：SIGTERM → 宽限 10s → SIGKILL；宽限计时器在子进程先退出时清除（优雅排水不滞留事件循环——10s 滞留缺陷在计时复现中捕获并修复）。`stop` 动词停止的是监护进程本身（锁持有者）并清掉被 SIGKILL 监护留下的孤儿子进程。

## 验证

- 单元 18/18（真实子进程）：锁生命周期/竞争、identity 容错、就绪行跨块/前置噪音、退避封顶序列 [10,20,25]、断路、排水升级、CLI 动词与退出码、SIGKILL 重启。
- 真服务联验 8/8（`scripts/gh-remote-supervisor-verify.ts`）：构建产物 CLI 监护真实 `gh-remote` profile（loopback GLM fixture、合成凭据）——identity 与 RPC pid 一致、完整 session 回合写入、第二监护被拒（69）、kill -9 后新 pid/新端口恢复并 RPC 可用、status 如实、stop 双双排空并清除 identity/lock。
- 闸门：build 9/9、oxlint 0、gh-closure/工作区约束/运行时闭包全过、doc-sync 除既有 GH-018 repository-references 台账项外全过（本切片未触碰该清单文件）。

## 边界（如实记录）

- 仅 POSIX（SIGTERM/SIGKILL、原子目录创建）；Windows 服务控制为后续工作。
- 陈旧锁窃取以 pid 存活判定，不防 OS pid 复用；nonce 防同根混淆。
- 断路状态在监护进程内，监护重启后从新窗口开始。
- OS 级自启（systemd/launchd）为部署侧文档工作，不在本包内。
- 断路器未在真服务上复演（需 ~5 次真崩溃+退避，时长不经济）；由单元断路用例与真服务单次崩溃恢复覆盖语义。
