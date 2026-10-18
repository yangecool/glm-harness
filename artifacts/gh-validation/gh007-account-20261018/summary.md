# GH-007 账号/PAT 与远端配置 — 验收证据（2026-10-18）

范围：`@glm-harness/gh-account`（OAuth 授权码 + PKCE S256、单飞刷新、按域 epoch、持久 grant）、
`ghProjectToken` 短时 PAT（铸造/缓存/拒绝丢弃/epoch 失效）、`model-glm` PAT 路由与鉴权拒绝懒回调、
`remote-app` 的 `ghAccount/*` RPC 面与 Typert 边界类型。验收驱动
`scripts/gh-account-verify.ts` 以真实监护服务 + 回环 OAuth/PAT/聊天 fixture 走完整用户流。

## 验收矩阵（4/4 通过，acceptance.log / account-verify.json）

| 用例 | 结果 | 事实 |
| --- | --- | --- |
| resident-account-pat-round-trip | PASS | RPC beginLogin→completeLogin 后 status 登入（acct-verify/team, epoch=1），真实回合携带铸造 PAT（mints=2，chat 看到 PAT），回合干净结束 |
| token-hygiene | PASS | 持久 journal 与监护输出不含 access/refresh/PAT 材料（journal hits=[]、log hit=false） |
| pat-rejected-never-reused | PASS | 吊销 PAT 得到 401 与错误回合；下一回合铸造全新 PAT（mints 2→3）干净完成——懒 `onAuthRejection` 只丢弃被拒令牌 |
| logout-explicit-failure | PASS | 登出（epoch 递增）令缓存 PAT 立即失效；下一回合经显式 MISSING_CREDENTIAL 失败，无上游回退 |

## 本轮收敛中发现并修复的两个真实缺陷

1. **驱动缺陷（窗口陈旧判定）**：4 用例共用一个 session，原 `pollSnapshot` 以“窗口内出现任意 turn/end”
   为完成条件，用例 3/4 会立刻命中上一回合的旧 turn/end——既没等被拒回合结束，也让登出用例凭旧错误事件假通过。
   修复为 `awaitNextTurn`：先取基线快照最高 seq，只在新事件切片上判定。
2. **产品缺陷（登出后缓存 PAT 存活）**：登出后未过期的短时 PAT 仍留在缓存并完成回合。
   修复为 epoch 守卫：PAT 缓存记录铸造时账号代数，`resolvePat`/`patFacts` 在代数不一致时立即失效
   （`GhAccountService.epochOf` 访问器）；单元用例“登出即丢缓存 PAT”覆盖。

## 验证命令（runtime/ 下）

```bash
pnpm run build:artifacts                      # tsc + tsdown + Web，全部通过
timeout 420 node --import tsx/esm scripts/gh-account-verify.ts --report artifacts/gh-validation/gh007-account-20261018/account-verify.json
pnpm exec vitest run packages/glm/account packages/glm/model-glm   # 3 files / 57 tests
node --import tsx/esm scripts/check-gh-closure.ts
pnpm run typecheck                            # 5/5
```

## 边界（如实）

- 回环 fixture 充当 OAuth/PAT/聊天端点；真实 BigModel/Z.AI 套餐联调（D01）未运行，端点/客户端身份按
  `GhAccountDomainConfig` 显式配置，真实端点接入前不宣称对齐。
- 账号域仅 `bigmodel`/`zai` 两个域配置来源；团队/个人 project ID 的真实权益校验属服务端行为。
- `remote-app` 的 `ghAccount/*` RPC 面仅供常驻服务内登录流；桌面账号 UI 随 GH-012。
