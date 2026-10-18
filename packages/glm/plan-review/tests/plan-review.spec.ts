/**
 * Real-composition tests for gh-plan-review: the full agent loop with a
 * scripted mock model drives the REAL upstream exit tool through the REAL
 * user-questions service, and this plugin's ledger — revision events, the
 * deterministic plan file, the never-clobber write, and the X05 replay
 * guard — is asserted against the resulting session log and filesystem.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import GhPlanReviewService, {
  planReviewProjectionDefinition,
  resolveConfig,
  sanitizeSessionId,
  sha256Text,
  type GhPlanReviewUnitState,
} from '../src/index.ts'

const PLAN_CONFIG = { section: 'Test plan mode instructions.' }

/** What the scripted reviewer does with the plan-review question. */
type Answer
  = | { kind: 'approve' }
    | { kind: 'keep' }
    | { kind: 'keep-feedback'; text: string }
    | { kind: 'dismiss' }

const tests: { ctx: Context; dir: string }[] = []
afterEach(async () => {
  for (const { ctx, dir } of tests.splice(0)) {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Compose every real service around the plugin; only the model is scripted. */
async function harness(adapter: MockAdapter, script: readonly Answer[]): Promise<{ ctx: Context; dir: string }> {
  const ctx = new Context()
  const dir = mkdtempSync(join(tmpdir(), 'gh-plan-review-'))
  const pending = [...script]
  tests.push({ ctx, dir })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PlanModeController, PLAN_CONFIG)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(GhPlanReviewService)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.on('user-questions/request', (request, next) => {
    const question = request.questions.find(item => item.intent?.kind === 'plan-review')
    if (question?.intent?.kind !== 'plan-review') return next()
    const answer = pending.shift()
    if (answer === undefined) throw new Error('the script has no answer left for a plan review')
    if (answer.kind === 'dismiss') {
      return Promise.reject(new UserQuestionError('the user dismissed the plan review', 'ASK_CANCELLED'))
    }
    if (answer.kind === 'approve') {
      return Promise.resolve({ answers: [{ id: question.id, selected: [question.intent.approve] }] })
    }
    const decline = question.options?.find(option => option.label !== question.intent?.approve)?.label ?? 'Keep planning'
    return Promise.resolve({
      answers: [{
        id: question.id,
        selected: [decline],
        ...(answer.kind === 'keep-feedback' ? { custom: answer.text } : {}),
      }],
    })
  })
  return { ctx, dir }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function planAgent(ctx: Context, dir: string, id: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd: dir })
  ctx.planMode.set(agent, true)
  return agent
}

async function runTurn(ctx: Context, agent: Agent, prompt: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
}

function eventsOf(agent: Agent, type: string): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type === type)
}

function planPathFor(dir: string, id: string): string {
  return join(dir, '.glm', 'plans', `plan-${sanitizeSessionId(id)}.md`)
}

/** Indexed access that fails loudly instead of folding undefined into an assertion. */
function only<T>(values: readonly T[], index = 0): T {
  const value = values[index]
  if (value === undefined) throw new Error(`expected entry ${index} among ${values.length}`)
  return value
}

const PLAN_A = '# Ship the ledger\n\n1. Add the fold\n2. Write the file'
const PLAN_B = '# Ship the ledger v2\n\n1. Add the fold\n2. Write the file\n3. Test the fold'
const PLAN_C = '# Ship the ledger v3\n\nRewritten end to end'

