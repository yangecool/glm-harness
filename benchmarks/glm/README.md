# GH resource baseline

English | [中文](README.zh.md)

[run-gh-baseline.ts](run-gh-baseline.ts) measures the resident-memory cost of GLM Harness against its upstream carrier under identical fixtures and one machine, task GH-002 of the GH plan. It publishes raw numbers only: the MEM budgets themselves are owned by the delivery plan's §10.6, and no verdict is issued here. The primary metric is the PSS sum of the whole process tree ([proc-tree-sampler.ts](proc-tree-sampler.ts)), read from `/proc/<pid>/smaps_rollup` once per second, with RSS, private, and swap recorded alongside; processes that appear or exit between ticks contribute exactly the ticks they were alive for.

## Run

From the repository root with the built CLI in place (`pnpm run build`; the driver refuses to launch the tsx source path):

```sh
corepack pnpm exec tsx benchmarks/glm/run-gh-baseline.ts seed --fixture-root <fresh-dir>
corepack pnpm exec tsx benchmarks/glm/run-gh-baseline.ts run --fixture-root <fresh-dir> --out <dir> \
  [--settle-sec 15] [--measure-sec 60] [--cycles 0] [--sets gh,dsh]
```

`seed` authors the synthetic corpus once through the [session-corpus writer](../session-corpus/synthetic-corpus.ts) — 1,000 Sessions over the 22 measured quantile shapes, no recorded user material — and links the identical bytes into every set's `$DSH_HOME/sessions`. The `gh` set boots the product's `gh-web`/`gh-headless` profiles; `dsh` boots the shipped `web`/`headless` templates; both launch `apps/cli/lib/bin.js` so the comparison never crosses carriers. The fixture root is a throwaway directory the caller creates (mkdtemp); nothing under it feeds the repository.

## Scenarios and outputs

`idle-empty` boots the web profile into a fresh home, waits for the ready URL, settles, then samples a steady window. `idle-corpus` repeats this over the seeded 1,000-Session home with every historical body unopened, which documents the plan's idle-over-corpus property rather than an open-history path. `adopt` runs headless with `--session-id` pinned to the seeded ~11.6k-event Session and the task `continue`; seeding rewrites that one Session's header frame so its recorded cwd is the set's workspace (the runner refuses a cwd mismatch) while the event body bytes stay shared. Without model credentials both products must fail the model call explicitly (gh: `NO_ADAPTER`; dsh: no key) and exit, so the measured path is Session load up to that failure. A scenario that has not exited within ten minutes is killed and recorded as such. `boot-cycles` (opt-in through `--cycles N`) runs N boot→ready→settle→kill rounds and reports boot-time and steady-PSS stability only — it is not in-process leak evidence, which needs a driving client opening and closing history.

Each `run` writes `memory.csv` (per-tick per-pid rows), `scenarios.json` (summaries, raw per-tick tree totals, exit codes, boot times, sampler driver CPU), and `summary.md` (tables). The sampler's own driver CPU is reported per scenario so its cost is visible next to the numbers it produced.

The ZCode baseline the plan also names is not run by this driver: building the pinned ZCode revision requires Node ≥ 24, which this machine does not have installed. Record it as not-run with that reason and the unblock step (install Node 24); do not substitute a different revision.
