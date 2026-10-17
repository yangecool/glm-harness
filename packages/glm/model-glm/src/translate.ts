/**
 * Stream translation: GLM chat-completions frames become the harness's
 * neutral {@link StreamChunk} sequence. The protocol has no explicit block
 * boundaries, so blocks are synthesized in first-seen order and closed once,
 * at the terminal `[DONE]` frame; usage is emitted before the single
 * terminal finish and nothing follows it.
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { streamError } from './transport.ts'
import { STREAM_DONE, type WireDelta, type WireFrame, type WireToolCallDelta } from './wire-types.ts'

/** One synthesized output block under construction. */
interface OpenBlock {
  /** Chunk index this block owns, in first-seen order. */
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** Tool-call facts; set for kind 'tool-call'. */
  tool?: { id: string; name: string; args: string }
}

/** Wire stop reasons that mean generation finished normally. */
const STOP_FINISH = new Set(['stop', 'stop_sequence'])

/**
 * Translate parsed wire frames into stream chunks.
 *
 * @param events - JSON-parsed frames in arrival order, ending with the
 * `[DONE]` marker string.
 * @yields the neutral chunk sequence, terminated by one finish chunk.
 */
export async function* translate(events: AsyncIterable<unknown>): AsyncGenerator<StreamChunk> {
  const blocks = new Map<string, OpenBlock>()
  const keyByToolId = new Map<string, string>()
  let nextIndex = 0
  let finishKind: 'stop' | 'tool-calls' | 'max-tokens' | undefined
  let usage: TokenUsage | undefined

  const openBlock = (key: string, kind: OpenBlock['kind'], facts: Omit<OpenBlock, 'index' | 'kind'>): OpenBlock => {
    const created: OpenBlock = { index: nextIndex++, kind, ...facts }
    blocks.set(key, created)
    return created
  }

  for await (const event of events) {
    if (event === STREAM_DONE) {
      yield* close(blocks, finishKind, usage)
      return
    }
    if (typeof event !== 'object' || event === null) {
      throw new LlmError('GLM stream frame is not a JSON object', 'MALFORMED_RESPONSE')
    }
    const frame = event as WireFrame
    if (frame.error !== undefined) streamError(frame.error)
    if (frame.usage !== undefined) usage = mergeUsage(usage, frame.usage)
    const choices = frame.choices
    if (choices === undefined || choices.length === 0) continue
    if (choices.length > 1) {
      throw new LlmError(
        `GLM stream frame carried ${String(choices.length)} choices; at most one is expected`,
        'MALFORMED_RESPONSE',
      )
    }
    const choice = choices[0]
    if (choice === undefined) continue
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finishKind = stopReason(choice.finish_reason)
    }
    const delta = choice.delta
    if (delta === undefined) continue
    yield* deltaChunks(delta, blocks, keyByToolId, openBlock)
  }
  // The stream ended without the `[DONE]` marker.
  throw new LlmError('GLM stream closed before the [DONE] marker', 'STREAM_CLOSED')
}

/** Emit the chunks of one wire delta, synthesizing blocks as content appears. */
function* deltaChunks(
  delta: WireDelta,
  blocks: Map<string, OpenBlock>,
  keyByToolId: Map<string, string>,
  openBlock: (key: string, kind: OpenBlock['kind'], facts: Omit<OpenBlock, 'index' | 'kind'>) => OpenBlock,
): Generator<StreamChunk> {
  if (delta.reasoning_content !== undefined && delta.reasoning_content !== '') {
    let block = blocks.get('reasoning')
    if (block === undefined) {
      block = openBlock('reasoning', 'reasoning', { text: '' })
      yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
    }
    block.text += delta.reasoning_content
    yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning_content }
  }
  if (delta.content !== undefined && delta.content !== '') {
    let block = blocks.get('text')
    if (block === undefined) {
      block = openBlock('text', 'text', { text: '' })
      yield { type: 'block-start', index: block.index, blockType: 'text' }
    }
    block.text += delta.content
    yield { type: 'text-delta', index: block.index, text: delta.content }
  }
  for (const fragment of delta.tool_calls ?? []) {
    yield* toolCallChunk(fragment, blocks, keyByToolId, openBlock)
  }
}