describe('gh-plan-review full-loop composition', () => {
  it('an approval writes the exact approved text, records both events, and exits plan mode', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'exit_plan_mode', { plan: PLAN_A }),
      textResponse('Carrying out the approved plan.'),
    ])
    const { ctx, dir } = await harness(adapter, [{ kind: 'approve' }])
    const agent = await planAgent(ctx, dir, 'approve-1')
    await runTurn(ctx, agent, 'plan the ledger work')

    const submitted = eventsOf(agent, 'gh-plan/submitted')
    const approved = eventsOf(agent, 'gh-plan/approved')
    expect(submitted).toHaveLength(1)
    expect(only(submitted).data).toEqual({ revision: 1, planPath: planPathFor(dir, 'approve-1'), planSha256: sha256Text(PLAN_A) })
    expect(approved).toHaveLength(1)
    expect(only(approved).data).toEqual({
      revision: 1, planPath: planPathFor(dir, 'approve-1'), planSha256: sha256Text(PLAN_A), fileWritten: true,
    })
    expect(readFileSync(planPathFor(dir, 'approve-1'), 'utf8')).toBe(PLAN_A)
    expect(ctx.sessionProjections.stateOf(agent.session, 'plan')?.active).toBe(false)
    expect(ctx.ghPlanReview.describe(agent)).toEqual({
      revision: 1, approvedRevision: 1, planPath: planPathFor(dir, 'approve-1'),
    })
  })

  it('keep-planning with feedback records the annotation and stays in plan mode without a file', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'exit_plan_mode', { plan: PLAN_A }),
      textResponse('Revising the plan.'),
    ])
    const { ctx, dir } = await harness(adapter, [{ kind: 'keep-feedback', text: 'Add a rollback step' }])
    const agent = await planAgent(ctx, dir, 'keep-1')
    await runTurn(ctx, agent, 'plan the ledger work')

    const rejected = eventsOf(agent, 'gh-plan/rejected')
    expect(rejected).toHaveLength(1)
    expect(only(rejected).data).toEqual({ revision: 1, outcome: 'keep-planning', feedback: 'Add a rollback step' })
    expect(eventsOf(agent, 'gh-plan/approved')).toHaveLength(0)
    expect(existsSync(planPathFor(dir, 'keep-1'))).toBe(false)
    expect(ctx.sessionProjections.stateOf(agent.session, 'plan')?.active).toBe(true)
  })

  it('a dismissed review concludes the turn and records the dismissal', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'exit_plan_mode', { plan: PLAN_A }),
    ])
    const { ctx, dir } = await harness(adapter, [{ kind: 'dismiss' }])
    const agent = await planAgent(ctx, dir, 'dismiss-1')
    await runTurn(ctx, agent, 'plan the ledger work')

    const rejected = eventsOf(agent, 'gh-plan/rejected')
    expect(rejected).toHaveLength(1)
    expect(only(rejected).data).toEqual({ revision: 1, outcome: 'dismissed', feedback: null })
    expect(eventsOf(agent, 'gh-plan/approved')).toHaveLength(0)
    expect(existsSync(planPathFor(dir, 'dismiss-1'))).toBe(false)
    expect(ctx.sessionProjections.stateOf(agent.session, 'plan')?.active).toBe(true)
  })

  it('an approval never clobbers user edits, then writes again once the file is back in sync', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'exit_plan_mode', { plan: PLAN_A }),
      textResponse('Carrying out the approved plan.'),
      toolCallResponse('call-2', 'exit_plan_mode', { plan: PLAN_B }),
      textResponse('Carrying out the revised plan.'),
      toolCallResponse('call-3', 'exit_plan_mode', { plan: PLAN_C }),
      textResponse('Carrying out the final plan.'),
    ])
    const { ctx, dir } = await harness(adapter, [{ kind: 'approve' }, { kind: 'approve' }, { kind: 'approve' }])
    const agent = await planAgent(ctx, dir, 'clobber-1')
    await runTurn(ctx, agent, 'plan the ledger work')
    expect(readFileSync(planPathFor(dir, 'clobber-1'), 'utf8')).toBe(PLAN_A)

    // The user edits the plan file between reviews; their text wins over any
    // later approval whose base the file no longer matches.
    const userEdit = '# User rewrite\n\nMy own steps'
    writeFileSync(planPathFor(dir, 'clobber-1'), userEdit, 'utf8')
    ctx.planMode.set(agent, true)
    await runTurn(ctx, agent, 'plan again')
    expect(readFileSync(planPathFor(dir, 'clobber-1'), 'utf8')).toBe(userEdit)
    const secondApproved = only(eventsOf(agent, 'gh-plan/approved'), 1)
    expect(secondApproved.data).toMatchObject({ revision: 2, fileWritten: false })

    // With the file back at the session's own content, a new approval writes.
    writeFileSync(planPathFor(dir, 'clobber-1'), PLAN_A, 'utf8')
    ctx.planMode.set(agent, true)
    await runTurn(ctx, agent, 'plan once more')
    expect(readFileSync(planPathFor(dir, 'clobber-1'), 'utf8')).toBe(PLAN_C)
    expect(only(eventsOf(agent, 'gh-plan/approved'), 2).data).toMatchObject({ revision: 3, fileWritten: true })
    expect(ctx.ghPlanReview.describe(agent)).toMatchObject({ revision: 3, approvedRevision: 3 })
  })

  it('revisions advance monotonically across a rejection and a later approval', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'exit_plan_mode', { plan: PLAN_A }),
      textResponse('Revising.'),
      toolCallResponse('call-2', 'exit_plan_mode', { plan: PLAN_B }),
      textResponse('Carrying out the plan.'),
    ])
    const { ctx, dir } = await harness(adapter, [{ kind: 'keep' }, { kind: 'approve' }])
    const agent = await planAgent(ctx, dir, 'mono-1')
    await runTurn(ctx, agent, 'plan the work')
    expect(only(eventsOf(agent, 'gh-plan/rejected')).data).toMatchObject({ revision: 1 })

    ctx.planMode.set(agent, true)
    await runTurn(ctx, agent, 'try again')
    const submitted = eventsOf(agent, 'gh-plan/submitted')
    expect(submitted.map(event => (event.data as { revision: number }).revision)).toEqual([1, 2])
    expect(only(eventsOf(agent, 'gh-plan/approved')).data).toMatchObject({ revision: 2 })
    expect(ctx.ghPlanReview.describe(agent)).toMatchObject({ revision: 2, approvedRevision: 2 })
  })

  it('an exit call that never reaches the review leaves no ledger events and no file', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'exit_plan_mode', { plan: PLAN_A }),
      textResponse('Recovering from the misuse.'),
    ])
    const { ctx, dir } = await harness(adapter, [{ kind: 'approve' }])
    const agent = await ctx.agentLoop.create(
      SessionId('never-reviewed'), { provider: 'mock', model: 'mock' }, { cwd: dir },
    )
    // Plan mode is off: the tool fails its own validation before any review.
    await runTurn(ctx, agent, 'plan without plan mode')
    expect(eventsOf(agent, 'gh-plan/submitted')).toHaveLength(0)
    expect(eventsOf(agent, 'gh-plan/approved')).toHaveLength(0)
    expect(eventsOf(agent, 'gh-plan/rejected')).toHaveLength(0)
    expect(existsSync(planPathFor(dir, 'never-reviewed'))).toBe(false)
  })

  it('a session without a workspace cwd records revisions with a null plan path and writes nothing', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'exit_plan_mode', { plan: PLAN_A }),
      textResponse('Carrying out the plan.'),
    ])
    const { ctx, dir } = await harness(adapter, [{ kind: 'approve' }])
    const agent = await ctx.agentLoop.create(SessionId('no-cwd'), { provider: 'mock', model: 'mock' })
    ctx.planMode.set(agent, true)
    await runTurn(ctx, agent, 'plan the work')
    expect(only(eventsOf(agent, 'gh-plan/submitted')).data).toMatchObject({ revision: 1, planPath: null })
    expect(only(eventsOf(agent, 'gh-plan/approved')).data).toMatchObject({ revision: 1, planPath: null, fileWritten: false })
    expect(existsSync(join(dir, '.glm'))).toBe(false)
  })
})

