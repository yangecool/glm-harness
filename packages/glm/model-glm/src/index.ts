/**
 * The `glm` provider route: registers the GLM chat-completions adapter with
 * the LLM runtime. The API key is resolved per request through the
 * credentials service (falling back to the launch environment) and never
 * cached; a missing key is the documented explicit MISSING_CREDENTIAL
 * failure, never an upstream fallback.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { GlmChatAdapter } from './adapter.ts'
import { Config, plainOptions, resolveAdapterOptions, type GlmConnectionOptions } from './config.ts'

export { Config, plainOptions, resolveAdapterOptions } from './config.ts'
export type { Options, GlmConnectionOptions } from './config.ts'
export { GLM_DEFAULT_RETRY_POLICY, PUBLIC_BASE_URL, BASE_URL_ENV } from './config.ts'
export { GlmChatAdapter, GLM_IDLE_CODE } from './adapter.ts'
export type { GlmAdapterOptions } from './adapter.ts'
export { GLM_MODELS } from './models.ts'
export { serialize, thinkingRequest } from './serialize.ts'
export { parseSseFrames, type SseFrame } from './sse.ts'
export { translate } from './translate.ts'
export {
  GLM_STREAM_CLOSED_CODE,
  GLM_TRUNCATED_TOOL_CALLS_CODE,
  providerError,
  streamError,
} from './transport.ts'

export const name = 'model-glm'
export const inject = ['llm']

/** The provider route this adapter owns; `agent-default-model` names it. */
export const PROVIDER = 'glm'

/** The PAT owner's face this route consults; structurally typed so the account package stays optional. */
interface GhProjectTokenOwner {
  resolvePat(domain: 'bigmodel' | 'zai', projectId: string, signal?: AbortSignal): Promise<string>
  rejectPat(token: string): void
}

export function apply(ctx: Context, config: Config): void {
  const options = (): GlmConnectionOptions => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx))
  options()

  const resolveApiKey = async (connection: GlmConnectionOptions): Promise<string> => {
    // The account path first: when PAT preference is on and an account is
    // logged in, each physical attempt carries a fresh-enough short-term
    // project token. A logged-out domain falls through to the static key
    // path below, never to an upstream fallback.
    const plain = plainOptions(config)
    if (plain.preferAccountPat === true) {
      const tokens = ctx.get('ghProjectToken') as GhProjectTokenOwner | undefined
      if (tokens !== undefined) {
        try {
          return await tokens.resolvePat(plain.accountDomain ?? 'bigmodel', plain.patProjectId ?? '')
        } catch (error) {
          if ((error as { code?: string }).code !== 'gh-account/not-logged-in') throw error
        }
      }
    }
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'model-glm', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'model-glm', ref)
    }
    throw new LlmError(
      `model-glm: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  ctx.llm.registerAdapter([PROVIDER], new GlmChatAdapter({
    options,
    resolveApiKey,
    onAuthRejection: (credential: string): void => {
      const tokens = ctx.get('ghProjectToken') as GhProjectTokenOwner | undefined
      tokens?.rejectPat(credential)
    },
  }))
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'GLM', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] },
  ])
}
