/**
 * GH's ZCode-aligned permission modes: 完全访问 (`yolo`), 自主模式
 * (`guarded`), and 变更前确认 (`build`), with Plan kept an independent state
 * read from the shared `plan` session projection (web surfaces mount
 * `@deepseek-ai/dsh-plan-mode` inside per-preset isolates, so the global
 * `planMode` service does not exist there). The service owns the durable
 * `permission/mode` selection per session, narrates switches to the model,
 * states the effective mode in the runtime context, exposes the `/permission`
 * command, and — the enforcement half — decides every tool call in the
 * `tools/pre-execute` waterfall before dispatch:
 *
 * - Plan active (any mode): read-only and user-interaction tools run; every
 *   state change is denied; `exit_plan_mode` works only in plan.
 * - `yolo`: general tools run directly; tool-owned escalation approvals and
 *   plan restrictions still apply.
 * - `guarded`: the `yolo` base plus one confirmation when the structured
 *   dangerous-command grammar matches (`rm` recursive/batch/glob, forced git
 *   history/tree loss, `find -delete`/`-exec`, `dd`/`mkfs` family, rsync
 *   `--delete`, and command-substitution or `shell -c` payloads carrying any
 *   of these). It is not a per-call review model.
 * - `build` (default): proven read-only tools run; file edits, side-effecting
 *   commands, matched dangerous operations, and anything unparsed ask the
 *   user once through the approval chain.
 *
 * The underlying sandbox, path confinement, and network authorization stay
 * with the runtime's public services (`dsh-sandbox-policy`, sandboxing shell
 * executors); the modes are deliberately not a mechanical mapping onto them
 * (plan §6.1). An `ask` that no answerer takes settles as a denial
 * (fail-closed `ctx.approval`), so unattended runs degrade safely.
 *
 * @module @glm-harness/gh-permissions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Volatile } from '@deepseek-ai/cordis'
import type { ZodType } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-plan-mode'
import { isReadOnlyPosixCommand, matchDangerousText, type DangerousMatch } from './analysis.ts'
import type { GhPermissionMode, GhPermissionSelection } from './types.ts'

export type { GhPermissionMode, GhPermissionSelection } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'gh-permissions': { kind: 'gh-permissions' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ghPermissions: GhPermissionService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's GH permission mode from this point on: log-only, whole
     * value replace, last write wins. A log with none folds to the
     * composition default (`build` without configuration).
     */
    'permission/mode': { mode: GhPermissionMode }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest logged GH permission mode and legacy preset migrations. */
    ghPermissions: GhPermissionUnitState
  }
}

/** Every {@link GhPermissionMode}, for validation of untrusted mode strings. */
export const GH_PERMISSION_MODES: readonly GhPermissionMode[] = ['yolo', 'guarded', 'build']

/**
 * Interpretable migration for older selections. ZCode's hidden `edit` and the
 * DSH preset names never appear as switch targets; a session log that still
 * carries them folds to the closest GH mode instead of an error.
 */
export const LEGACY_MODE_ALIASES: Readonly<Record<string, GhPermissionMode>> = {
  edit: 'build',
  'read-only': 'build',
  'workspace-write': 'guarded',
  'danger-full-access': 'yolo',
}

/** One user/deployment rule: a tool plus an optional argument-subject pattern. */
export interface PermissionRule {
  /** Tool name the rule scopes to. */
  readonly tool: string
  /**
   * Argument subject the rule content-matches: exact, `prefix:*` (bash-style
   * command prefixes), or `*` wildcards. Omitted matches every call of the tool.
   */
  readonly subject?: string
}

/** The rule table: `deny` wins over `ask`, which wins over `allow`. */
export interface PermissionRules {
  /** Calls matching a `deny` rule are refused before dispatch (build mode). */
  readonly deny?: readonly PermissionRule[]
  /** Calls matching an `ask` rule require one approval before running (build mode). */
  readonly ask?: readonly PermissionRule[]
  /** Calls matching an `allow` rule skip the read-only proofs (build mode). */
  readonly allow?: readonly PermissionRule[]
}

