/** Locale namespace shared by the GH permission chip and the /permission picker. */
export const GH_PERMISSION_ACCESS_NS = 'gh-permission.access'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mode': '权限模式：{name}',
  'mode.build': '变更前确认',
  'mode.guarded': '自主模式',
  'mode.yolo': '完全访问',
  'description.build': '只读操作直接执行；修改文件、执行有副作用的命令和危险操作前需要确认',
  'description.guarded': '自动推进任务；命中危险操作规则（如递归/强制删除）时询问一次',
  'description.yolo': '直接执行工具调用，不做权限确认；Plan 限制与升级审批仍生效',
  'plan': '计划模式',
  'plan.description': 'Plan 独立于权限模式：激活后仅执行只读工具，改动需先通过计划评审',
  'confirm.title': '确认切换到完全访问？',
  'confirm.description': '完全访问模式下，本会话的工具调用将直接执行，不再逐项确认，包括文件修改、命令执行和敏感操作。仅建议在你信任接下来的任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '切换到完全访问',
  'close': '关闭',
} satisfies Record<string, string>

/** The gh-permission.access namespace key union. */
export type GhPermissionAccessKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'mode': 'Permission mode: {name}',
  'mode.build': 'Confirm before changes',
  'mode.guarded': 'Autonomous',
  'mode.yolo': 'Full access',
  'description.build': 'Read-only operations run directly; file edits, side-effecting commands, and dangerous operations ask first',
  'description.guarded': 'Advances tasks automatically; asks once when a dangerous-operation rule matches (e.g. recursive or forced deletion)',
  'description.yolo': 'Runs tool calls without permission confirmation; plan restrictions and escalation approvals still apply',
  'plan': 'Plan mode',
  'plan.description': 'Plan is independent of the permission mode: while active only read-only tools run, and changes need an approved plan first',
  'confirm.title': 'Switch to full access?',
  'confirm.description': 'In full access mode this session runs tool calls directly without per-item confirmation, including file edits, commands, and sensitive operations. Only use it when you trust the tasks that follow.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Switch to full access',
  'close': 'Close',
} satisfies Record<GhPermissionAccessKey, string>
