# GH 品牌与界面重设计 — 逐页视觉验收记录

运行：2026-10-17，gh005brand-20261017-204500。参考 Grok Harness 的视觉替换方案（`packages/grok/brand` + grok/web 覆盖层 + index.html 直改），在 DSH 插件体系上完成 GLM Harness 全套品牌替换。

## 方案与传承关系

GSH 的做法 = ① web 覆盖层禁用官方品牌行并挂载自有 brand 插件（占 4 个通用品牌槽位）② logo 以 mask 裁切 ③ 标题/favicon 直改 index.html。GH 本卡在同一模式上适配当前基线并按「全套」要求扩展：

- **@glm-harness/gh-brand**（新 bundle 包，packages/glm/brand）：`cordis.patch.yml` 禁用 `ui-brand-official` 并挂载自身；客户端半边占据当前基线实际存在的 3 个品牌槽位（sidebar.brand.mark/name + conversation.hero.brand.mark——本基线 hero 无 name 槽，与 GSH 旧基线差异已适配）；标记为四角火花（currentColor mask，明暗自适应）；字标以 Montserrat 真实文本渲染；HARNESS 徽标沿用壳的「产品+平台」组合语法。
- **GLM 色阶**：运行时级联覆盖 `--dsw-static-deepseek-*` 全色阶 + onboarding 强调色（body / body[data-ds-dark-theme] 双块，后位样式表按文档顺序胜出）——rgb(59,111,255) 品牌蓝为 500 档，明度与被替换色阶对齐以保持暗面色深关系。禁用包即整体还原。
- **插件缝之外**（GSH 先例的最小直改，均零逻辑）：apps/web/index.html 标题+favicon；public/ 下 glm-mark/glm-favicon(+dark)/manifest（GLM Harness/GLMH）；ui-settings-models 欢迎文案、ui-conversation hero 标题（Build with GLM / 与 GLM 共建）、client locale 品牌回退；apps/desktop/src/locale.ts 22 处产品名；welcome-brand.svg 字标资产；update-dialog/mandatory-update 强调色 #4d6bfe→#3b6fff。

## 逐页验收（截图 shots/01-08，visual-report.json 11 项全过）

| 页面 | 判定 | 证据 |
| --- | --- | --- |
| 启动 | pass | 01 启动页帧；标题 GLM Harness；favicon/manifest 200+名称校验 |
| 登录/首次运行 | pass | 02 首启弹窗 GLM 预览说明（判读确认无 DeepSeek 字样） |
| 工作台（空态/侧栏/composer） | pass | 03 火花+Build with GLM；04 侧栏 GLM HARNESS+徽标，DSH Local Build/鲸鱼零残留（自动检查+判读） |
| 设置 | pass | 05 Plugins 页 |
| 安装/更新 | pass-at-renderer-level | 07 更新对话框渲染页（焦点描边 computed rgb(59,111,255)）；mandatory 强调色同 |
| 欢迎（登录前置） | pass-at-asset-level | 08 欢迎字标资产（判读确认 GLM HARNESS） |
| 配色/暗色 | pass | computed 色阶 500/450/onboarding 精确值；06 暗色工作台判读 |

## 边界与移交

- 桌面欢迎窗/更新窗的**运行时**截图：本机无显示器、无 Electron 二进制（apps/desktop 的 electron 依赖只有元数据，postinstall 未下载）——已以渲染页独立加载 + 文案/资产构建级验证补偿，运行时截图随打包桌面构建（E10/发布票）补入同一验收格式。
- 启动器 `dsh` bin 名与控制台前缀保持上游；产品命令命名（glmh）属打包票。
- 启动页平台词标 HARNESS 保留（产品中立，GSH 同样保留）。
- 账号登录页（真登录表单）随 GH-007 账号体系到来；当前登录类表面=首启说明+欢迎窗+设置账号页。

## 门禁

typecheck（host+client aggregate）、lint、build（brand 客户端 bundle 入管线）、check-gh-closure、check-workspace-constraints、verify-translation-pairing（1015 对）全过；受影响包测试 69 文件/1238 项全过（brand 3 项：槽位占据与释放、标记与名称渲染、色阶样式表安装/卸载）。
