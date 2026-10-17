/**
 * GLM Harness bounded model-request retry executor.
 *
 * Providers own their retry policy (`LlmAdapter.providerRetryPolicy`); this
 * plugin executes those policies on the agent loop's request-recovery
 * extension point. Each retry is scheduled durably — the `llm/retry` event is
 * committed before its cancellable wait, and `llm/retry-started` after it —
 * so restarts, the token meter, and the retry UI all read one chain of
 * physical attempts under a stable {@link RetryId}.
 *
 * The executor is bounded by design: it runs normal-mode policies only. An
 * `always` policy is refused loudly and delegated, because GH exposes retry
 * budgets instead of invisible unbounded waiting; a provider `Retry-After`
 * beyond the policy's `maxDelayMs` cap likewise fails the step instead of
 * parking the session on a long hold.
 *
 * @module @glm-harness/gh-model-retry
 */

import { randomUUID } from 'node:crypto'
import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, RequestErrorAction, RetryId } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'

export const name = 'gh-model-retry'
export const inject = ['agents', 'sessionProjections']

/** This executor has no config; provider registrations own retry policy. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

/** Reject config keys that look like a misplaced provider policy. */
function validateConfig(config: Config): void {
  const [key] = Object.keys(config)
  if (key === undefined) return
  if (key === 'retryPolicy') {
    throw new Error('gh-model-retry: retryPolicy belongs under each provider configuration')
  }
  throw new Error(`gh-model-retry: unknown key "${key}"`)
}

/** Non-serializable hooks that make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

/** Durable retry count and chain identity per provider and policy. */
interface RetryStateEntry {
  retry: number
  retryId: RetryId
}

type GhLlmRetryState = Record<string, RetryStateEntry>

// The cast bridges the branded retry id, which zod cannot express directly.
const retryStateSchema: zod.ZodType<GhLlmRetryState> = zod.record(zod.string(), zod.object({
  retry: zod.number().int().nonnegative(),
  retryId: zod.string(),
})) as unknown as zod.ZodType<GhLlmRetryState>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Retry state for the current step by provider and policy. */
    llmRetry: GhLlmRetryState
  }
}

/** Exponential backoff with symmetric jitter, capped at the policy maximum. */
function localDelay(policy: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

/** Stable identity of one policy's content; durable state keys on it. */
function policyKeyOf(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'normal'
    ? JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
    ])
    : JSON.stringify([policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
}

/** State key of one provider's policy chain within a session step. */
function stateKeyOf(provider: string, policyKey: string): string {
  return JSON.stringify([provider, policyKey])
}

/** Resolve after `delayMs`, or `false` as soon as `signal` aborts. */
function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Install the bounded provider-routed request recovery.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - empty executor config; provider registrations own policy.
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  validateConfig(config)
  ctx.sessionProjections.register({
    key: 'llmRetry',
    stateVersion: 1,
    stateSchema: retryStateSchema,
    init: () => ({}),
    apply: (state, event) => {
      if (event.type === 'step/start' || event.type === 'turn/end') return {}
      if (event.type !== 'llm/retry') return state
      const key = stateKeyOf(event.data.provider, event.data.policyKey)
      const entry = state[key]
      if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state
      return { ...state, [key]: { retry: event.data.retry, retryId: event.data.retryId } }
    },
  })
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  /** Commit the retry decision durably, wait, then admit the next attempt. */
  async function backoff(
    agent: Agent,
    turn: number,
    step: number,
    failure: LlmFailure,
    provider: string,
    policy: ResolvedNormalPolicyView,
    key: string,
    retry: number,
    retryId: RetryId,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fused = AbortSignal.any([signal, lifetime.signal])
    if (fused.aborted) return undefined
    agent.session.append('llm/retry', {
      retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey: key,
      retry,
      maxRetries: policy.maxRetries,
      delayMs,
      failure,
    })
    if (!await cancellableDelay(delayMs, fused)) return undefined
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  async function recover(
    { agent, turn, step, provider, failure, retryPolicy: policy, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    if (policy === undefined) return next()
    if (policy.mode !== 'normal') {
      // GH runs bounded budgets only; an unbounded policy is a composition
      // mistake this executor reports instead of silently honoring.
      ctx.logger.warn(
        `gh-model-retry: provider "${provider}" declared a ${policy.mode}-mode retry policy; this executor runs bounded policies only, failing the step`,
      )
      return next()
    }
    if (!policy.retryableCodes.includes(failure.code)) return next()

    const key = policyKeyOf(policy)
    const retryState = ctx.sessionProjections.stateOf(agent.session, 'llmRetry') as GhLlmRetryState
    const previous = retryState[stateKeyOf(provider, key)]
    const previousRetry = previous?.retry ?? 0
    if (previousRetry >= policy.maxRetries) return next()
    const retry = previousRetry + 1
    const retryId = previous?.retryId ?? brandString<RetryId>(randomUUID())
    let delayMs: number
    if (failure.providerRetryAfterMs !== undefined
      && Number.isFinite(failure.providerRetryAfterMs)
      && failure.providerRetryAfterMs > 0) {
      if (failure.providerRetryAfterMs > policy.maxDelayMs) return next()
      delayMs = failure.providerRetryAfterMs
    } else {
      delayMs = localDelay(policy, retry, random)
    }
    return backoff(agent, turn, step, failure, provider, policy, key, retry, retryId, delayMs, signal)
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed; lifetime cancellation keeps that stale callback inert.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('gh-model-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'gh-model-retry: abort and drain active recovery')
}

/** The bounded slice of a provider retry policy this executor consumes. */
type ResolvedNormalPolicyView = Extract<ResolvedRetryPolicy, { mode: 'normal' }>
