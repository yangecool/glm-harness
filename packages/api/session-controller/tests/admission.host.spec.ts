import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { promptRequestFingerprint } from '../src/admission.ts'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'

const SESSION = SessionId('admission-session')

interface AdmissionHarness {
  ctx: Context
  controller: SessionCommandController
  agent: Agent
  followup: ReturnType<typeof vi.fn>
}

/**
 * Mount the minimal host surface `SessionCommandController.prompt` needs,
 * with the production serialization semantics (one promise chain per Agent)
 * and a no-op attachment store — admission tests exercise text prompts.
 */
async function admissionHarness(options: { durableAdmission?: boolean } = {}): Promise<AdmissionHarness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SESSION, { meta: { cwd: '/workspace' } })
  const followup = vi.fn()
  const agent = {
    id: session.id,
    session,
    inbox: createInboxStub(),
    status: 'idle',
    ctx: undefined,
    steer: vi.fn(),
    followup,
    cancel: vi.fn(),
  } as unknown as Agent
  ;(agent as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  await ctx.agents.register(agent)
  ctx.provide('attachments', {
    admitPromptContent: async <Part>(content: readonly Part[]) => content,
  } as never)
  ctx.provide('fileUploads', {
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
  } as never)
  ctx.provide('llm', {
    resolveModelInfo: () => Promise.resolve({ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }),
  } as never)
  const selection: ModelSelectionRef = { current: { provider: 'fixture', model: 'fixture-model' }, assembled: undefined }
  // The production serializeAdmission: one check-then-place chain per Agent.
  const chains = new Map<Agent, Promise<unknown>>()
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeAdmission: <Value>(owner: Agent, operation: () => Promise<Value>): Promise<Value> => {
      const result = (chains.get(owner) ?? Promise.resolve()).then(operation)
      chains.set(owner, result.then(() => undefined, () => undefined))
      return result
    },
  } as unknown as ApiSessionAgentController
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace', options.durableAdmission ?? false),
    agent,
    followup,
  }
}

const USER_SOURCE: MessageSource = { kind: 'user', rpcId: 'req-1' as SessionRequestId }

function promptRequest(content: readonly [{ type: 'text'; text: string }], requestId = 'req-1'): SessionPromptRequest {
  return { requestId: requestId as SessionRequestId, sessionId: SESSION, mode: 'queue', content }
}

