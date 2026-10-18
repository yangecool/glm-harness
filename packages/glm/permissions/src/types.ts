/**
 * Pure types of the GH permission domain: the ONE home of the `ghPermissions`
 * projection-key declaration plus its payload types, free of this package's
 * host-side value imports (cordis, schemastery). The package root re-exports
 * for host consumers and `./client` re-exports the same content for client
 * aggregates — zero duplication.
 *
 * @module @glm-harness/gh-permissions/types
 */

/** The three ZCode-aligned permission modes. */
export type GhPermissionMode = 'yolo' | 'guarded' | 'build'

/** Whole `ghPermissions` Session projection: the current effective mode. */
export interface GhPermissionSelection {
  /** The effective mode value: `yolo`, `guarded`, `build` — never a legacy alias. */
  readonly currentValue: GhPermissionMode
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current GH permission mode, folded from `permission/mode`
     * (plus legacy `permission/preset` migration) over the composition
     * default. Key absence means no GH permission service is composed —
     * clients hide the control.
     */
    ghPermissions: GhPermissionSelection
  }
}
