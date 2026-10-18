/**
 * Real-composition tests for gh-permissions: the durable mode fold (with
 * legacy migration), the plan gate across all three modes, guarded's
 * dangerous-rule confirmation through the real approval waterfall, build's
 * read-only proofs and rule table, plus the pure shell-analysis grammar.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import GhPermissionService, { normalizeGhPermissionMode, type GhPermissionMode } from '../src/index.ts'

/** Mutable rule input accepted by the plugin config schema. */
interface RuleInput { tool: string; subject?: string }
import { isReadOnlyPosixCommand, matchDangerousText } from '../src/analysis.ts'

const tests: Context[] = []
afterEach(async () => {
  await Promise.all(tests.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface HarnessOptions {
  mode?: GhPermissionMode
  rules?: { deny?: RuleInput[]; ask?: RuleInput[]; allow?: RuleInput[] }
  answerer?: ApprovalOutcome
}

/** Compose the real services the gate runs inside; only the model is absent. */
interface Answerer {
  outcome: ApprovalOutcome
  asked: { reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } }[]
}

async function harness(options: HarnessOptions = {}): Promise<{ ctx: Context; answerer: Answerer }> {
  const ctx = new Context()
  tests.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(PlanModeController, { section: 'Test plan instructions.' })
  await ctx.plugin(ApprovalService)
  // Raw input: the volatile schema wraps `defaultMode` into its reference;
  // omitted optionals stay absent for exactOptionalPropertyTypes.
  await ctx.plugin(GhPermissionService, {
    ...(options.mode === undefined ? {} : { defaultMode: options.mode }),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  })
  const answerer: Answerer = { outcome: options.answerer ?? 'unavailable', asked: [] }
  ctx.on('approval/request', (req) => {
    answerer.asked.push({
      ...(req.reason === undefined ? {} : { reason: req.reason }),
      ...(req.displayReason === undefined ? {} : { displayReason: req.displayReason }),
    })
    return Promise.resolve(answerer.outcome)
  })
  for (const [name, parameters] of [
    ['read', { file_path: { type: 'string', required: true } }],
    ['write', { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } }],
    ['bash', { command: { type: 'string', required: true }, description: { type: 'string', required: true } }],
    ['deploy', { target: { type: 'string', required: true } }],
    ['subagent', { prompt: { type: 'string', required: true } }],
    ['subagent_fork', { prompt: { type: 'string', required: true } }],
    ['send_message', { prompt: { type: 'string', required: true } }],
  ] as const) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `test tool ${name}`,
      parameters,
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
  return { ctx, answerer }
}

/** Minimal agent whose narration delivery is recorded; the gate only needs session + inject. */
function agentFor(ctx: Context, id = 'session-1'): Agent & { injected: UserMessage[] } {
  const session = ctx.sessions.create(SessionId(id))
  const agent = {
    id: session.id,
    session,
    ctx: ctx.extend(),
    options: {},
    status: 'idle',
    inbox: undefined as never,
    send() {},
    followup() {},
    steer() {},
    inject(_message: UserMessage) {},
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: operation => operation(new AbortController().signal),
    injected: [] as UserMessage[],
  } as Agent & { injected: UserMessage[] }
  agent.inject = (message: UserMessage) => {
    agent.injected.push(message)
  }
  return agent
}

let counter = 0
async function call(ctx: Context, agent: Agent, name: string, args: unknown) {
  counter += 1
  return await ctx.tools.execute({
    callId: ToolCallId(`call-${counter}`),
    signal: new AbortController().signal,
    name,
    arguments: args,
    agent,
  })
}

/** The first text block of one result, the common assertion surface here. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

/** Seed an open turn so approval asks satisfy their enclosure precondition. */
function openTurn(agent: Agent): void {
  agent.session.append('turn/start', { turn: 1 })
}

describe('shell analysis: dangerous grammar', () => {
  type Case = readonly [string, 'matched' | 'notMatched' | 'unsupported', string]
  const cases: readonly Case[] = [
    ['rm -rf /tmp/x', 'matched', 'remove-critical-path'],
    ['rm -r /tmp/x', 'matched', 'remove-critical-path'],
    ['rm file.txt', 'notMatched', ''],
    ['rm one two', 'matched', 'remove-critical-path'],
    ['rm *.log', 'matched', 'remove-critical-path'],
    ['rm -i file.txt', 'notMatched', ''],
    ['git reset --hard', 'matched', 'git-reset-hard'],
    ['git reset --soft HEAD~1', 'notMatched', ''],
    ['git push --force origin main', 'matched', 'git-push-force'],
    ['git push origin main', 'notMatched', ''],
    ['git -C /repo clean -fd', 'matched', 'git-clean-force'],
    ['git checkout -- .', 'matched', 'git-discard-tree'],
    ['git checkout -b feature', 'notMatched', ''],
    ['git stash clear', 'matched', 'git-stash-clear'],
    ['git status', 'unsupported', ''],
    ['find . -delete', 'matched', 'find-delete'],
    ['find . -name "*.ts"', 'notMatched', ''],
    ['find . -exec rm -rf {} \\;', 'matched', 'remove-critical-path'],
    ['find . -exec echo {} +', 'notMatched', ''],
    ['dd if=a of=b', 'matched', 'system-storage'],
    ['mkfs.ext4 /dev/sda1', 'matched', 'system-storage'],
    ['mount', 'notMatched', ''],
    ['rsync -a --delete src/ dst/', 'matched', 'rsync-delete'],
    ['rsync -a src/ dst/', 'notMatched', ''],
    ['rsync --delete --dry-run src/ dst/', 'notMatched', ''],
    ['sudo rm -rf /tmp/x', 'matched', 'remove-critical-path'],
    ['echo $(rm -rf /tmp/x)', 'matched', 'remove-critical-path'],
    ['echo $(ls)', 'notMatched', ''],
    ['bash -c \'rm -rf /tmp/x\'', 'matched', 'remove-critical-path'],
    ['cat <<\'EOF\'\nrm -rf /workspace\nEOF', 'notMatched', ''],
    ['if true; then rm -rf /tmp/x; fi', 'matched', 'remove-critical-path'],
    ['unfamiliar-tool --wipe everything', 'notMatched', ''],
  ]

  it.each(cases)('%s → %s', (command: string, status: string, ruleId: string) => {
    const match = matchDangerousText(command)
    expect(match.status).toBe(status)
    if (ruleId !== '') expect(match).toMatchObject({ ruleId })
  })

  it('marks unparsed constructs unsupported rather than safe', () => {
    expect(matchDangerousText('weird ( subshell ) thing').status).toBe('unsupported')
    expect(matchDangerousText('cmd &').status).toBe('unsupported')
    expect(matchDangerousText('\'unclosed quote rm -rf x').status).toBe('unsupported')
  })
})

const mutatingCommands = [
  'sort -o result.txt input.txt',
  'sort --out=result.txt input.txt',
  "sed -n '1w result.txt' input.txt",
  'sed --sandbox $FLAGS s/a/b/ input.txt',
  'find . -fprint result.txt',
  'find . -exec touch result.txt \\;',
  'rg --pre ./preprocessor needle input.txt',
  'git diff --output=result.txt',
  "env -S 'touch result.txt'",
  'uniq input.txt result.txt',
  'yq -i . file.yml',
  'tree -o result.txt',
  'time -o result.txt cat input.txt',
  'echo $(touch result.txt)',
  'cat `touch result.txt`',
  'git -c core.pager=./helper --paginate diff',
]

describe('shell analysis: read-only classification', () => {
  type Case = readonly [string, boolean]
  const cases: readonly Case[] = [
    ['ls -la /tmp', true],
    ['cat a.txt b.txt | grep -i pattern', true],
    ['grep -r needle .', true],
    ['echo hi > out.txt', false],
    ['sed -i s/a/b/ file.txt', false],
    ['sed -n 5p file.txt', false],
    ['sed --sandbox -n 5p file.txt', true],
    ['sort input.txt', true],
    ['uniq -c input.txt', true],
    ['rg -n needle .', true],
    ['tree -L 2', true],
    ['git status', true],
    ['git branch new-name', false],
    ['git push', false],
    ['npm install', false],
    ['cat $HOME/notes.txt', true],
    ['find . -name "*.ts"', true],
    ['rm file.txt', false],
    ['curl https://example.com', false],
  ]

  it.each(cases)('%s → read-only %s', (command, expected) => {
    expect(isReadOnlyPosixCommand(command)).toBe(expected)
  })

  it.each(mutatingCommands)('withholds a read-only claim for %s', (command) => {
    expect(isReadOnlyPosixCommand(command)).toBe(false)
  })
})

describe('mode selection', () => {
  it('defaults new sessions to build and never inherits another session', async () => {
    const { ctx } = await harness()
    const first = agentFor(ctx, 'first')
    const second = agentFor(ctx, 'second')
    expect(ctx.ghPermissions.get(first).mode).toBe('build')
    ctx.ghPermissions.set(first, 'yolo')
    expect(ctx.ghPermissions.get(first).mode).toBe('yolo')
    expect(ctx.ghPermissions.get(second).mode).toBe('build')
  })

  it('records the switch durably and narrates it to the model', async () => {
    const { ctx } = await harness()
    const agent = agentFor(ctx)
    ctx.ghPermissions.set(agent, 'guarded')
    const events = agent.session.snapshotEvents().filter(event => event.type === 'permission/mode')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ data: { mode: 'guarded' } })
    expect(agent.injected).toHaveLength(1)
    expect(textOf({ content: agent.injected[0]?.content ?? [] })).toContain('changed from "build" to "guarded"')
  })

  it('migrates legacy selections instead of erroring or resurrecting the old menu', async () => {
    const { ctx } = await harness()
    const agent = agentFor(ctx)
    agent.session.append('permission/preset', { preset: 'danger-full-access' })
    expect(ctx.ghPermissions.get(agent).mode).toBe('yolo')
    // The casts stage values only a foreign or imported log could carry.
    agent.session.append('permission/mode', { mode: 'workspace-write' as never })
    expect(ctx.ghPermissions.get(agent).mode).toBe('guarded')
    agent.session.append('permission/mode', { mode: 'edit' as never })
    expect(ctx.ghPermissions.get(agent).mode).toBe('build')
  })

  it('normalizes unknown values to the composition default', () => {
    expect(normalizeGhPermissionMode('yolo')).toBe('yolo')
    expect(normalizeGhPermissionMode('edit')).toBe('build')
    expect(normalizeGhPermissionMode('nonsense')).toBeUndefined()
    expect(normalizeGhPermissionMode(null)).toBeUndefined()
  })

  it('states the effective mode in the runtime prompt context per session', async () => {
    const { ctx } = await harness()
    const agent = agentFor(ctx)
    const build = await ctx.systemPrompt.assemble({ agent })
    const contextOf = (assembly: typeof build) => assembly.contexts.find(entry => entry.name === 'glm:permission-mode')
    expect(contextOf(build)?.text).toContain('confirm before changes')
    ctx.ghPermissions.set(agent, 'yolo')
    const yolo = await ctx.systemPrompt.assemble({ agent })
    expect(contextOf(yolo)?.text).toContain('full access')
    const other = agentFor(ctx, 'other-session')
    const unaffected = await ctx.systemPrompt.assemble({ agent: other })
    expect(contextOf(unaffected)?.text).toContain('confirm before changes')
  })
})

