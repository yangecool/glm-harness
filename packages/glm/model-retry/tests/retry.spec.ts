import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private policy: ResolvedRetryPolicy | undefined

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('retry test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configurePolicy(policy: RetryPolicyConfig | undefined): void {
    this.policy = policy === undefined
      ? undefined
      : resolveRetryPolicy(policy, 'gh retry test provider "mock" retryPolicy')
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.policy
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function failureFinish(error: LlmError): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: error.failure } }]
}

function normalPolicy(overrides: Partial<Extract<RetryPolicyConfig, { mode: 'normal' }>> = {}): RetryPolicyConfig {
  const { backoff, ...policy } = overrides
  return {
    mode: 'normal',
    maxRetries: 2,
    ...policy,
    backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0, ...backoff },
  }
}

type Recorded = { type: string; data: Record<string, unknown> }

/** Every event recorded for one agent's session, in commit order. */
class Recorder {
  readonly events: Recorded[] = []
  private readonly dispose: () => void

  constructor(ctx: Context, agent: Agent) {
    this.dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session) this.events.push(event as Recorded)
    })
  }

  /** Commit-order snapshot filtered to one event type. */
  of(type: string): Recorded[] {
    return this.events.filter(event => event.type === type)
  }

  release(): void {
    this.dispose()
  }
}