describe('gh-plan-review fold invariants (X05 late-result guard)', () => {
  type Fold = { type: string; data: unknown }

  const fold = (events: readonly Fold[]): GhPlanReviewUnitState => {
    let state: GhPlanReviewUnitState = planReviewProjectionDefinition.init()
    for (const event of events) state = planReviewProjectionDefinition.apply(state, event)
    return state
  }

  const submitted = (revision: number): Fold => ({ type: 'gh-plan/submitted', data: { revision, planPath: '/w/plan-x.md', planSha256: `sha-${revision}` } })
  const approved = (revision: number, fileWritten = true): Fold => ({
    type: 'gh-plan/approved', data: { revision, planPath: '/w/plan-x.md', planSha256: `sha-${revision}`, fileWritten },
  })

  it('a replayed approval for an older revision updates nothing', () => {
    const state = fold([submitted(1), approved(1), submitted(2), approved(2), approved(1)])
    expect(state.approvedRevision).toBe(2)
    expect(state.writtenSha256).toBe('sha-2')
    expect(state.nextRevision).toBe(3)
  })

  it('an approval naming an unknown future revision is ignored, a degraded write keeps the prior digest', () => {
    const state = fold([submitted(1), approved(1), approved(7)])
    expect(state.approvedRevision).toBe(1)
    const degraded = fold([submitted(1), approved(1), submitted(2), approved(2, false)])
    expect(degraded.writtenSha256).toBe('sha-1')
    expect(degraded.approvedRevision).toBe(2)
  })

  it('the empty log folds to the no-history view', () => {
    const state = fold([])
    expect(state).toEqual({ nextRevision: 1, approvedRevision: null, writtenSha256: null, planPath: null })
  })
})

describe('gh-plan-review pure helpers', () => {
  it('sanitizes session ids to a filename-safe segment', () => {
    expect(sanitizeSessionId('plan abc/123:x')).toBe('plan-abc-123-x')
    expect(sanitizeSessionId('--all--unsafe--$-')).toBe('all--unsafe')
    expect(sanitizeSessionId('$$$')).toBe('session')
  })

  it('rejects plansDir that is absolute, escapes, backspaces, or carries unknown keys', () => {
    expect(() => resolveConfig({ plansDir: '/etc' })).toThrow(/relative/)
    expect(() => resolveConfig({ plansDir: '../plans' })).toThrow(/relative/)
    expect(() => resolveConfig({ plansDir: 'plans\\x' })).toThrow(/relative/)
    expect(() => resolveConfig({ plansDir: '' })).toThrow(/non-empty/)
    expect(() => resolveConfig({ plansDir: 'plans', extra: 1 } as never)).toThrow(/unknown key/)
    expect(resolveConfig({ plansDir: '.glm/plans' })).toEqual({ plansDir: '.glm/plans' })
  })
})
