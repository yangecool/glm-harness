/**
 * The static GLM catalog. Numbers are sourced from the provider's public
 * documentation; until a controlled real-service verification runs (blocked
 * item D01), treat them as declared capabilities, not measured ones.
 */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId as effort } from '@deepseek-ai/dsh-llm'

/** One catalog entry's capability facts. */
export interface GlmCatalogModel {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Maximum context window in tokens. */
  readonly contextWindow: number
  /** Output budget requested when the caller sets none. */
  readonly defaultMaxTokens: number
  /** Whether the model exposes the GLM thinking switch. */
  readonly thinking: boolean
}

/**
 * Catalog models. GLM's thinking control is binary (`thinking.type` enabled
 * or disabled), which surfaces as the two selectable efforts below; the
 * greater id maps to enabled thinking.
 */
export const GLM_MODELS: readonly GlmCatalogModel[] = [
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    description: 'GLM-4.6 flagship reasoning model',
    contextWindow: 200_000,
    defaultMaxTokens: 8_192,
    thinking: true,
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM-4.5-Air',
    description: 'GLM-4.5 Air lightweight reasoning model',
    contextWindow: 128_000,
    defaultMaxTokens: 8_192,
    thinking: true,
  },
  {
    id: 'glm-4.5-flash',
    name: 'GLM-4.5-Flash',
    description: 'GLM-4.5 Flash fast model',
    contextWindow: 128_000,
    defaultMaxTokens: 8_192,
    thinking: true,
  },
] as const

/** Efforts of a thinking-capable GLM model: binary thinking mapped to off/high. */
export const GLM_THINKING_EFFORTS = [
  { id: effort('off'), name: 'Off', description: 'Thinking disabled for this request.' },
  { id: effort('high'), name: 'Thinking', description: 'GLM thinking enabled for this request.' },
] as const

/** Efforts of a model without the thinking switch: reasoning cannot be requested. */
export const GLM_OFF_ONLY_EFFORTS = [
  { id: effort('off'), name: 'Off', description: 'This model has no thinking switch.' },
] as const

/** Default effort ids per model class. */
export const GLM_THINKING_DEFAULT: ReasoningEffortId = effort('high')
