/** Pure protocol tests: SSE framing, stream translation, serialization, and error classification. */
import { describe, expect, it } from 'vitest'
import { LlmError, ReasoningEffortId, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { serialize, thinkingRequest } from '../src/serialize.ts'
import { parseSseFrames } from '../src/sse.ts'
import { translate } from '../src/translate.ts'
import { providerError, streamError } from '../src/transport.ts'
import {
  CACHED_USAGE,
  DONE,
  USAGE,
  assemble,
  chunks,
  events,
  finishFrame,
  options,
  reasoningFrame,
  textFrame,
  toolFrames,
  toolHistory,
  user,
} from './helpers.ts'

function chunked(bytes: string[], sizes: number[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const all = encoder.encode(bytes.join(''))
  const parts: Uint8Array[] = []
  let offset = 0
  for (const size of sizes) {
    parts.push(all.subarray(offset, offset + size))
    offset += size
  }
  if (offset < all.length) parts.push(all.subarray(offset))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

describe('parseSseFrames', () => {
  it('parses frames split across arbitrary chunk boundaries', async () => {
    const text = 'data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n'
    const pulses: number[] = []
    const frames = []
    for await (const frame of parseSseFrames(chunked([text], [1, 3, 7, 2, 11]), () => pulses.push(1))) {
      frames.push(frame)
    }
    expect(frames).toEqual([{ data: '{"a":1}' }, { data: '{"a":2}' }, { data: '[DONE]' }])
    expect(pulses.length).toBe(3)
  })

  it('drops a torn trailing frame and passes comments through as activity', async () => {
    let pulses = 0
    const frames = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(': heartbeat\n\n'))
        controller.enqueue(encoder.encode('data: {"a":1}\n\n'))
        controller.enqueue(encoder.encode('data: tor'))
        controller.close()
      },
    })
    for await (const frame of parseSseFrames(stream, () => pulses++)) frames.push(frame)
    expect(frames).toEqual([{ data: '{"a":1}' }])
    expect(pulses).toBe(2)
  })

  it('joins multi-line data payloads with newlines and captures event names', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode('event: add\ndata: line1\ndata: line2\n\n'))
        controller.close()
      },
    })
    const frames = []
    for await (const frame of parseSseFrames(stream, () => {})) frames.push(frame)
    expect(frames).toEqual([{ event: 'add', data: 'line1\nline2' }])
  })
})