/** Plugin config: composition default mode and the rule table. */
export interface Config {
  /** Mode for sessions without a logged selection; `build` when unset. */
  readonly defaultMode: Volatile<GhPermissionMode | undefined>
  /** Structured rules consulted in `build` mode (and recorded for all modes). */
  readonly rules: PermissionRules
}

/** Projection state: the last raw mode value, null before any selection. */
export interface GhPermissionUnitState {
  readonly mode: string | null
}

const unitStateSchema: ZodType<GhPermissionUnitState> = zod.object({
  mode: zod.string().nullable(),
}).strict()

const selectionViewSchema: ZodType<GhPermissionSelection> = zod.object({
  currentValue: zod.enum(['build', 'guarded', 'yolo']),
})

/** One-event fold for the `ghPermissions` projection unit. */
function applyPermissionModeEvent(state: GhPermissionUnitState, event: { type: string; data: unknown }): GhPermissionUnitState {
  if (event.type === 'permission/mode') {
    const mode = (event.data as { mode?: unknown }).mode
    return { mode: typeof mode === 'string' ? mode : null }
  }
  if (event.type === 'permission/preset') {
    // Legacy DSH preset selection: migrate, never resurrect the old menu.
    const preset = (event.data as { preset?: unknown }).preset
    return { mode: typeof preset === 'string' ? preset : null }
  }
  return state
}

/**
 * Normalize one raw mode/preset value. Valid GH modes pass through; legacy
 * aliases migrate; anything else yields undefined (composition default).
 * @param raw - the folded event value.
 * @returns the effective GH mode, or undefined without a usable selection.
 */
export function normalizeGhPermissionMode(raw: string | null | undefined): GhPermissionMode | undefined {
  if (raw === null || raw === undefined) return undefined
  if ((GH_PERMISSION_MODES as readonly string[]).includes(raw)) return raw as GhPermissionMode
  return LEGACY_MODE_ALIASES[raw]
}

/** Tool classes the gate distinguishes; unknown tools classify as `mutate`. */
type GhToolClass = 'read' | 'interact' | 'mutate'

/**
 * Classification of the GH catalog. Session-local state the model needs to
 * organize its own work (todos, questions, delegation, goals reads) follows
 * ZCode's read-only capability sets; everything that changes files, processes,
 * or other agents' execution is `mutate`; unlisted names stay `mutate`.
 */
const TOOL_CLASSES: Readonly<Record<string, GhToolClass>> = {
  read: 'read',
  read_image: 'read',
  grep: 'read',
  glob: 'read',
  working_directory: 'read',
  web_search: 'read',
  web_fetch: 'read',
  skill: 'read',
  list_agents: 'read',
  get_goal: 'read',
  todo_read: 'read',
  todo_write: 'read',
  job_list: 'read',
  job_output: 'read',
  ask_user_question: 'interact',
}

/** The shell tools whose arguments the structured analyzer reads. */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

function classifyTool(name: string): GhToolClass {
  return TOOL_CLASSES[name] ?? 'mutate'
}

/** Argument fields a rule subject can content-match, in priority order. */
const SUBJECT_KEYS = ['command', 'url', 'file_path', 'path', 'pattern', 'patch_text'] as const

/** The one subject string a rule matches against, when the arguments carry one. */
function ruleSubject(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of SUBJECT_KEYS) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** Whether one subject matches one rule content: exact, `prefix:*`, wildcard. */
function matchesRuleContent(subject: string, content: string): boolean {
  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2)
    return subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`)
  }
  if (content.includes('*')) {
    const pattern = new RegExp(`^${content.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    return pattern.test(subject)
  }
  return subject === content
}

