/**
 * Wire shapes of the GLM v4 chat-completions protocol (BigModel / Z.AI
 * `POST /chat/completions`, OpenAI-compatible). These types describe what GH
 * sends and what GH chooses to read from responses; unknown response fields
 * are ignored for forward compatibility, so they are deliberately not
 * exhaustive mirrors of the provider's schema.
 */

/** One function-tool declaration as sent on the wire. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One assistant-requested tool call as sent back in history. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** Raw JSON string of the arguments. */
    arguments: string
  }
}

/** Message roles of the wire protocol; developer/tool-change updates never reach this wire. */
export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning_content?: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * The request body. `stream` is always true — the harness consumes models as
 * streams only — and `stream_options.include_usage` asks for the final usage
 * frame the token accounting reads.
 */
export interface WireRequest {
  model: string
  stream: true
  stream_options: { include_usage: true }
  messages: WireMessage[]
  max_tokens?: number
  temperature?: number
  stop?: string[]
  tools?: WireTool[]
  /** GLM thinking switch; present only for thinking-capable models. */
  thinking?: { type: 'enabled' } | { type: 'disabled' }
}

/** One streamed tool-call fragment; `index` identifies the call across fragments. */
export interface WireToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** The `choices[0].delta` object of one streamed frame. */
export interface WireDelta {
  role?: string
  content?: string | null
  /** GLM reasoning output, retained for same-provider/model tool continuation. */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** Usage facts of the final frames. */
export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** One streamed chat-completions frame, already JSON-parsed. */
export interface WireFrame {
  choices?: {
    index?: number
    delta?: WireDelta
    finish_reason?: string | null
  }[]
  usage?: WireUsage
  error?: unknown
}

/** Terminal marker carried as the final SSE data payload. */
export const STREAM_DONE = '[DONE]'
