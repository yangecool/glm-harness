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