describe('Durable prompt admission', () => {
  it('admits once and acknowledges identical concurrent resubmissions', async () => {
    const { controller, followup } = await admissionHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    const [first, second] = await Promise.all([
      controller.prompt(request, USER_SOURCE),
      controller.prompt(request, USER_SOURCE),
    ])
    expect(first).toEqual({ accepted: true })
    expect(second).toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('acknowledges a retry after a lost ACK without re-placing the message', async () => {
    const { controller, followup } = await admissionHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    await controller.prompt(request, USER_SOURCE)
    await expect(controller.prompt(request, USER_SOURCE)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('rejects a different payload on the same requestId as a conflict', async () => {
    const { controller, followup } = await admissionHarness()
    await controller.prompt(promptRequest([{ type: 'text', text: 'once' }]), USER_SOURCE)
    await expect(controller.prompt(promptRequest([{ type: 'text', text: 'twice' }]), USER_SOURCE))
      .rejects.toMatchObject({ code: 'session/request-conflict' })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('reconciles a durable-log rpcId idempotently and conflicts on different text', async () => {
    const { controller, agent, followup } = await admissionHarness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'once' }],
      source: { kind: 'user', rpcId: 'req-1' as SessionRequestId },
    }), { surfaceOp: 'append' })
    await expect(controller.prompt(promptRequest([{ type: 'text', text: 'once' }]), USER_SOURCE))
      .resolves.toEqual({ accepted: true })
    expect(followup).not.toHaveBeenCalled()
    await expect(controller.prompt(promptRequest([{ type: 'text', text: 'other' }]), USER_SOURCE))
      .rejects.toMatchObject({ code: 'session/request-conflict' })
  })

  it('answers the admission query from the journal, the durable log, and absence', async () => {
    const { controller, agent } = await admissionHarness()
    const absent = await controller.admission({ sessionId: SESSION, requestId: 'never' as SessionRequestId })
    expect(absent).toEqual({ found: false })
    await controller.prompt(promptRequest([{ type: 'text', text: 'once' }]), USER_SOURCE)
    const recorded = await controller.admission({ sessionId: SESSION, requestId: 'req-1' as SessionRequestId })
    expect(recorded.found).toBe(true)
    expect(recorded.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(recorded.admittedAt).toBeGreaterThan(0)
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'logged' }],
      source: { kind: 'user', rpcId: 'logged-req' as SessionRequestId },
    }), { surfaceOp: 'append' })
    const recovered = await controller.admission({ sessionId: SESSION, requestId: 'logged-req' as SessionRequestId })
    expect(recovered.found).toBe(true)
    expect(recovered.admittedAt).toBeUndefined()
  })

  it('keeps upstream ACK semantics when durable admission is off', async () => {
    const { controller } = await admissionHarness({ durableAdmission: false })
    await expect(controller.prompt(promptRequest([{ type: 'text', text: 'once' }]), USER_SOURCE))
      .resolves.toEqual({ accepted: true })
  })

  it('never converts missing durability into success on retries or queries, then recovers without reinsertion', async () => {
    const { ctx, controller, followup } = await admissionHarness({ durableAdmission: true })
    const request = promptRequest([{ type: 'text', text: 'once' }])
    await expect(controller.prompt(request, USER_SOURCE))
      .rejects.toMatchObject({ code: 'session/no-durable-writer' })
    expect(followup).toHaveBeenCalledOnce()
    await expect(controller.prompt(request, USER_SOURCE)).rejects.toMatchObject({ code: 'session/no-durable-writer' })
    await expect(controller.admission({ sessionId: SESSION, requestId: request.requestId }))
      .rejects.toMatchObject({ code: 'session/no-durable-writer' })
    expect(followup).toHaveBeenCalledOnce()
    ctx.on('session/flush', () => {})
    await expect(controller.prompt(request, USER_SOURCE)).resolves.toEqual({ accepted: true })
    const status = await controller.admission({ sessionId: SESSION, requestId: 'req-1' as SessionRequestId })
    expect(status.found).toBe(true)
  })

  it('maps a flushing failure to session/flush-failed without dropping the admission', async () => {
    const { ctx, controller, followup } = await admissionHarness({ durableAdmission: true })
    ctx.on('session/flush', () => { throw new Error('disk full') })
    await expect(controller.prompt(promptRequest([{ type: 'text', text: 'once' }]), USER_SOURCE))
      .rejects.toMatchObject({ code: 'session/flush-failed' })
    expect(followup).toHaveBeenCalledOnce()
    await expect(controller.prompt(promptRequest([{ type: 'text', text: 'once' }]), USER_SOURCE))
      .rejects.toMatchObject({ code: 'session/flush-failed' })
    await expect(controller.admission({ sessionId: SESSION, requestId: 'req-1' as SessionRequestId }))
      .rejects.toMatchObject({ code: 'session/flush-failed' })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('reconciles original payloads from canceled or edited durable inbox insertions after restart', async () => {
    const { controller, agent, followup } = await admissionHarness()
    const request: SessionPromptRequest = {
      ...promptRequest([{ type: 'text', text: 'once' }]),
      content: [{ type: 'image', mediaType: 'image/png', data: 'original' }],
    }
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0,
      inserted: [createUserMessage({
        content: [{ type: 'text', text: 'promoted content' }],
        source: { kind: 'user', rpcId: request.requestId, admissionFingerprint: promptRequestFingerprint(request) },
      })],
    })
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    })
    await expect(controller.admission({ sessionId: SESSION, requestId: request.requestId }))
      .resolves.toMatchObject({ found: true, fingerprint: promptRequestFingerprint(request) })
    await expect(controller.prompt(request, USER_SOURCE)).resolves.toEqual({ accepted: true })
    await expect(controller.prompt({ ...request, mode: 'steer' }, USER_SOURCE))
      .rejects.toMatchObject({ code: 'session/request-conflict' })
    await expect(controller.prompt({ ...request, content: [{ type: 'image', mediaType: 'image/png', data: 'other' }] }, USER_SOURCE))
      .rejects.toMatchObject({ code: 'session/request-conflict' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('serializes an admission query behind pending validation and flush', async () => {
    const { ctx, controller } = await admissionHarness({ durableAdmission: true })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('session/flush', async () => { entered.resolve(undefined); await release.promise })
    const pending = controller.prompt(promptRequest([{ type: 'text', text: 'once' }]), USER_SOURCE)
    await entered.promise
    let answered = false
    const query = controller.admission({ sessionId: SESSION, requestId: 'req-1' as SessionRequestId })
      .then((value) => { answered = true; return value })
    await Promise.resolve()
    expect(answered).toBe(false)
    release.resolve(undefined)
    await pending
    await expect(query).resolves.toMatchObject({ found: true })
  })

  it('ACKs only after the flush participates when a writer is mounted', async () => {
    const { ctx, controller } = await admissionHarness({ durableAdmission: true })
    const flushed = vi.fn()
    ctx.on('session/flush', async () => { flushed() })
    await expect(controller.prompt(promptRequest([{ type: 'text', text: 'once' }]), USER_SOURCE))
      .resolves.toEqual({ accepted: true })
    expect(flushed).toHaveBeenCalledOnce()
  })
})