/** Whether one rule applies to one call. */
function ruleMatches(rule: PermissionRule, toolName: string, input: unknown): boolean {
  if (rule.tool !== toolName) return false
  if (rule.subject === undefined) return true
  const subject = ruleSubject(input)
  return subject !== undefined && matchesRuleContent(subject, rule.subject)
}

/** Model-facing statement per mode; lives in the runtime context (after history). */
const MODE_SENTENCES: Readonly<Record<GhPermissionMode, string>> = {
  build: 'Permission mode: confirm before changes. Read-only tools run directly; file edits, side-effecting commands, and dangerous operations ask the user before running — report the outcome either way instead of retrying around the confirmation.',
  guarded: 'Permission mode: autonomous. Tools run without confirmation; commands matching a dangerous-operation rule (for example recursive or forced deletion) ask the user once before running.',
  yolo: 'Permission mode: full access. Tools run without permission confirmation; plan-mode restrictions and tool-owned escalation approvals still apply.',
}

/** The exit tool name; its plan gating mirrors ZCode's plan-mode policy. */
const EXIT_PLAN_MODE = 'exit_plan_mode'

/**
 * `ctx.ghPermissions`: the durable mode selection, its narration and prompt
 * statement, the `/permission` command, and the executor-level gate.
 */
export class GhPermissionService extends Service {
  static inject = ['tools', 'systemPrompt', 'sessionProjections']

  static Config = z.object({
    defaultMode: z.union(['build', 'guarded', 'yolo'] as const).volatile(),
    rules: z.object({
      deny: z.array(z.object({ tool: z.string().required(), subject: z.string() })),
      ask: z.array(z.object({ tool: z.string().required(), subject: z.string() })),
      allow: z.array(z.object({ tool: z.string().required(), subject: z.string() })),
    }).default({}),
  })

  private readonly defaultMode: GhPermissionMode
  private readonly rules: PermissionRules

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ghPermissions')

    this.defaultMode = normalizeGhPermissionMode(config.defaultMode.get()) ?? 'build'
    const rules = config.rules
    const unknownRuleKeys = Object.keys(rules).filter(key => !['deny', 'ask', 'allow'].includes(key))
    if (unknownRuleKeys.length > 0) {
      throw new Error(`gh-permissions: unknown rule key(s) ${unknownRuleKeys.join(', ')} — rules are { deny, ask, allow }`)
    }
    this.rules = rules

    ctx.sessionProjections.register({
      key: 'ghPermissions',
      stateVersion: 1,
      stateSchema: unitStateSchema,
      init: () => ({ mode: null }),
      apply: applyPermissionModeEvent,
      wire: {
        viewSchema: selectionViewSchema,
        view: state => ({ currentValue: this.effectiveModeOf(state.mode) }),
      },
    } satisfies ProjectionDefinition<'ghPermissions', GhPermissionUnitState>)