async function harness(
  adapter: ScriptedAdapter,
  policy: RetryPolicyConfig | undefined = normalPolicy(),
  internals: retry.RetryInternals = {},
  beforeRetry?: (ctx: Context) => void,
): Promise<{ ctx: Context; retryFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  beforeRetry?.(ctx)
  adapter.configurePolicy(policy)
  const retryFiber = await ctx.plugin(Object.assign((inner: Context) => {
    retry.apply(inner, {}, internals)
  }, { inject: retry.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, retryFiber }
}

function followup(agent: Agent, text = 'go'): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

describe('gh-model-retry', () => {
  it('schedules a bounded retry durably, then recovers the turn', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      failureFinish(new LlmError('busy', 'RATE_LIMIT', { status: 429 })),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, undefined, { random: () => 0.5 }))
    const agent = await context.agentLoop.create(SessionId('retry-recover'), { provider: 'mock', model: 'mock' })
    const recorder = new Recorder(context, agent)
    const idle = agent.whenIdle()

    followup(agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    expect(adapter.requests.length).toBe(2)
    const scheduled = recorder.of('llm/retry')
    expect(scheduled.length).toBe(1)
    expect(scheduled[0]!.data).toMatchObject({ retry: 1, maxRetries: 2, delayMs: 500, provider: 'mock' })
    expect(scheduled[0]!.data.retryId).toEqual(expect.any(String))
    const started = recorder.of('llm/retry-started')
    expect(started.length).toBe(1)
    expect(started[0]!.data).toMatchObject({ retry: 1, retryId: scheduled[0]!.data.retryId })
    recorder.release()
  })

  it('stops at the configured budget and fails the step explicitly', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter(Array.from({ length: 5 }, () =>
      failureFinish(new LlmError('busy', 'RATE_LIMIT', { status: 429 }))))
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-exhaust'), { provider: 'mock', model: 'mock' })
    const recorder = new Recorder(context, agent)
    const idle = agent.whenIdle()

    followup(agent)
    await vi.advanceTimersByTimeAsync(60_000)
    await idle

    // One initial attempt plus exactly maxRetries retries; no retry past the budget.
    expect(adapter.requests.length).toBe(3)
    expect(recorder.of('llm/retry').map(event => event.data.retry)).toEqual([1, 2])
    expect(recorder.of('assistant/attempt').length).toBe(3)
    recorder.release()
  })

  it('does not retry a non-retryable failure code', async () => {
    const adapter = new ScriptedAdapter([
      failureFinish(new LlmError('bad key', 'AUTH', { status: 401 })),
    ])
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-auth'), { provider: 'mock', model: 'mock' })
    const recorder = new Recorder(context, agent)
    const idle = agent.whenIdle()

    followup(agent)
    await idle

    expect(adapter.requests.length).toBe(1)
    expect(recorder.of('llm/retry')).toEqual([])
    recorder.release()
  })

  it('honors a provider retry-after within the policy cap and refuses one beyond it', async () => {
    vi.useFakeTimers()
    const capped = new ScriptedAdapter([
      failureFinish(new LlmError('busy', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 1_500 })),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(capped))
    const agent = await context.agentLoop.create(SessionId('retry-after-ok'), { provider: 'mock', model: 'mock' })
    const recorder = new Recorder(context, agent)
    const idle = agent.whenIdle()

    followup(agent)
    await vi.advanceTimersByTimeAsync(1_500)
    await idle

    expect(recorder.of('llm/retry')[0]!.data.delayMs).toBe(1_500)
    expect(capped.requests.length).toBe(2)
    recorder.release()

    const beyond = new ScriptedAdapter([
      failureFinish(new LlmError('busy', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 60_000 })),
    ])
    ;({ ctx: context } = await harness(beyond))
    const parked = await context.agentLoop.create(SessionId('retry-after-refused'), { provider: 'mock', model: 'mock' })
    const parkedRecorder = new Recorder(context, parked)
    const idleBeyond = parked.whenIdle()

    followup(parked)
    await idleBeyond

    // A hold beyond the cap fails the step instead of parking the session.
    expect(beyond.requests.length).toBe(1)
    expect(parkedRecorder.of('llm/retry')).toEqual([])
    parkedRecorder.release()
  })

  it('refuses an always-mode policy instead of retrying without a budget', async () => {
    const adapter = new ScriptedAdapter([
      failureFinish(new LlmError('down', 'SERVER', { status: 503 })),
    ])
    ;({ ctx: context } = await harness(adapter, { mode: 'always', backoff: { initialDelayMs: 1, jitterRatio: 0 } }))
    const agent = await context.agentLoop.create(SessionId('retry-always'), { provider: 'mock', model: 'mock' })
    const recorder = new Recorder(context, agent)
    const idle = agent.whenIdle()

    followup(agent)
    await idle

    expect(adapter.requests.length).toBe(1)
    expect(recorder.of('llm/retry')).toEqual([])
    recorder.release()
  })

  it('drops the retry when the caller cancels during the wait', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      failureFinish(new LlmError('busy', 'RATE_LIMIT', { status: 429 })),
    ])
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-cancel'), { provider: 'mock', model: 'mock' })
    const recorder = new Recorder(context, agent)
    const idle = agent.whenIdle()

    followup(agent)
    while (recorder.of('llm/retry').length === 0) await vi.advanceTimersByTimeAsync(0)
    agent.cancel({ kind: 'user' })
    await vi.advanceTimersByTimeAsync(60_000)
    await idle

    // Cancellation during the wait leaves the single failed attempt terminal.
    expect(adapter.requests.length).toBe(1)
    expect(recorder.of('llm/retry-started')).toEqual([])
    recorder.release()
  })

  it('rebuilds the durable budget from replayed retry events and resets it per step', async () => {
    type Definition = { key: string; apply(state: object, event: unknown): object }
    const definitions: Definition[] = []
    ;({ ctx: context } = await harness(new ScriptedAdapter([]), undefined, {}, (inner) => {
      const projections = inner.sessionProjections
      const register = projections.register.bind(projections)
      projections.register = (spec: Definition) => {
        definitions.push(spec)
        return register(spec as never)
      }
    }))
    const definition = definitions.find(spec => spec.key === 'llmRetry')!
    const policyKey = JSON.stringify(['normal', 2, [], 500, 10_000, 0])
    const event = {
      type: 'llm/retry',
      data: { provider: 'mock', policyKey, retry: 1, retryId: 'chain-1' },
    }
    const state = definition.apply({}, event) as Record<string, { retry: number; retryId: string }>
    expect(state[JSON.stringify(['mock', policyKey])]).toEqual({ retry: 1, retryId: 'chain-1' })
    expect(definition.apply(state, event)).toBe(state)
    expect(definition.apply(state, { type: 'step/start' })).toEqual({})
  })

  it('rejects misplaced or unknown executor config keys at load', () => {
    const ctx = new Context()
    expect(() => { retry.apply(ctx, { retryPolicy: normalPolicy() } as never) }).toThrow(
      'gh-model-retry: retryPolicy belongs under each provider configuration')
    expect(() => { retry.apply(ctx, { nonsense: true } as never) }).toThrow('gh-model-retry: unknown key "nonsense"')
  })
})
