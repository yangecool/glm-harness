/** Deterministic GLM wire fixtures and a loopback chat-completions endpoint with explicit teardown. */
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { BlockAssembler, createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '../src/index.ts'
import { GlmChatAdapter } from '../src/adapter.ts'
import type { GlmAdapterOptions } from '../src/adapter.ts'
import type { Options as Config } from '../src/config.ts'

export const MODEL = 'glm-4.6'
export const user = (text = 'hello') => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
export const options = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'glm', model: MODEL, messages: [user()], ...overrides })

/** One streamed frame with a text delta. */
export const textFrame = (text: string) => ({ choices: [{ index: 0, delta: { content: text } }] })
/** One streamed frame with a reasoning delta. */
export const reasoningFrame = (text: string) => ({ choices: [{ index: 0, delta: { reasoning_content: text } }] })
/** The finish frame: stop reason and, optionally, final usage. */
export const finishFrame = (reason = 'stop', usage?: Record<string, unknown>) => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  ...usage === undefined ? {} : { usage },
})
export const USAGE = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }
export const CACHED_USAGE = {
  prompt_tokens: 100,
  completion_tokens: 40,
  total_tokens: 140,
  prompt_tokens_details: { cached_tokens: 64 },
  completion_tokens_details: { reasoning_tokens: 24 },
}

/** Split tool-call fragments across frames the way the protocol streams them. */
export function toolFrames(name = 'get_weather', id = 'call_1', args = '{"city":"杭州"}') {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 8) } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] } }] },
  ]
}

export const DONE = '[DONE]'

/** Encode events as the SSE byte stream the adapter parses. */
export const sse = (events: unknown[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder()
    for (const event of events) {
      const payload = typeof event === 'string' ? event : JSON.stringify(event)
      controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
    }
    controller.close()
  },
})

export async function* events(values: unknown[]) { yield* values }
export async function chunks(stream: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

/** Drive one stream through the assembler the way the agent loop does. */
export async function assemble(stream: AsyncIterable<StreamChunk>, model = MODEL) {
  const assembler = new BlockAssembler()
  const output = await chunks(stream)
  for (const chunk of output) assembler.push(chunk)
  const message = createAssistantMessage({ content: assembler.blocks(), source: { provider: 'glm', model } })
  return { output, message, assembler }
}

export function adapter(config: Config = {}, dependencies: Partial<GlmAdapterOptions> = {}) {
  return new GlmChatAdapter({
    options: () => resolveAdapterOptions(config),
    resolveApiKey: () => Promise.resolve('test-key'),
    ...dependencies,
  })
}

/** A conversation history exercising text, tool-call, and tool-result messages. */
export function toolHistory() {
  return [
    user('杭州天气怎么样?'),
    createAssistantMessage({
      content: [
        { type: 'reasoning', text: '需要查天气' },
        { type: 'text', text: '我来查一下。' },
        { type: 'tool-call', id: ToolCallId('call_1'), name: 'get_weather', arguments: '{"city":"杭州"}' },
      ],
      source: { provider: 'glm', model: MODEL },
    }),
    createToolResultMessage({ callId: ToolCallId('call_1'), content: [{ type: 'text', text: '晴,26℃' }], isError: false }),
  ]
}

/**
 * Loopback chat-completions endpoint recording each model request.
 * @param reply - answers each POST, writing SSE frames or an HTTP error.
 * @returns the endpoint base URL, recorded requests, and teardown.
 */
export async function server(reply: (response: ServerResponse, count: number) => void = response => response.end()) {
  const requests: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = []
  const http = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => response.destroy(error as Error))
  })
  async function handle(request: import('node:http').IncomingMessage, response: ServerResponse) {
    const parts: Buffer[] = []
    for await (const part of request as AsyncIterable<Buffer>) parts.push(part)
    const raw = Buffer.concat(parts).toString()
    requests.push({ path: request.url!, headers: request.headers, body: JSON.parse(raw) as Record<string, unknown> })
    reply(response, requests.length)
  }
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      const closed = new Promise<void>((resolve, reject) => http.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
      http.closeAllConnections()
      await closed
    },
  }
}

/** Reply with a complete successful SSE exchange. */
export function sseReply(frames: unknown[]): (response: ServerResponse) => void {
  return (response) => {
    response.setHeader('content-type', 'text/event-stream')
    response.end(frames.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
  }
}

/** Reply with an HTTP error carrying a JSON body. */
export function errorReply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return (response: ServerResponse) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  }
}
