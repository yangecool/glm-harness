/**
 * The GLM chat-completions adapter: one {@link LlmAdapter} owning the `glm`
 * provider route. Every HTTP request carries the harness attribution headers,
 * honors the caller's abort signal, and is bounded by a stream idle watchdog;
 * capability answers (catalog, exact model resolution) and dispatch share one
 * connection snapshot.
 */

import {
  attributionHeaders,
  LlmError,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { deadline, idleWatchdog, TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { chatCompletionsUrl, type GlmConnectionOptions } from './config.ts'
import {
  GLM_MODELS,
  GLM_OFF_ONLY_EFFORTS,
  GLM_THINKING_DEFAULT,
  GLM_THINKING_EFFORTS,
  type GlmCatalogModel,
} from './models.ts'
import { serialize } from './serialize.ts'
import { parseSseFrames } from './sse.ts'
import { providerError } from './transport.ts'
import { translate } from './translate.ts'

/** Watchdog code carried by an idle GLM stream timeout. */
export const GLM_IDLE_CODE = 'GLM_STREAM_IDLE'
/** Deadline code for credential lookup and the HTTP response prelude. */
export const GLM_REQUEST_TIMEOUT_CODE = 'GLM_REQUEST_TIMEOUT'

/** Adapter-local dependencies injected by the plugin. */
export interface GlmAdapterOptions {
  /** One connection snapshot per read; capability answers and dispatch of one call share one generation. */
  readonly options: () => GlmConnectionOptions
  /** Per-request bearer key; throws MISSING_CREDENTIAL-style failures. */
  readonly resolveApiKey: (connection: GlmConnectionOptions) => Promise<string>
  /** Called with the bearer credential an AUTH rejection carried; optional. */
  readonly onAuthRejection?: (credential: string) => void
}

/** The GLM provider adapter. */
export class GlmChatAdapter extends LlmAdapter {
  private readonly dependencies: GlmAdapterOptions

  constructor(dependencies: GlmAdapterOptions) {
    super()
    this.dependencies = dependencies
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'GLM' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.dependencies.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(GLM_MODELS.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: model.description,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.defaultMaxTokens,
      inputModalities: ['text'],
      reasoning: {
        efforts: model.thinking ? [...GLM_THINKING_EFFORTS] : [...GLM_OFF_ONLY_EFFORTS],
        defaultEffort: model.thinking ? GLM_THINKING_DEFAULT : undefined,
      },
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(exactModel(provider, model, catalogEntry(model)))
  }

  override prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const connection = this.dependencies.options()
    const entry = catalogEntry(model)
    return Promise.resolve({
      model: exactModel(provider, model, entry),
      stream: options => this.generate(options, connection, entry),
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.dependencies.options()
    return this.generate(options, connection, catalogEntry(options.model))
  }

  /** Run one request to its terminal chunk, mapping transport failures to terminal codes. */
  private async *generate(
    options: GenerateOptions,
    connection: GlmConnectionOptions,
    entry: GlmCatalogModel,
  ): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, GLM_IDLE_CODE)
    try {
      yield* this.request(options, connection, entry, watchdog)
    } catch (error: unknown) {
      throw generateError(error, watchdog.signal)
    } finally {
      consumer.abort()
    }
  }

  private async *request(
    options: GenerateOptions,
    connection: GlmConnectionOptions,
    entry: GlmCatalogModel,
    watchdog: ReturnType<typeof idleWatchdog>,
  ): AsyncGenerator<StreamChunk> {
    const response = await this.openResponse(options, connection, entry, watchdog.signal)
    if (response.body === null) {
      throw new LlmError('GLM response carried no body', 'MALFORMED_RESPONSE')
    }
    const frames = parseJsonFrames(parseSseFrames(response.body, () => { watchdog.pulse() }))
    const iterator = translate(frames)[Symbol.asyncIterator]()
    while (true) {
      const next = await watchdog.next(iterator)
      if (next.done) return
      yield next.value
    }
  }

  /** Resolve credentials and receive headers within one disposable deadline. */
  private async openResponse(
    options: GenerateOptions,
    connection: GlmConnectionOptions,
    entry: GlmCatalogModel,
    signal: AbortSignal,
  ): Promise<Response> {
    using initial = deadline(signal, connection.requestTimeoutMs, GLM_REQUEST_TIMEOUT_CODE)
    const key = await abortable(initial.signal, () => this.dependencies.resolveApiKey(connection))
    const body = JSON.stringify(serialize(options, entry))
    const response = await abortable(initial.signal, () => fetch(chatCompletionsUrl(connection.baseURL), {
      method: 'POST',
      signal: initial.signal,
      body,
      redirect: 'error',
      headers: {
        ...attributionHeaders(),
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${key}`,
      },
    }))
    if (!response.ok) {
      const errorBody = await abortable(initial.signal, () => response.text())
      try {
        providerError(errorBody, response.status, response.headers)
      } catch (error) {
        // An authorization rejection also retires the credential it carried:
        // the PAT owner drops it so the next physical attempt mints fresh.
        if (error instanceof LlmError && error.failure.code === 'AUTH') this.dependencies.onAuthRejection?.(key)
        throw error
      }
    }
    return response
  }
}

/** Cancel this wait without cancelling another caller's shared credential lookup. */
async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const onAbort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation(), cancelled.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Parse each SSE frame's data payload as JSON; `[DONE]` passes through as-is. */
async function* parseJsonFrames(frames: AsyncIterable<{ data: string }>) {
  for await (const frame of frames) {
    if (frame.data === '[DONE]') {
      yield frame.data
      continue
    }
    try {
      yield JSON.parse(frame.data) as unknown
    } catch {
      throw new LlmError('GLM stream frame is not valid JSON', 'MALFORMED_RESPONSE')
    }
  }
}

/** Terminal-code mapping for one failed generation. */
function generateError(error: unknown, signal: AbortSignal): unknown {
  if (error instanceof LlmError) return error
  if (error instanceof TimeoutReason
    && (error.code === GLM_IDLE_CODE || error.code === GLM_REQUEST_TIMEOUT_CODE)) {
    return new LlmError(`GLM request exceeded its configured timeout: ${error.message}`, 'TIMEOUT')
  }
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new LlmError('GLM request aborted by the caller', 'ABORTED')
  }
  return new LlmError(
    `GLM transport failure: ${error instanceof Error ? error.message : String(error)}`,
    'TRANSPORT',
  )
}

/** Catalog entry of one model id; unknown ids fail before provider I/O. */
function catalogEntry(model: string): GlmCatalogModel {
  const entry = GLM_MODELS.find(candidate => candidate.id === model)
  if (entry === undefined) {
    throw new LlmError(`GLM model "${model}" is not configured; select a catalog model`, 'UNSUPPORTED_MODEL')
  }
  return entry
}

/** Exact model metadata of one catalog entry. */
function exactModel(provider: string, model: string, entry: GlmCatalogModel): LlmResolvedModelInfo {
  return {
    provider,
    id: model,
    name: entry.name,
    ...entry.description === '' ? {} : { description: entry.description },
    context: { contextWindow: entry.contextWindow },
    defaultMaxTokens: entry.defaultMaxTokens,
    inputModalities: ['text'],
    reasoning: {
      efforts: entry.thinking ? [...GLM_THINKING_EFFORTS] : [...GLM_OFF_ONLY_EFFORTS],
      ...entry.thinking ? { defaultEffort: GLM_THINKING_DEFAULT } : {},
    },
  }
}
