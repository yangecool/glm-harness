/** Remote boundary types for the ghRemote identity namespace. */

/** One identity snapshot returned by `ghRemote/identity`. */
export interface GhRemoteIdentity {
  readonly product: 'GLM Harness'
  readonly profile: 'gh-remote'
  readonly runtimeVersion: string
  readonly node: string
  readonly platform: string
  readonly arch: string
  readonly pid: number
  readonly startedAt: string
}

/** Execution activity returned by `ghRemote/activity` for drain decisions. */
export interface GhRemoteActivity {
  /** Agents currently inside a turn, including ones waiting on an approval or an answer. */
  readonly runningAgents: number
  /** Live agent sessions, running or idle. */
  readonly agents: number
  /** Activity families reported by composed providers, plus pending Agent inboxes. */
  readonly ownedActivity: number
}

/** One account login's begin answer over the ghAccount namespace. */
export interface GhAccountLoginBeginValue {
  /** The URL whose visit authorizes this login. */
  readonly verificationUrl: string
  /** When the pending authorization expires, epoch milliseconds. */
  readonly expiresAt: number
}

/** The account facts every ghAccount/status answer carries, token-free. */
export interface GhAccountStatusValue {
  /** One snapshot per configured domain, logged-out domains included. */
  readonly accounts: ReadonlyArray<{
    readonly domain: 'bigmodel' | 'zai'
    readonly accountId: string
    readonly plan: string | null
    readonly epoch: number
    readonly accessExpiresAt: number
  }>
}
