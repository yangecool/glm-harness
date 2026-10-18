/**
 * The `ghAccount` Remote namespace: the account lifecycle a connected client
 * drives over the resident service's RPC surface. Login is two steps —
 * `beginLogin` returns the authorization URL for the user, `completeLogin`
 * finishes the code exchange — because the authorizing browser and the RPC
 * client are different processes by design. Every response is token-free:
 * snapshots carry identity, plan, and generation facts only.
 *
 * @module @glm-harness/gh-remote-app/account-rpc
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@glm-harness/gh-account/service'
import type { GhAccountDomain, GhAccountSnapshot } from '@glm-harness/gh-account/types'
import type { GhAccountLoginBeginValue, GhAccountStatusValue } from './types.ts'

/** The remote-driven account lifecycle over the ghAccount namespace. */
export class GhAccountRpcService extends TypertRemoteService {
  static inject = ['ghAccount']

  constructor(ctx: Context) {
    super(ctx, 'ghAccountRpc', { namespace: 'ghAccount' })
  }

  /**
   * Report every configured domain's account state.
   * @returns one token-free snapshot per domain.
   */
  @Remote
  status(): GhAccountStatusValue {
    return {
      accounts: this.ctx.ghAccount.configuredDomains().map(domain => this.ctx.ghAccount.snapshot(domain)),
    }
  }

  /**
   * Begin one interactive login.
   * @param request - the domain and the redirect URL the issuer returns to.
   * @returns the authorization URL and the pending login's deadline.
   */
  @Remote
  beginLogin(request: { domain: GhAccountDomain; redirectUrl: string }): GhAccountLoginBeginValue {
    return this.ctx.ghAccount.beginLogin(request.domain, request.redirectUrl)
  }

  /**
   * Finish one interactive login with the redirected code and state.
   * @param request - the domain, code, state, and the same redirect URL.
   * @returns the logged-in snapshot.
   */
  @Remote
  async completeLogin(request: {
    domain: GhAccountDomain
    code: string
    state: string
    redirectUrl: string
  }): Promise<GhAccountSnapshot> {
    const outcome = await this.ctx.ghAccount.completeLogin(request.domain, request.code, request.state, request.redirectUrl)
    return outcome.snapshot
  }

  /**
   * Drop one domain's grant.
   * @param request - the domain to log out.
   */
  @Remote
  async logout(request: { domain: GhAccountDomain }): Promise<void> {
    await this.ctx.ghAccount.logout(request.domain)
  }
}
