/**
 * Request serialization: one frozen {@link GenerateOptions} (files, images,
 * and developer tool updates already projected by the runtime) becomes a
 * fresh GLM chat-completions body. History is never mutated.
 */

import type { ContentBlock, GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { GlmCatalogModel } from './models.ts'
import type { WireMessage, WireRequest, WireTool, WireToolCall } from './wire-types.ts'

/** The reasoning decision for one request, derived from model facts.
 * @param reasoningEffort - selected effort, absent when the caller leaves it unset.
 * @param thinkingCapable - whether this model supports the thinking switch.
 * @returns the explicit switch, or undefined when it must be omitted.
 */
export function thinkingRequest(
  reasoningEffort: string | undefined,
  thinkingCapable: boolean,
): { type: 'enabled' } | { type: 'disabled' } | undefined {
  if (!thinkingCapable) return undefined
  if (reasoningEffort === undefined) return undefined
  return reasoningEffort === 'off' ? { type: 'disabled' } : { type: 'enabled' }
}

/**
 * Serialize one model request.
 *
 * @param options - the frozen request options.
 * @param catalog - capability facts of the exact model.
 * @returns the wire body, ready to JSON-stringify.
 */
export function serialize(options: GenerateOptions, catalog: Pick<GlmCatalogModel, 'thinking'>): WireRequest {
  const wireMessages: WireMessage[] = []
  for (const message of options.messages) {
    switch (message.role) {
      case 'system': {
        wireMessages.push({ role: 'system', content: joinText(message.content) })
        continue
      }
      case 'user': {
        wireMessages.push({ role: 'user', content: joinText(message.content) })
        continue
      }
      case 'assistant': {
        const text: string[] = []
        const reasoning: string[] = []
        const toolCalls: WireToolCall[] = []
        for (const block of message.content) {
          if (block.type === 'text') text.push(block.text)
          else if (block.type === 'reasoning'
            && message.source.provider === options.provider
            && message.source.model === options.model) reasoning.push(block.text)
          else if (block.type === 'tool-call') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: block.arguments },
            })
          }
        }
        wireMessages.push({
          role: 'assistant',
          content: text.join('\n'),
          ...reasoning.length === 0 ? {} : { reasoning_content: reasoning.join('') },
          ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
        })
        continue
      }
      case 'tool': {
        wireMessages.push({ role: 'tool', tool_call_id: message.toolCallId, content: joinText(message.content) })
        continue
      }
      default:
        // Developer tool updates are projected away before serialization;
        // any other role is a protocol drift the caller must hear about.
        continue
    }
  }
  if (options.system !== undefined) {
    // A one-shot system prompt folds into the history's leading system slot,
    // or opens one when the history carries none.
    if (wireMessages[0]?.role === 'system') {
      wireMessages[0] = { role: 'system', content: joinSystem(options.system, wireMessages[0].content) }
    } else {
      wireMessages.unshift({ role: 'system', content: options.system })
    }
  }
  const body: WireRequest = {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: wireMessages,
  }
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.stop !== undefined && options.stop.length > 0) body.stop = [...options.stop]
  if (options.tools !== undefined && options.tools.length > 0) body.tools = options.tools.map(serializeTool)
  const thinking = thinkingRequest(options.reasoningEffort, catalog.thinking)
  if (thinking !== undefined) body.thinking = thinking
  return body
}

/** One tool schema as the wire's function-tool declaration. */
function serializeTool(tool: ToolSchema): WireTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** Join the text blocks of one message; non-text blocks have no wire form here. */
function joinText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

function joinSystem(oneShot: string, history: string): string {
  return history === '' ? oneShot : `${oneShot}\n\n${history}`
}
