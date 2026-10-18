/**
 * @glm-harness/gh-remote-app — the GH resident remote-service surface.
 *
 * The bundle patch disables the browser-facing rows of the dsh web transport
 * (static client, module graph, HMR, client runner) plus the inherited
 * telemetry, analytics, and account rows, leaving a minimal headless RPC
 * service: webserver + gateway + session/job/terminal/workspace controllers.
 * This module owns what that stripped surface still must do itself: print the
 * readiness announce line (`gh-remote ready: <authenticated URL>`) after the
 * Loader tree settles — the same contract supervisors observe — and expose
 * the `ghRemote/identity` Remote method clients query before attaching.
 * @module @glm-harness/gh-remote-app
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import { GhAccountRpcService } from './account-rpc.ts'
import type { GhRemoteActivity, GhRemoteIdentity } from './types.ts'

/** Identity facts fixed for the process lifetime. */
const STARTED_AT = new Date().toISOString()

/** The `ghRemote` Remote namespace: what a connecting client asks before attaching. */
export class GhRemoteIdentityService extends TypertRemoteService {
  static inject = ['agents']

  constructor(ctx: Context) {
    super(ctx, 'ghRemoteIdentity', { namespace: 'ghRemote' })
  }

  /**
   * Report the resident service's identity.
   * @returns product, runtime, and process facts a client pins before attaching.
   */
  @Remote
  identity(): GhRemoteIdentity {
    return {
      product: 'GLM Harness',
      profile: 'gh-remote',
      runtimeVersion: getDshRuntimeVersion(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      startedAt: STARTED_AT,
    }
  }

  /**
   * Report execution activity: the running-agent count a supervisor's drain
   * gate polls before a version switch.
   * @returns running-agent counts and the composed providers' owned activity.
   */
  @Remote
  async activity(): Promise<GhRemoteActivity> {
    const agents = this.ctx.agents.list()
    const activity = await Promise.all(agents.map(async agent =>
      (await agent.ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([]))).length
        + (agent.inbox.nextTurn.length + agent.inbox.nextStep.length > 0 ? 1 : 0)))
    return {
      runningAgents: agents.filter(agent => agent.status === 'running').length,
      agents: agents.length,
      ownedActivity: activity.reduce((total, count) => total + count, 0),
    }
  }
}

/** The bundle plugin's configuration. */
export interface Config {
  /** Whether the readiness line prints the authenticated URL on stdout. */
  printUrl: boolean
}

/** The bundle plugin: announce readiness and mount the identity namespace. */
export class GhRemoteApp extends Service {
  static inject = ['webServer', 'connection']

  static Config = z.object({
    /** Whether the readiness line prints the authenticated URL on stdout. */
    printUrl: z.boolean().default(true),
  })

  /** Whether the readiness line prints the authenticated URL on stdout. */
  readonly printUrl: boolean

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ghRemoteApp')
    this.printUrl = config.printUrl
    this.ctx.plugin(GhRemoteIdentityService)
    this.ctx.plugin(GhAccountRpcService)
    // The disabled web-runtime row leaves the webserver fallback seat and the
    // root token exchange unclaimed. Claim the seat with the minimum a headless
    // RPC service needs: authorizeIndex mints the session cookie from the root
    // launch token (and rejects everything else); an already-authenticated root
    // gets an explicit no-static answer instead of a client that is not there.
    this.ctx.effect(() => this.ctx.webServer.registerFallback((req, res) => {
      if (this.ctx.connection.authorizeIndex(req, res)) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('gh-remote: no static client; use /api with the session cookie')
      }
    }))
    const connectionCtx = this.ctx
    // The announce line is the readiness signal: supervisors RPC as soon as
    // they observe it, exactly like the dsh web line it replaces. It must not
    // run while sibling rows are still mounting, so it waits for Loader
    // settlement (a hand-built tree without a Loader is already complete),
    // and stays unpublished when the tree died before serving.
    const announce = (): void => {
      const origin = this.ctx.webServer.getOrigin()
      const authenticated = this.ctx.connection.authenticatedUrl(origin)
      if (this.printUrl) console.log(`gh-remote ready: ${authenticated}`)
    }
    const settled = connectionCtx.get('loader')?.await()
    if (settled === undefined) announce()
    else {
      void settled.then(() => {
        if (connectionCtx.get('webServer') !== undefined && connectionCtx.get('connection') !== undefined) announce()
      }).catch(() => {
        // Boot owns the failure diagnostic; readiness stays unpublished.
      })
    }
  }
}

export default GhRemoteApp
