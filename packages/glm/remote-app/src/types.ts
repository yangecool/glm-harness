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

/** One workspace the resident service knows, as `ghRemote/describe` reports it. */
export interface GhRemoteWorkspaceValue {
  /** The workspace registry's stable id. */
  readonly id: string
  /** The workspace's canonical directory. */
  readonly path: string
  /** The workspace's display title. */
  readonly title: string
}

/** The protocol/capability handshake `ghRemote/describe` answers. */
export interface GhRemoteDescribeValue {
  /** The data root's persistent runtime id; null when no root is configured. */
  readonly runtimeId: string | null
  /** The release the supervisor launched this service from; null when unsupervised. */
  readonly releaseId: string | null
  /** The current admission posture. */
  readonly admission: 'open' | 'closed'
  /** Capabilities this release advertises; clients gate on these before use. */
  readonly capabilities: readonly string[]
  /** Workspaces the service currently knows. */
  readonly workspaces: readonly GhRemoteWorkspaceValue[]
}

/** The posture answer `ghRemote/admission` returns. */
export interface GhRemoteAdmissionValue {
  /** The admission posture now in force. */
  readonly admission: 'open' | 'closed'
}
