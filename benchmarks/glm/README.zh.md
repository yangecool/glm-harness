# GH 资源基线

[English](README.md) | 中文

[run-gh-baseline.ts](run-gh-baseline.ts) 在同一台机器、同一份 fixture 上度量 GLM Harness 相对其上游载体的常驻内存开销,对应 GH 计划的任务 GH-002。它只发布原始数字:MEM 预算本身归交付计划的 §10.6 所有,本目录不发布任何结论。主指标是整棵进程树的 PSS 之和([proc-tree-sampler.ts](proc-tree-sampler.ts)),每秒从 `/proc/<pid>/smaps_rollup` 读取一次,RSS、private、swap 一并记录;在相邻采样之间出现或退出的进程恰好贡献其存活期间的那些采样。

## 运行

在仓库根目录、已构建 CLI(`pnpm run build`;驱动拒绝启动 tsx 源码路径)的前提下:

```sh
corepack pnpm exec tsx benchmarks/glm/run-gh-baseline.ts seed --fixture-root <fresh-dir>
corepack pnpm exec tsx benchmarks/glm/run-gh-baseline.ts run --fixture-root <fresh-dir> --out <dir> \
  [--settle-sec 15] [--measure-sec 60] [--cycles 0] [--sets gh,dsh]
```

其中 `<fresh-dir>` 是调用方自建的一次性目录。`seed` 用 [session-corpus 语料生成器](../session-corpus/synthetic-corpus.ts)一次性生成合成语料——1,000 个 Session 覆盖 22 个实测分位形态,不含任何录制的用户材料——并把同一份字节链接进每个集合的 `$DSH_HOME/sessions`。`gh` 集合启动产品的 `gh-web`/`gh-headless` profile;`dsh` 集合启动随包发布的 `web`/`headless` 模板;两者都启动 `apps/cli/lib/bin.js`,对照不跨载体。fixture 根目录是一次性目录(mkdtemp);其下的任何内容都不回流仓库。

## 场景与输出

`idle-empty` 把 web profile 启动进一个全新 home,等待就绪 URL、静置,然后采样一个稳态窗口。`idle-corpus` 在播种了 1,000 个 Session 的 home 上重复上述过程,所有历史正文保持未打开,记录的是计划的"语料之上空闲"属性,而非打开历史的路径。`adopt` 以 `--session-id` 固定到播种的 ~11.6k 事件 Session、任务为 `continue` 地运行 headless;播种时会改写该 Session 的头部帧,把记录的 cwd 指向该集合的 workspace(运行器拒绝 cwd 不匹配的采用),事件正文字节保持共享。在没有模型凭据时两个产品都必须显式地让模型调用失败(gh:`NO_ADAPTER`;dsh:无密钥)并退出,因此被度量的路径是 Session 装载直到该失败为止。十分钟内未退出的场景会被杀死并如实记录。`boot-cycles`(通过 `--cycles N` 选开)跑 N 轮"启动→就绪→静置→杀死",只报告启动时长与稳态 PSS 的稳定性——它不是进程内泄漏证据,后者需要一个驱动历史开合的客户端。

每次 `run` 产出 `memory.csv`(逐 tick 逐 pid 行)、`scenarios.json`(汇总、逐 tick 树总量、退出码、启动时长、采样驱动自身 CPU)与 `summary.md`(表格)。采样驱动自身的 CPU 按场景报告,让它的开销与其产出的数字并排可见。

计划中提到的 ZCode 基线不由本驱动运行:构建固定的 ZCode 修订需要 Node ≥ 24,本机未安装。将其记录为"未运行"并注明该原因与解锁步骤(安装 Node 24);不得替换成其他修订。