describe('translate', () => {
  it('emits an ordered text stream with usage before the terminal finish', async () => {
    const { output, message, assembler } = await assemble(translate(events([
      textFrame('你好'),
      textFrame(',世界'),
      finishFrame('stop', USAGE),
      DONE,
    ])))
    expect(output.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    expect(message.content).toEqual([{ type: 'text', text: '你好,世界' }])
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.usage).toMatchObject({ inputTokens: 100, outputTokens: 40, totalTokens: 140 })
  })

  it('synthesizes reasoning and text blocks in first-seen order', async () => {
    const { message } = await assemble(translate(events([
      reasoningFrame('想一下'),
      textFrame('答案'),
      finishFrame(),
      DONE,
    ])))
    expect(message.content).toEqual([
      { type: 'reasoning', text: '想一下' },
      { type: 'text', text: '答案' },
    ])
  })

  it('assembles split tool-call fragments into one tool-call block and maps the finish', async () => {
    const { message, assembler } = await assemble(translate(events([
      ...toolFrames(),
      finishFrame('tool_calls', USAGE),
      DONE,
    ])))
    expect(message.content).toEqual([{
      type: 'tool-call',
      id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"杭州"}',
    }])
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
  })

  it('maps length to max-tokens and keeps truncated tool arguments', async () => {
    const { assembler } = await assemble(translate(events([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a"' } }] } }] },
      finishFrame('length'),
      DONE,
    ])))
    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
  })

  it('treats empty tool arguments as an empty object', async () => {
    const { message } = await assemble(translate(events([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ping', arguments: '' } }] } }] },
      finishFrame('tool_calls'),
      DONE,
    ])))
    expect(message.content).toEqual([{ type: 'tool-call', id: 'call_1', name: 'ping', arguments: '{}' }])
  })

  it('splits usage into disjoint cache and reasoning counts', async () => {
    const { assembler } = await assemble(translate(events([
      textFrame('x'),
      finishFrame('stop', CACHED_USAGE),
      DONE,
    ])))
    expect(assembler.usage).toEqual({
      inputTokens: 36,
      outputTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 64,
      reasoningTokens: 24,
    })
  })

  it('rejects a stream that ends without [DONE]', async () => {
    await expect(chunks(translate(events([textFrame('x'), finishFrame()])))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('rejects a stop with no content blocks as an empty response', async () => {
    await expect(chunks(translate(events([finishFrame(), DONE])))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('rejects a stream that never carries a finish_reason', async () => {
    await expect(chunks(translate(events([textFrame('x'), DONE])))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects non-object tool arguments on a tool-calls finish', async () => {
    await expect(chunks(translate(events([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '[1,2]' } }] } }] },
      finishFrame('tool_calls'),
      DONE,
    ])))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects more than one choice and unsupported finish reasons', async () => {
    await expect(chunks(translate(events([
      { choices: [{ index: 0, delta: { content: 'a' } }, { index: 1, delta: { content: 'b' } }] },
      finishFrame(),
      DONE,
    ])))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(chunks(translate(events([textFrame('x'), finishFrame('content_filter'), DONE]))))
      .rejects.toMatchObject({ code: 'SERVER' })
  })

  it('classifies an in-band error frame', async () => {
    await expect(chunks(translate(events([{ error: { code: '1302', message: 'API key 无效' } }]))))
      .rejects.toMatchObject({ code: 'SERVER' })
  })
})

describe('serialize', () => {
  it('serializes a tool conversation without reasoning and with tool identity intact', () => {
    const body = serialize(options({
      messages: toolHistory(),
      tools: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object' }, deferLoading: true }],
      system: '你是 GH',
    }), { thinking: true })
    expect(body.model).toBe('glm-4.6')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.messages).toEqual([
      { role: 'system', content: '你是 GH' },
      { role: 'user', content: '杭州天气怎么样?' },
      { role: 'assistant', content: '我来查一下。', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"杭州"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴,26℃' },
    ])
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object' } } }])
    expect(body.thinking).toBeUndefined()
  })

  it('folds a one-shot system prompt into a history system message', () => {
    const history = options({ messages: [createSystemMessage('历史提示'), user('hi')] })
    const body = serialize({ ...history, system: '一次性提示' }, { thinking: false })
    expect(body.messages[0]).toEqual({ role: 'system', content: '一次性提示\n\n历史提示' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('maps the thinking switch and optional call parameters', () => {
    const base = options({ maxTokens: 512, temperature: 0.2, stop: ['END'] })
    expect(serialize({ ...base, reasoningEffort: ReasoningEffortId('high') }, { thinking: true }).thinking).toEqual({ type: 'enabled' })
    expect(serialize({ ...base, reasoningEffort: ReasoningEffortId('off') }, { thinking: true }).thinking).toEqual({ type: 'disabled' })
    expect(serialize(base, { thinking: false }).thinking).toBeUndefined()
    const body = serialize(base, { thinking: false })
    expect(body.max_tokens).toBe(512)
    expect(body.temperature).toBe(0.2)
    expect(body.stop).toEqual(['END'])
  })

  it('maps binary thinking efforts for the request', () => {
    expect(thinkingRequest(undefined, true)).toBeUndefined()
    expect(thinkingRequest('off', true)).toEqual({ type: 'disabled' })
    expect(thinkingRequest('high', true)).toEqual({ type: 'enabled' })
    expect(thinkingRequest('high', false)).toBeUndefined()
  })
})

describe('providerError', () => {
  const fail = (status: number, body: unknown, headers: Record<string, string> = {}): LlmError => {
    try {
      providerError(typeof body === 'string' ? body : JSON.stringify(body), status, new Headers(headers))
    } catch (error) {
      return error as LlmError
    }
    throw new Error('providerError did not throw')
  }

  it('classifies statuses and carries retry-after and request-id facts', () => {
    expect(fail(401, { error: { message: 'bad key' } })).toMatchObject({ code: 'AUTH' })
    expect(fail(429, { error: { message: 'slow down' } }, { 'retry-after': '3', 'x-request-id': 'req-9' }))
      .toMatchObject({ code: 'RATE_LIMIT', failure: { providerRetryAfterMs: 3_000, requestId: 'req-9' } })
    expect(fail(500, 'oops')).toMatchObject({ code: 'SERVER' })
    expect(fail(418, { error: { message: 'teapot' } })).toMatchObject({ code: 'HTTP_418' })
  })

  it('classifies provider error text beyond the status', () => {
    expect(fail(400, { error: { code: '1302', message: 'insufficient balance, quota exceeded' } })).toMatchObject({ code: 'QUOTA' })
    expect(fail(400, { error: { message: 'prompt exceeds the maximum context length of 200000 tokens' } }))
      .toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(fail(400, { error: { message: 'invalid parameter' } })).toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('classifies in-band stream errors', () => {
    try {
      streamError({ code: '1302', message: 'quota exhausted' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'QUOTA' })
      return
    }
    throw new Error('streamError did not throw')
  })
})
