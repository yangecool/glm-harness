/**
 * The resident service's drain control state: the new-admission gate a
 * supervisor closes before a version switch, plus the handshake facts the
 * `ghRemote/describe` RPC reports. The gate refuses only NEW prompts — a
 * drain converges while in-flight turns finish, and reconciled replays
 * (`session/admission` queries, idempotent re-sends) stay answerable — so an
 * interrupted client can always learn what became of its request.
 *
 * @module @glm-harness/gh-remote-app/control
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ghRemoteControl: GhRemoteControlService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'gh-remote/admission-closed': Record<string, never>
  }
}

/** The resident service's admission posture. */
export type GhAdmissionState = 'open' | 'closed'

/**
 * The drain control owner: holds the admission posture and denies new prompts
 * while closed. A fresh process always boots open — closing is a drain-time
 * state a supervisor sets through `ghRemote/admission` right before it waits
 * for owned activity to reach zero.
 */
export class GhRemoteControlService extends Service {
  private closed = false

  constructor(ctx: Context) {
    super(ctx, 'ghRemoteControl')
    this.ctx.on('session/new-prompt', async (_request, next) => {
      if (this.closed) {
        throw new RemoteError(
          'gh-remote/admission-closed',
          'the resident service closed new admissions for a version switch; retry once it reconnects',
          {},
        )
      }
      await next()
    })
  }

  /**
   * The current admission posture.
   * @returns whether new prompts are being admitted.
   */
  admissionState(): GhAdmissionState {
    return this.closed ? 'closed' : 'open'
  }

  /**
   * Change the admission posture.
   * @param state - the posture to adopt.
   */
  setAdmission(state: GhAdmissionState): void {
    this.closed = state === 'closed'
  }
}
