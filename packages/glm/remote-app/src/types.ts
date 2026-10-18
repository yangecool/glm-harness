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
}