describe('executor gate', () => {
  it('build: read tools run directly and proven read-only commands run', async () => {
    const { ctx } = await harness()
    const agent = agentFor(ctx)
    expect((await call(ctx, agent, 'read', { file_path: '/tmp/a' })).isError).toBe(false)
    expect((await call(ctx, agent, 'bash', { command: 'ls -la /tmp', description: 'list' })).isError).toBe(false)
  })

  it('build: file edits ask and fail closed without an answerer', async () => {
    const { ctx } = await harness()
    const agent = agentFor(ctx)
    openTurn(agent)
    const result = await call(ctx, agent, 'write', { file_path: '/tmp/a', content: 'x' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no approval channel is available')
  })

  it('build: an approved edit runs exactly after the user allows it once', async () => {
    const { ctx, answerer } = await harness({ answerer: 'allowed-once' })
    const agent = agentFor(ctx)
    openTurn(agent)
    expect((await call(ctx, agent, 'write', { file_path: '/tmp/a', content: 'x' })).isError).toBe(false)
    // The grant is per execution: the next write asks again and fails closed.
    answerer.outcome = 'rejected'
    const second = await call(ctx, agent, 'write', { file_path: '/tmp/a', content: 'y' })
    expect(second.isError).toBe(true)
    expect(textOf(second)).toContain('the user rejected')
  })

  it('build: unparsed or side-effecting commands ask instead of auto-running', async () => {
    const { ctx } = await harness({ answerer: 'rejected' })
    const agent = agentFor(ctx)
    openTurn(agent)
    const unknown = await call(ctx, agent, 'deploy', { target: 'prod' })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toContain('the user rejected')
    const build = await call(ctx, agent, 'bash', { command: 'npm install', description: 'install deps' })
    expect(build.isError).toBe(true)
    expect(textOf(build)).toContain('the user rejected')
  })

  it.each(mutatingCommands)('build asks and Plan denies before dispatch: %s', async (command) => {
    const { ctx, answerer } = await harness({ answerer: 'rejected' })
    const agent = agentFor(ctx)
    openTurn(agent)
    const result = await call(ctx, agent, 'bash', { command, description: 'review regression' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('ran bash')
    expect(answerer.asked).toHaveLength(1)
    agent.session.append('plan/mode', { active: true })
    const planned = await call(ctx, agent, 'bash', { command, description: 'review regression' })
    expect(planned.isError).toBe(true)
    expect(textOf(planned)).toContain('Plan mode restricts execution')
    expect(answerer.asked).toHaveLength(1)
  })

  it.each(['subagent', 'subagent_fork', 'send_message'])('Plan denies changes to another agent via %s', async (name) => {
    const { ctx } = await harness({ mode: 'yolo' })
    const agent = agentFor(ctx)
    agent.session.append('plan/mode', { active: true })
    const result = await call(ctx, agent, name, { prompt: 'edit a file' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Plan mode restricts execution')
  })

  it('yolo: general tools run directly, but the plan restriction still denies writes', async () => {
    const { ctx } = await harness({ mode: 'yolo' })
    const agent = agentFor(ctx)
    expect((await call(ctx, agent, 'write', { file_path: '/tmp/a', content: 'x' })).isError).toBe(false)
    expect((await call(ctx, agent, 'bash', { command: 'npm install', description: 'install' })).isError).toBe(false)
    agent.session.append('plan/mode', { active: true })
    const denied = await call(ctx, agent, 'write', { file_path: '/tmp/a', content: 'x' })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('Plan mode restricts execution to read-only tools')
  })

  it('guarded: ordinary commands run without confirmation; a dangerous match asks once', async () => {
    const { ctx } = await harness({ mode: 'guarded', answerer: 'allowed-once' })
    const agent = agentFor(ctx)
    openTurn(agent)
    expect((await call(ctx, agent, 'bash', { command: 'git status', description: 'status' })).isError).toBe(false)
    expect((await call(ctx, agent, 'write', { file_path: '/tmp/a', content: 'x' })).isError).toBe(false)
    const dangerous = await call(ctx, agent, 'bash', { command: 'rm -rf /tmp/x', description: 'remove' })
    expect(dangerous.isError).toBe(false)
    const audit = agent.session.snapshotEvents().filter(event => event.type === 'approval/asked')
    expect(audit).toHaveLength(1)
  })

  it('guarded: a rejected dangerous match denies with the matched rule', async () => {
    const { ctx } = await harness({ mode: 'guarded', answerer: 'rejected' })
    const agent = agentFor(ctx)
    openTurn(agent)
    const result = await call(ctx, agent, 'bash', { command: 'rm -rf /tmp/x', description: 'remove' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('the user rejected')
  })

  it('guarded: a dangerous command hidden in a substitution asks too', async () => {
    const { ctx } = await harness({ mode: 'guarded', answerer: 'rejected' })
    const agent = agentFor(ctx)
    openTurn(agent)
    const result = await call(ctx, agent, 'bash', { command: 'echo $(rm -rf /tmp/x)', description: 'echo' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('the user rejected')
  })

  it('plan: reads and proven read-only commands run; mutations are denied in every mode', async () => {
    for (const mode of ['build', 'guarded', 'yolo'] as const) {
      const { ctx } = await harness({ mode })
      const agent = agentFor(ctx)
      agent.session.append('plan/mode', { active: true })
      expect((await call(ctx, agent, 'read', { file_path: '/tmp/a' })).isError).toBe(false)
      expect((await call(ctx, agent, 'bash', { command: 'ls /tmp', description: 'list' })).isError).toBe(false)
      const denied = await call(ctx, agent, 'write', { file_path: '/tmp/a', content: 'x' })
      expect(denied.isError).toBe(true)
      expect(textOf(denied)).toContain('Plan mode restricts execution')
      const shell = await call(ctx, agent, 'bash', { command: 'npm install', description: 'install' })
      expect(shell.isError).toBe(true)
      expect(textOf(shell)).toContain('Plan mode restricts execution')
      await ctx.fiber.dispose()
      tests.pop()
    }
  })

  it('exit_plan_mode only passes the gate while plan is active', async () => {
    const { ctx } = await harness({ mode: 'yolo' })
    const agent = agentFor(ctx)
    const outside = await call(ctx, agent, 'exit_plan_mode', { plan: '# Plan' })
    expect(outside.isError).toBe(true)
    expect(textOf(outside)).toContain('exit_plan_mode can only be used while plan mode is active')
    agent.session.append('plan/mode', { active: true })
    const inside = await call(ctx, agent, 'exit_plan_mode', { plan: '# Plan' })
    // Past the gate the real tool runs and reports its own missing-review failure.
    expect(textOf(inside)).not.toContain('can only be used while plan mode is active')
  })

  it('build: structured rules deny, ask, and allow before the class proofs', async () => {
    const { ctx, answerer } = await harness({
      answerer: 'allowed-once',
      rules: {
        deny: [{ tool: 'bash', subject: 'git push*' }],
        ask: [{ tool: 'bash', subject: 'docker:*' }],
        allow: [{ tool: 'write', subject: '/tmp/*' }],
      },
    })
    const agent = agentFor(ctx)
    openTurn(agent)
    const denied = await call(ctx, agent, 'bash', { command: 'git push origin main', description: 'push' })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('rule denied')
    expect((await call(ctx, agent, 'bash', { command: 'docker: build .', description: 'docker' })).isError).toBe(false)
    // Exact-prefix subjects do not swallow unrelated commands.
    expect((await call(ctx, agent, 'bash', { command: 'docker-compose up', description: 'compose' })).isError).toBe(false)
    expect((await call(ctx, agent, 'write', { file_path: '/tmp/allowed', content: 'x' })).isError).toBe(false)
    answerer.outcome = 'rejected'
    const other = await call(ctx, agent, 'write', { file_path: '/home/x', content: 'x' })
    expect(other.isError).toBe(true)
    expect(textOf(other)).toContain('the user rejected')
  })

  it('yolo and guarded bypass the rule table, matching the ZCode decision order', async () => {
    for (const mode of ['yolo', 'guarded'] as const) {
      const { ctx } = await harness({
        mode,
        rules: { deny: [{ tool: 'write' }] },
      })
      const agent = agentFor(ctx)
      expect((await call(ctx, agent, 'write', { file_path: '/tmp/a', content: 'x' })).isError).toBe(false)
      await ctx.fiber.dispose()
      tests.pop()
    }
  })

  it('asks carry a bilingual display reason for the approval surface', async () => {
    const { ctx, answerer } = await harness({ mode: 'guarded', answerer: 'rejected' })
    const agent = agentFor(ctx)
    openTurn(agent)
    await call(ctx, agent, 'bash', { command: 'rm -rf /tmp/x', description: 'remove' })
    expect(answerer.asked).toHaveLength(1)
    expect(answerer.asked[0]?.reason).toContain('remove-critical-path')
    expect(answerer.asked[0]?.displayReason?.zh).toContain('危险操作规则')
  })
})

describe('approval audit', () => {
  it('pairs asked/decided events on the session for a guarded confirmation', async () => {
    const { ctx } = await harness({ mode: 'guarded', answerer: 'allowed-once' })
    const agent = agentFor(ctx)
    openTurn(agent)
    await call(ctx, agent, 'bash', { command: 'dd if=a of=b', description: 'copy' })
    const audit = agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
    expect(audit.map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(audit[1]).toMatchObject({ data: { outcome: 'allowed-once' } })
  })
})
