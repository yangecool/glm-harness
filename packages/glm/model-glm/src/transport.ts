/**
 * Error normalization for GLM chat-completions responses: HTTP statuses and
 * OpenAI-style error bodies become the harness's canonical failure codes with
 * the provider's retry-after and request-id facts attached.
 */

import {
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  ProviderRequestId,
} from '@deepseek-ai/dsh-llm'

/** Terminal code when the stream ends before the `[DONE]` marker. */
export const GLM_STREAM_CLOSED_CODE = 'STREAM_CLOSED'

/** Terminal code when the output limit cuts a response that carries tool calls. */
export const GLM_TRUNCATED_TOOL_CALLS_CODE = 'TRUNCATED_TOOL_CALLS'

/** The subset of `Headers` read for error facts. */
export interface ErrorHeaderReader {
  get(name: string): string | null
}

/**
 * Classify one non-2xx GLM response into a terminal {@link LlmError}.
 *
 * @param bodyText - the raw response body text, parsed tolerantly.
 * @param status - HTTP status code.
 * @param headers - response headers, for retry-after and request-id.
 * @returns never; always throws the classified error.
 */
export function providerError(bodyText: string, status: number, headers: ErrorHeaderReader): never {
  const detail = errorDetail(bodyText)
  const joined = [String(status), detail.code, detail.type, detail.message].filter(Boolean).join(' ')
  const providerRetryAfterMs = retryAfterMs(headers.get('retry-after'))
  const rawRequestId = headers.get('request-id') ?? headers.get('x-request-id')
  const options = {
    status,
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
    ...rawRequestId === null ? {} : { requestId: ProviderRequestId(rawRequestId) },
  }
  if (status === 401 || status === 403) {
    throw new LlmError(detail.message || `GLM request rejected with HTTP ${String(status)}`, 'AUTH', options)
  }
  if (isQuotaExceededError(joined)) {
    throw new LlmError(detail.message || 'GLM quota exceeded', 'QUOTA', options)
  }
  if (status === 429) {
    throw new LlmError(detail.message || 'GLM rate limit exceeded', 'RATE_LIMIT', options)
  }
  if (isContextWindowExceededError(joined)) {
    throw new LlmError(detail.message || 'GLM context window exceeded', 'CONTEXT_WINDOW_EXCEEDED', options)
  }
  if (status === 400 || status === 413) {
    throw new LlmError(detail.message || `GLM rejected the request with HTTP ${String(status)}`, 'INVALID_REQUEST', options)
  }
  if (status >= 500) {
    throw new LlmError(detail.message || `GLM server error HTTP ${String(status)}`, 'SERVER', options)
  }
  throw new LlmError(detail.message || `GLM request failed with HTTP ${String(status)}`, `HTTP_${String(status)}`, options)
}

/**
 * Classify an in-band error frame (a streamed `{"error": ...}` event).
 *
 * @param payload - the parsed `error` field of the frame.
 * @returns never; always throws.
 */
export function streamError(payload: unknown): never {
  const detail = typeof payload === 'object' && payload !== null
    ? payload as { code?: unknown; message?: unknown }
    : {}
  const message = typeof detail.message === 'string' && detail.message !== '' ? detail.message : 'GLM stream error'
  const code = typeof detail.code === 'string' ? detail.code : undefined
  const joined = [code, message].filter(Boolean).join(' ')
  if (isQuotaExceededError(joined)) throw new LlmError(message, 'QUOTA')
  if (isContextWindowExceededError(joined)) throw new LlmError(message, 'CONTEXT_WINDOW_EXCEEDED')
  throw new LlmError(message, 'SERVER')
}

/** Tolerantly extract the provider's error message/code/type from a body. */
function errorDetail(bodyText: string): { message: string; code?: string; type?: string } {
  try {
    const parsed: unknown = JSON.parse(bodyText)
    const carrier = typeof parsed === 'object' && parsed !== null
      ? ((parsed as { error?: unknown }).error ?? parsed)
      : null
    if (typeof carrier === 'object' && carrier !== null) {
      const fields = carrier as { message?: unknown; code?: unknown; type?: unknown; msg?: unknown }
      return {
        message: typeof fields.message === 'string'
          ? fields.message
          : typeof fields.msg === 'string' ? fields.msg : '',
        ...typeof fields.code === 'string' ? { code: fields.code } : {},
        ...typeof fields.type === 'string' ? { type: fields.type } : {},
      }
    }
  } catch {
    // Not JSON: fall back to the raw text, trimmed.
  }
  return { message: bodyText.trim().slice(0, 400) }
}

/** Parse a positive provider delay; zero/expired hints impose no additional minimum. */
function retryAfterMs(raw: string | null): number | undefined {
  const value = raw?.trim()
  if (value === undefined || value === '') return undefined
  const delay = /^\d+$/.test(value)
    ? Number(value) * 1_000
    : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}