/** Emit one tool-call fragment's chunk, synthesizing the call's block on first sight. */
function* toolCallChunk(
  fragment: WireToolCallDelta,
  blocks: Map<string, OpenBlock>,
  keyByToolId: Map<string, string>,
  openBlock: (key: string, kind: OpenBlock['kind'], facts: Omit<OpenBlock, 'index' | 'kind'>) => OpenBlock,
): Generator<StreamChunk> {
  const fallbackKey = `tool:${String(fragment.index ?? 0)}`
  const key = fragment.id !== undefined ? (keyByToolId.get(fragment.id) ?? fallbackKey) : fallbackKey
  let block = blocks.get(key)
  const name = fragment.function?.name
  const argsDelta = fragment.function?.arguments ?? ''
  if (block === undefined) {
    if (fragment.id === undefined || name === undefined || name === '') {
      throw new LlmError('GLM tool-call fragment arrived before its identity', 'MALFORMED_RESPONSE')
    }
    keyByToolId.set(fragment.id, key)
    block = openBlock(key, 'tool-call', { text: '', tool: { id: fragment.id, name, args: '' } })
    yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: block.index, id: ToolCallId(fragment.id), name, argumentsDelta: '' }
  }
  const tool = block.tool
  if (tool === undefined) throw new LlmError('GLM tool-call block lost its identity', 'MALFORMED_RESPONSE')
  if (name !== undefined && name !== tool.name) {
    throw new LlmError('GLM tool-call fragment changed the call name mid-stream', 'MALFORMED_RESPONSE')
  }
  if (argsDelta !== '') {
    tool.args += argsDelta
    yield { type: 'tool-call-delta', index: block.index, id: ToolCallId(tool.id), argumentsDelta: argsDelta }
  }
}

/** Map one wire stop reason onto a finish kind, or reject what GH cannot honor. */
function stopReason(reason: string): 'stop' | 'tool-calls' | 'max-tokens' {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool-calls'
  if (reason === 'length') return 'max-tokens'
  if (STOP_FINISH.has(reason)) return 'stop'
  // A provider-side refusal (for example content_filter) is a failure the
  // caller must see, not a silent empty success.
  throw new LlmError(`GLM finished with unsupported reason "${reason}"`, 'SERVER')
}

/** Merge one wire usage frame into the running total; the last frame wins per field. */
function mergeUsage(previous: TokenUsage | undefined, wire: NonNullable<WireFrame['usage']>): TokenUsage {
  const prompt = wire.prompt_tokens ?? previous?.inputTokens ?? 0
  const completion = wire.completion_tokens ?? previous?.outputTokens ?? 0
  const cached = wire.prompt_tokens_details?.cached_tokens ?? previous?.cacheReadTokens ?? 0
  const reasoning = wire.completion_tokens_details?.reasoning_tokens ?? previous?.reasoningTokens
  return {
    // inputTokens counts uncached input only; the wire total includes cache.
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
    totalTokens: wire.total_tokens ?? prompt + completion,
    ...cached === 0 ? {} : { cacheReadTokens: cached },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/** Close every open block, then emit usage and the single terminal finish. */
function* close(
  blocks: Map<string, OpenBlock>,
  finishKind: 'stop' | 'tool-calls' | 'max-tokens' | undefined,
  usage: TokenUsage | undefined,
): Generator<StreamChunk> {
  if (finishKind === undefined) {
    throw new LlmError('GLM stream ended without a finish_reason', 'MALFORMED_RESPONSE')
  }
  const ordered = [...blocks.values()].sort((a, b) => a.index - b.index)
  if (ordered.length === 0) {
    throw new LlmError('GLM response carried no content blocks', 'EMPTY_RESPONSE')
  }
  for (const block of ordered) {
    if (block.kind === 'tool-call') {
      const tool = block.tool
      if (tool === undefined) throw new LlmError('GLM tool-call block lost its identity', 'MALFORMED_RESPONSE')
      // No-argument calls legitimately arrive with empty arguments.
      const args = tool.args === '' ? '{}' : tool.args
      if (finishKind !== 'max-tokens' && !isObjectJson(args)) {
        throw new LlmError('GLM tool-call arguments are not a JSON object', 'MALFORMED_RESPONSE')
      }
      yield {
        type: 'block-end',
        index: block.index,
        block: { type: 'tool-call', id: ToolCallId(tool.id), name: tool.name, arguments: args },
      }
      continue
    }
    const assembled: ContentBlock = block.kind === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'reasoning', text: block.text }
    yield { type: 'block-end', index: block.index, block: assembled }
  }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: finishKind === 'tool-calls'
      ? { kind: 'tool-calls' }
      : finishKind === 'max-tokens'
        ? { kind: 'max-tokens' }
        : { kind: 'stop' },
  }
}

function isObjectJson(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}
