# GH-002 资源基线运行摘要(gh002-20261017-180858)

改动目的:建立可重复的 GH 资源基线设施——`benchmarks/glm/` 下进程树 PSS 采样器与场景驱动、1000 会话合成语料 fixture(含 11,620 事件的采用会话)、100 循环启动稳定性——并在同一台机器、同一份 fixture 字节上给出 GH(gh-web/gh-headless)与上游载体(shipped web/headless)的同载体对照。本运行只发布原始数字,不发布任何 MEM 预算结论。

方法:语料用 benchmarks/session-corpus 的合成生成器(22 个实测分位形态,无任何录制用户材料);两套 home 通过逐条目符号链接共享同一语料字节;被测进程一律是已构建的 `apps/cli/lib/bin.js`。采样按 ppid 遍历整棵进程树,每秒读一次 `/proc/<pid>/smaps_rollup`(adopt 场景 100ms);PSS 为树和主指标,RSS/private/swap 并记;采样驱动自身 CPU 随每个结果记录。空闲场景:boot → 就绪 → 静置 15s → 测 60s;adopt 场景:`--session-id bench-00990 "continue"`,无凭据下模型调用显式失败后进程退出(gh: `NO_ADAPTER`;dsh: `MISSING_CREDENTIAL`),度量装载路径全程。

## 数字(run-full,60s 窗口 PSS 树和)

| 场景 | gh | dsh | 差(gh−dsh) |
| --- | --- | --- | --- |
| idle-empty p50 / max | 122.3 / 122.3 MiB | 133.8 / 133.8 MiB | −11.5 MiB |
| idle-corpus p50 / max | 141.6 / 184.0 MiB | 155.0 / 196.4 MiB | −13.4 MiB(稳态) |
| adopt 峰值(100ms 采样) | 133.7 MiB | 150.8 MiB | −17.1 MiB |
| boot-cycles ×100 boot p50 | 905 ms | 1004 ms | −99 ms |
| boot-cycles ×100 +2s 稳态 PSS p50 / max | 183.0 / 203.1 MiB | 194.2 / 201.7 MiB | −11.2 MiB(p50) |

观察(事实,不是结论):gh 侧因 gh-base 显式闭包移除了 10 个上游模型/账号/遥测包,稳态 PSS 与启动时长全面低于同载体 dsh;idle-corpus 在 boot 后存在一致的衰减瞬态(窗口起点 ~184/196 MiB,约 14s 内衰减到稳态 ~142/155 MiB,与 boot-cycles +2s 读数一致),来自 web 启动期对语料的处理;adopt 峰值即 11,620 事件会话装载的内存路径峰值。重复运行(run-main vs run-full):idle p50 差异 ≤3 MiB,瞬态形状一致。

## 通过项 / 未达项

通过:fixture-idle、fixture-corpus-1000、fixture-adopt-10k-events、fixture-boot-cycles-100、process-tree-and-os-basis、sampler-cost、repeatability(见 cases.json)。

未达:not-run——ZCode 固定修订基线(构建需 Node ≥24,本机 22.23.2,解锁步骤:安装 Node 24 后重建 aac4755 再测);skipped——进程内 heap/external 与 cache/lease/handle 计数(需进程内资源采样 provider,属 E12 后续,任何 MEM 判定前必须补上)。

## 行为差异(gh vs dsh,实测)

- gh-web boot 时 stderr 有 `dsh: warning: 1 entry did not activate`(web-app 的 account-controller 期待 deepseekAccount 服务,gh-base 已移除;可选条目未激活,boot 成功,GH-001 已记录);dsh 无此告警。
- 无凭据模型调用:gh 报 `NO_ADAPTER: no adapter registered for provider "glm"`(GH-003 落地前的显式失败,无上游回退);dsh 报 `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`。两者退出码均为 1。

## 依赖与下一步

依赖:GH-001 的 gh-web/gh-headless 可启动;构建产物 `apps/cli/lib/bin.js`。下一步:安装 Node 24 解锁 ZCode 基线;E12 进程内资源采样 provider(heap/external/cache 计数)后才能谈 MEM01–07 预算;GH-003 原生 GLM adapter 接 ctx.llm(adopt 场景届时应在真实模型失败/成功路径上重测)。复现方法:`benchmarks/glm/README.md`(seed → run,fixture 根用一次性 mkdtemp 目录)。
