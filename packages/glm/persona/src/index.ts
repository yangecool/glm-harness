/**
 * The GLM Harness model identity and work policy.
 *
 * The deployment composes `dsh-system-prompt` with `includeHarnessIdentity:
 * false`; this plugin then owns the harness identity section and adds the GLM
 * work policy in the deployment-persona prefix slot, so both carry one owner
 * and disposing the plugin removes them together. The sections are static
 * text: the prompt prefix stays byte-stable across turns, and they name no
 * tool, platform, directory, or permission — the tool catalog and runtime
 * context own those facts, so the policy never promises an uncomposed
 * capability.
 *
 * @module @glm-harness/gh-persona
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'gh-persona'

/** The prompt registry this plugin contributes to. */
export const inject = ['systemPrompt']

/** Section name of the GLM Harness identity statement. */
export const GH_IDENTITY_SECTION = 'glm:identity'

/** Section name of the GLM work policy. */
export const GH_WORK_POLICY_SECTION = 'glm:work-policy'

/** The identity statement rendered before every other section. */
export const GH_IDENTITY_TEXT = 'You are an AI coding agent powered by GLM Harness.'

/** The GLM work policy, rendered in the deployment-persona prefix slot. */
export const GH_WORK_POLICY_TEXT = [
  'Work toward the user\'s stated goal. Before changing anything, build a concrete picture of the relevant code: read the files you need and search narrowly, preferring facts from the repository over assumptions.',
  'Make minimal, reviewable changes that follow the existing structure and conventions, and be ready to state what changed and why.',
  'Verify your own work before reporting completion: re-read what you edited, and run available checks or tests through your tools. Report failures honestly, and name any verification you could not run.',
  'Use tools exactly as their schemas describe. Read the least that answers the question, return to a file only when new information requires it, and never repeat a call that already failed the same way.',
  'Your tools and permissions list what you may actually do. Do not claim or attempt capabilities the current tool catalog does not grant, and do not present guessed results as observed ones.',
  'Ask the user only for decisions that are genuinely theirs; resolve discoverable facts yourself from the repository.',
].join('\n')

/**
 * Register the identity and work-policy sections in the calling context's scope.
 * @param ctx - a context whose `systemPrompt` service is available.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: GH_IDENTITY_SECTION,
    order: ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY'),
    text: GH_IDENTITY_TEXT,
  }), 'gh-persona: identity section')
  ctx.effect(() => ctx.systemPrompt.section({
    name: GH_WORK_POLICY_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: GH_WORK_POLICY_TEXT,
  }), 'gh-persona: work-policy section')
}