    // The complete current mode travels after retained history (like the
    // approval policy), so a switch never rewrites the cached prompt prefix.
    ctx.systemPrompt.context({
      name: 'glm:permission-mode',
      order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY'),
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        return MODE_SENTENCES[this.effectiveMode(agent.session)]
      },
    })

    // The gate composes AFTER the rest of the chain: observers registered by
    // later plugins (workspace-changes' mutation capture among them) must run
    // even when the gate asks or denies, or every gated write would leave the
    // session without its workspace/changes event. Composition keeps the
    // stricter outcome: a downstream deny/cancel stands, a downstream ask
    // yields only to this gate's deny.
    ctx.on('tools/pre-execute', (exec, next) =>
      next().then((downstream) => {
        const decision = this.gate(exec)
        if (decision === undefined) return downstream
        if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
        if (downstream.kind === 'ask' && decision.kind === 'ask') return downstream
        return decision
      }))

    // The one write path: a session command. The three modes and the legacy
    // aliases resolve identically to the durable fold.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: brandString<CommandDefinitionId>('@glm-harness/gh-permissions'),
        name: 'permission',
        description: 'Switch the GH permission mode (yolo | guarded | build); plan is separate (/plan)',
        input: { hint: '[<mode>]' },
        handler: ({ agent, rawInput }) => {
          const argument = rawInput.trim()
          if (argument === '') {
            const mode = this.effectiveMode(agent.session)
            const plan = this.planActiveOf(agent.session)
            return {
              kind: 'success',
              text: `permission mode: ${mode}${plan ? ' (plan mode active)' : ''} — available: yolo, guarded, build; plan is separate: /plan`,
            }
          }
          const mode = normalizeGhPermissionMode(argument)
          if (mode === undefined) {
            return { kind: 'error', text: `unknown permission mode "${argument}" (available: yolo, guarded, build)` }
          }
          this.set(agent, mode)
          return {
            kind: 'success',
            text: LEGACY_MODE_ALIASES[argument] === mode && argument !== mode
              ? `permission mode: ${mode} (migrated from legacy "${argument}")`
              : `permission mode: ${mode}`,
          }
        },
      })
    })
  }

  /**
   * The session's effective mode: its folded selection (migrated when legacy),
   * else the composition default.
   * @param session - the exact accepted session.
   * @returns the mode every gate decision for this session uses right now.
   */
  effectiveMode(session: Session): GhPermissionMode {
    const state = this.unitState(session)
    return this.effectiveModeOf(state.mode)
  }

  /** Resolve one folded raw value through migration and the default. */
  private effectiveModeOf(raw: string | null): GhPermissionMode {
    return normalizeGhPermissionMode(raw) ?? this.defaultMode
  }

  /**
   * Read one agent's current mode and plan state for display.
   * @param agent - the agent whose session is read.
   * @returns the effective mode and whether plan mode is logged active.
   */
  get(agent: Agent): { mode: GhPermissionMode; plan: boolean } {
    return { mode: this.effectiveMode(agent.session), plan: this.planActiveOf(agent.session) }
  }

  /**
   * Switch one live agent's mode: append the durable selection and narrate the
   * change for the next model step. Switching does not touch an in-flight
   * call — already-dispatched tools keep their decision.
   * @param agent - the live agent whose mode changes.
   * @param mode - the new effective mode.
   */
  set(agent: Agent, mode: GhPermissionMode): void {
    const previous = this.effectiveMode(agent.session)
    if (previous === mode) return
    agent.session.append('permission/mode', { mode })
    agent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `The session permission mode changed from "${previous}" to "${mode}" (changed by the user).`,
      }],
      source: { kind: 'gh-permissions', form: 'notice', summary: `Permission mode changed to ${mode}.` },
    }))
  }

  /** Read the required projection state or fail at the first service access. */
  private unitState(session: Session): GhPermissionUnitState {
    const state = this.ctx.sessionProjections.stateOf(session, 'ghPermissions')
    if (state === undefined) throw new Error('gh-permissions requires the ghPermissions session projection')
    return state
  }

  /**
   * The session's committed plan flag from the shared `plan` projection: the
   * one plan fact every surface publishes, with or without a global planMode
   * service (agent presets mount plan per isolate on web compositions).
   */
  private planActiveOf(session: Session): boolean {
    return this.ctx.sessionProjections.stateOf(session, 'plan')?.active ?? false
  }

  /**
   * The executor decision for one pending call, or undefined to delegate
   * (allow). Denials and confirmations are enforced here, before dispatch —
   * the sandbox and the tool's own escalation approvals stay independent.
   * @param exec - the pending tool call.
   * @returns the decision, or undefined when the gate imposes nothing.
   */
  private gate(exec: ToolExecution): PreToolDecision | undefined {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const mode = this.effectiveMode(agent.session)
    const plan = this.planActiveOf(agent.session)

    if (exec.name === EXIT_PLAN_MODE) {
      return plan
        ? undefined
        : { kind: 'deny', reason: `${EXIT_PLAN_MODE} can only be used while plan mode is active` }
    }
    const toolClass = classifyTool(exec.name)
    if (plan) {
      // ZCode parity: plan allows proven read-only execution — including a
      // shell command the analyzer classified read-only — and denies every
      // state change, in all three modes.
      if (toolClass === 'read' || toolClass === 'interact' || this.provenReadOnlyShell(exec)) return undefined
      return {
        kind: 'deny',
        reason: `Plan mode restricts execution to read-only tools; "${exec.name}" changes state. `
          + 'Present the plan with exit_plan_mode, or leave plan mode (/plan off) before running it.',
      }
    }
    if (mode === 'yolo') return undefined
    if (mode === 'guarded') {
      const dangerous = this.dangerousMatch(exec)
      if (dangerous !== undefined && dangerous.status === 'matched') {
        return {
          kind: 'ask',
          reason: `guarded mode: ${dangerous.ruleId} matched${this.originNote(dangerous)}; the user must approve this execution`,
          displayReason: {
            en: `This command matched the dangerous-operation rule ${dangerous.ruleId}. Approve to run it once.`,
            zh: `该命令命中危险操作规则 ${dangerous.ruleId}。批准后将执行一次。`,
          },
        }
      }
      return undefined
    }
    // build: structured rules first, then the read-only proofs.
    for (const rule of this.rules.deny ?? []) {
      if (ruleMatches(rule, exec.name, exec.arguments)) {
        return { kind: 'deny', reason: `rule denied tool "${exec.name}" (subject: ${rule.subject ?? 'any'})` }
      }
    }
    for (const rule of this.rules.ask ?? []) {
      if (ruleMatches(rule, exec.name, exec.arguments)) {
        return {
          kind: 'ask',
          reason: `a permission rule asks for confirmation before "${exec.name}" runs`,
          displayReason: {
            en: `A permission rule covers this "${exec.name}" call. Approve to run it once.`,
            zh: `一条权限规则覆盖了这次 "${exec.name}" 调用。批准后将执行一次。`,
          },
        }
      }
    }
    for (const rule of this.rules.allow ?? []) {
      if (ruleMatches(rule, exec.name, exec.arguments)) return undefined
    }
    if (toolClass === 'read' || toolClass === 'interact') return undefined
    if (this.provenReadOnlyShell(exec)) return undefined
    return {
      kind: 'ask',
      reason: `build mode: "${exec.name}" changes state (or is not proven read-only); it runs after the user approves`,
      displayReason: {
        en: `Build mode confirms before changes: "${exec.name}" needs your approval to run.`,
        zh: `变更前确认模式：「${exec.name}」需要你批准后才会执行。`,
      },
    }
  }

  /** Run the dangerous grammar over a shell tool's arguments. */
  private dangerousMatch(exec: ToolExecution): DangerousMatch | undefined {
    if (!SHELL_TOOLS.has(exec.name)) return undefined
    const command = shellCommandOf(exec.arguments)
    if (command === undefined) return { status: 'unsupported' }
    // pwsh is a different dialect: never claim a match or safety for it.
    if (exec.name === 'pwsh') return { status: 'unsupported' }
    return matchDangerousText(command)
  }

  /** Whether a shell tool's arguments are proven read-only. */
  private provenReadOnlyShell(exec: ToolExecution): boolean {
    if (!SHELL_TOOLS.has(exec.name)) return false
    const command = shellCommandOf(exec.arguments)
    if (command === undefined || exec.name === 'pwsh') return false
    return isReadOnlyPosixCommand(command)
  }

  /** Where a dangerous rule matched, for the approval reason. */
  private originNote(match: DangerousMatch): string {
    if (match.status !== 'matched') return ''
    if (match.origin === 'expansion') return ' inside a command substitution'
    if (match.origin === 'interpreter-payload') return ' inside a nested shell command'
    return ''
  }
}

/** The `command` argument of one shell tool call, when present and a string. */
function shellCommandOf(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>).command
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export default GhPermissionService
