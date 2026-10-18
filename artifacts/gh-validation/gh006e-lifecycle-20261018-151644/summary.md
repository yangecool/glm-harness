# GH-006-E 生命周期/版本——真监护验收证据

范围：`@glm-harness/gh-remote-supervisor` 新增 release 生命周期（`src/releases.ts` + CLI 动词）与 `ghRemote/activity` RPC（`@glm-harness/gh-remote-app`）。驱动 scripts/gh-remote-lifecycle-verify.ts：假就绪行运行时覆盖版本机制，真实 gh-remote + 流式 loopback GLM 覆盖 activity 排水。

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| install-sealed | PASS | install 输出 release id，目录含 gh-release.json 清单 |
| install-immutable | PASS | 同 id 二次安装退出 69（immutable） |
| run-from-current-release | PASS | 无显式命令的 run 从 current.json 启动，identity.releaseId=r-alpha |
| update-switches-release | PASS | update→r-beta，pid 更换，指针切换 |
| rollback-returns-previous | PASS | rollback→r-alpha，r-beta 成为回滚目标 |
| gc-keeps-pinned-releases | PASS | 未引用 r-extra 被移除；current、回滚目标、live 钉住全部保留 |
| interrupted-install-diagnosable | PASS | .staging 残留在 status 可见，gc 清除 |
| uninstall-keeps-data | PASS | uninstall 后数据文件仍在（purge 变体在单元覆盖） |
| activity-rpc-idle | PASS | ghRemote/activity 空闲时 runningAgents=0、agents=1 |
| update-drains-activity | PASS | 长任务期间 update 等待 activity 空闲再切换（无 fixture 中止），新 release 上线 |

单元与门禁：remote-supervisor 26 用例（新增 releases.spec 8 例）；typecheck 5/5；oxlint 0 error；closure 0；README 翻译配对门通过。
