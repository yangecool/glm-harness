/** Adapter-against-loopback tests: wire shape, headers, credentials, failure paths, and catalog answers. */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  DONE,
  MODEL,
  USAGE,
  adapter,
  assemble,
  errorReply,
  finishFrame,
  options,
  sseReply,
  server,
  textFrame,
  toolFrames,
} from './helpers.ts'

const openServers: Awaited<ReturnType<typeof server>>[] = []
afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()?.close()
})

async function boot(reply: Parameters<typeof server>[0]) {
  const endpoint = await server(reply)
  openServers.push(endpoint)
  return { endpoint, glm: adapter({ baseURL: endpoint.url }) }
}

describe('GlmChatAdapter.stream', () => {
  it('posts a well-formed chat-completions request with attribution and bearer headers', async () => {
    const { endpoint, glm } = await boot(sseReply([
      textFrame('你好'),
      finishFrame('stop', USAGE),
      DONE,
    ]))
    const { message } = await assemble(glm.stream(options()))
    expect(message.content).toEqual([{ type: 'text', text: '你好' }])
    const [request] = endpoint.requests
    if (request === undefined) throw new Error('no request recorded')
    expect(request.path).toBe('/chat/completions')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers.accept).toBe('text/event-stream')
    expect(String(request.headers.authorization)).toBe('Bearer test-key')
    expect(String(request.headers['user-agent'])).toMatch(/^deepseek-harness\//)
    expect(request.body.model).toBe(MODEL)
    expect(request.body.stream).toBe(true)
    expect(request.body.stream_options).toEqual({ include_usage: true })
  })

  it('sends the thinking switch the resolved effort requests', async () => {
    const { endpoint, glm } = await boot(sseReply([textFrame('ok'), finishFrame(), DONE]))
    await assemble(glm.stream(options({ reasoningEffort: ReasoningEffortId('high') })))
    await assemble(glm.stream(options({ reasoningEffort: ReasoningEffortId('off') })))
    const [high, off] = endpoint.requests
    if (high === undefined || off === undefined) throw new Error('expected two recorded requests')
    expect(high.body.thinking).toEqual({ type: 'enabled' })
    expect(off.body.thinking).toEqual({ type: 'disabled' })
  })

  it('accepts deep-frozen loop-built options without mutation', async () => {
    const { glm } = await boot(sseReply([textFrame('ok'), finishFrame(), DONE]))
    const frozen = deepFreeze(options())
    await assemble(glm.stream(frozen))
    expect(Object.isFrozen(frozen)).toBe(true)
  })

  it('surfaces a missing key as the documented MISSING_CREDENTIAL failure', async () => {
    const { endpoint } = await boot(sseReply([textFrame('x'), finishFrame(), DONE]))
    const glm = adapter({ baseURL: endpoint.url }, {
      resolveApiKey: async () => {
        throw new LlmError('model-glm: no API key for provider route "glm"', 'MISSING_CREDENTIAL')
      },
    })
    await expect(assemble(glm.stream(options()))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(endpoint.requests.length).toBe(0)
  })

  it('classifies HTTP failures with provider facts', async () => {
    const { glm } = await boot(errorReply(401, { error: { code: '1000', message: 'invalid api key' } }))
    await expect(assemble(glm.stream(options()))).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('classifies rate limits with the provider retry hint', async () => {
    const { glm } = await boot(errorReply(429, { error: { message: 'too many requests' } }, { 'retry-after': '2', 'x-request-id': 'req-1' }))
    await expect(assemble(glm.stream(options()))).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      failure: { providerRetryAfterMs: 2_000, requestId: 'req-1' },
    })
  })

  it('preserves rate-limit classification for zero, expired, and overflowing retry hints', async () => {
    for (const hint of ['0', 'Wed, 21 Oct 2015 07:28:00 GMT', '9'.repeat(400)]) {
      const { glm } = await boot(errorReply(429, { error: { message: 'wait' } }, { 'retry-after': hint }))
      await expect(assemble(glm.stream(options()))).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    }
  })

  it('completes a full tool round trip over the wire', async () => {
    const { glm } = await boot(sseReply([
      ...toolFrames(),
      finishFrame('tool_calls', USAGE),
      DONE,
    ]))
    const { message, assembler } = await assemble(glm.stream(options()))
    expect(message.content).toEqual([{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"杭州"}' }])
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
  })

  it('honors a pre-aborted signal without issuing the request', async () => {
    const { endpoint, glm } = await boot(sseReply([textFrame('x'), finishFrame(), DONE]))
    const controller = new AbortController()
    controller.abort()
    await expect(assemble(glm.stream(options({ signal: controller.signal })))).rejects.toMatchObject({ code: 'ABORTED' })
    expect(endpoint.requests.length).toBe(0)
  })

  it('times out a stalled credential lookup without issuing HTTP', async () => {
    const { endpoint } = await boot(sseReply([textFrame('x'), finishFrame(), DONE]))
    const glm = adapter({ baseURL: endpoint.url, requestTimeoutMs: 25 }, {
      resolveApiKey: () => new Promise<string>(() => {}),
    })
    await expect(assemble(glm.stream(options()))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(endpoint.requests).toHaveLength(0)
  })

  it('bounds response headers and a stalled HTTP error body', async () => {
    for (const status of [undefined, 500]) {
      const { endpoint } = await boot((response) => {
        if (status !== undefined) {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.flushHeaders()
        }
      })
      await expect(assemble(adapter({ baseURL: endpoint.url, requestTimeoutMs: 50 }).stream(options())))
        .rejects.toMatchObject({ code: 'TIMEOUT' })
    }
  })

  it('bounds a half-open stream after its headers arrived', async () => {
    const { endpoint } = await boot((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
    })
    await expect(assemble(adapter({ baseURL: endpoint.url, streamIdleTimeoutMs: 25 }).stream(options())))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('cancels a shared credential wait without waiting for its deadline', async () => {
    const waiting = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const glm = adapter({}, {
      resolveApiKey: () => {
        waiting.resolve(undefined)
        return new Promise<string>(() => {})
      },
    })
    const running = assemble(glm.stream(options({ signal: controller.signal })))
    await waiting.promise
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('GlmChatAdapter capabilities', () => {
  it('advertises the catalog with reasoning efforts for thinking models', async () => {
    const glm = adapter()
    const models = await glm.listModels('glm')
    expect(models.map(model => model.id)).toEqual(['glm-4.6', 'glm-4.5-air', 'glm-4.5-flash'])
    const flagship = await glm.resolveModel('glm', 'glm-4.6')
    expect(flagship).toMatchObject({
      provider: 'glm',
      id: 'glm-4.6',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8_192,
      inputModalities: ['text'],
    })
    expect(flagship.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high'])
    expect(flagship.reasoning?.defaultEffort).toBe('high')
  })

  it('rejects uncatalogued ids without inventing capabilities or sending them upstream', () => {
    const glm = adapter()
    expect(() => glm.resolveModel('glm', 'some-other-model')).toThrow(/not configured/)
    expect(() => glm.stream(options({ model: 'unspecified' }))).toThrow(/not configured/)
  })

  it('binds capability answers and dispatch to one connection generation', async () => {
    const glm = adapter({ baseURL: 'http://127.0.0.1:9' })
    const prepared = await glm.prepareCall('glm', 'glm-4.6')
    expect(prepared.model.id).toBe('glm-4.6')
    await expect(assemble(prepared.stream(options()))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })
})

describe('GLM retry policy', () => {
  it('exposes the bounded GH default with the stream-close code retryable', () => {
    const glm = adapter()
    const policy = glm.providerRetryPolicy('glm')
    expect(policy).toMatchObject({ mode: 'normal', maxRetries: 3 })
    if (policy?.mode !== 'normal') throw new Error('expected the resolved normal policy')
    expect(policy.retryableCodes).toContain('STREAM_CLOSED')
    expect(policy.retryableCodes).not.toContain('AUTH')
    expect(policy.retryableCodes).not.toContain('TRUNCATED_TOOL_CALLS')
  })

  it('carries a deployment-configured policy through the connection generation', () => {
    const glm = adapter({ retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: ['SERVER'] } })
    expect(glm.providerRetryPolicy('glm')).toMatchObject({ mode: 'normal', maxRetries: 0, retryableCodes: ['SERVER'] })
  })
})
