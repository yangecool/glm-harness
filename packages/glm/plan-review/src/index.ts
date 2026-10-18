/**
 * GH plan-review ledger. Upstream plan mode owns the mode toggle, the
 * model-facing `exit_plan_mode` tool, and the review question; this plugin
 * owns the durable record around each review: every presented plan becomes a
 * numbered revision under the session log, an approval writes the approved
 * text to a deterministic workspace plan file (atomically, and never over an
 * externally edited file), and every outcome — approval, keep-planning with
 * feedback, dismissal, or failure — is appended bound to its revision.
 *
 * The plugin is a pure observer of the tool pipeline: it replaces no tool
 * result and prompts no second question. It watches the plan-review question
 * flow through `user-questions/request` to learn whether a call actually
 * reached the user, then records the outcome from `tools/post-execute`.
 * Validation failures that never reached the review leave no events at all.
 *
 * X05 (late-result) semantics: approvals are monotonic. The fold accepts an
 * approval only for a revision at least as new as the recorded one, so a
 * replayed older approval — reconnect redelivery, fork inheritance, or an
 * in-flight answer racing a newer submission — updates nothing. The same
 * rule protects the plan file: an approval rewrites it only while its
 * content is still what this session last wrote, so user edits always win.
 *
 * See packages/glm/plan-review/README.md.
 *
 * @module @glm-harness/gh-plan-review
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ghPlanReview: GhPlanReviewService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One plan revision was presented for review: log-only, non-surface.
     * Revisions are positive and monotonic per session; a log with none has
     * no plan-review history. `planPath` is null when the session has no
     * workspace cwd, in which case no plan file exists for any revision.
     */
    'gh-plan/submitted': { revision: number; planPath: string | null; planSha256: string }
    /**
     * One plan revision was approved and the plan-mode exit proceeded:
     * log-only, non-surface. `fileWritten` records whether the plan file was
     * (re)written; false means either no workspace cwd, a write failure, or a
     * preserved external edit — the approval itself is unaffected either way.
     */
    'gh-plan/approved': { revision: number; planPath: string | null; planSha256: string; fileWritten: boolean }
    /**
     * One plan revision finished without approval: log-only, non-surface.
     * `keep-planning` carries the reviewer's free-text feedback verbatim (the
     * plan annotation), `dismissed` means the user took the turn back, and
     * `failed` records an aborted or errored review honestly.
     */
    'gh-plan/rejected': { revision: number; outcome: 'keep-planning' | 'dismissed' | 'failed'; feedback: string | null }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Plan-review ledger wire view for clients. */
    ghPlanReview: GhPlanReviewView
  }

  interface SessionProjectionStateMap {
    /** Plan-review revision ledger folded from `gh-plan/*` events. */
    ghPlanReview: GhPlanReviewUnitState
  }
}

/** Why a presented plan finished without approval. */
export type GhPlanRejectionOutcome = 'keep-planning' | 'dismissed' | 'failed'

/** Plugin config: where plan files live inside the session's workspace cwd. */
export interface GhPlanReviewConfig {
  /**
   * Workspace-relative directory for plan files, joined onto the session's
   * header cwd. Must be a plain relative path: no absolute form, no `..`
   * segments, no platform separators.
   */
  readonly plansDir: string
}

/** Projection state: the revision ledger and the last plan file this session wrote. */
export interface GhPlanReviewUnitState {
  /** One past the newest submitted revision; `1` before any submission. */
  readonly nextRevision: number
  /** Revision of the newest accepted approval; null before any. */
  readonly approvedRevision: number | null
  /** SHA-256 of the plan text this session last wrote to the plan file; null if it never wrote. */
  readonly writtenSha256: string | null
  /** Newest non-null plan path seen; null when the session has no workspace cwd. */
  readonly planPath: string | null
}

/** Wire view of the plan-review ledger. */
export interface GhPlanReviewView {
  /** Newest submitted revision; `0` before any submission. */
  readonly revision: number
  /** Revision of the newest approval; null before any. */
  readonly approvedRevision: number | null
  /** Plan file path for the session's workspace; null without a workspace cwd. */
  readonly planPath: string | null
}

/**
 * Reduce a session id to a plan-file-safe segment: keep `A-Za-z0-9._-`,
 * replace every other character with `-`, and trim leading/trailing dashes.
 * A result with nothing left collapses to `session` so the filename is never
 * empty.
 *
 * @param id - raw session id.
 * @returns the sanitized filename segment.
 */
export function sanitizeSessionId(id: string): string {
  const trimmed = id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return trimmed === '' ? 'session' : trimmed
}

/**
 * SHA-256 of a plan text, hex-encoded. Plan texts are compared by digest so
 * the ledger never has to hold a second copy of the markdown.
 *
 * @param text - the plan markdown.
 * @returns the hex digest.
 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Validate plugin config. Missing, blank, absolute, backspacing, or
 * parent-escaping `plansDir` fails at load rather than at first write.
 *
 * @param config - raw plugin config.
 * @returns a detached validated config.
 */
export function resolveConfig(config: GhPlanReviewConfig): GhPlanReviewConfig {
  const plansDir = (config as Partial<GhPlanReviewConfig>).plansDir
  if (typeof plansDir !== 'string' || plansDir === '') {
    throw new Error('GhPlanReviewConfig needs a non-empty string `plansDir`')
  }
  if (isAbsolute(plansDir) || plansDir.includes('\\') || plansDir.includes('\0')
    || plansDir.split('/').includes('..')) {
    throw new Error(`GhPlanReviewConfig plansDir must stay a relative directory inside the workspace: ${plansDir}`)
  }
  const unknown = Object.keys(config).filter(key => key !== 'plansDir')
  if (unknown.length > 0) {
    throw new Error(`GhPlanReviewConfig has unknown key(s) ${unknown.join(', ')} — config is { plansDir }`)
  }
  return { plansDir }
}

const unitStateSchema: ZodType<GhPlanReviewUnitState> = zod.object({
  nextRevision: zod.number().int().min(1),
  approvedRevision: zod.number().int().positive().nullable(),
  writtenSha256: zod.string().nullable(),
  planPath: zod.string().nullable(),
}).strict()

const viewSchema: ZodType<GhPlanReviewView> = zod.object({
  revision: zod.number().int().nonnegative(),
  approvedRevision: zod.number().int().positive().nullable(),
  planPath: zod.string().nullable(),
})

/** Guarded read of one `gh-plan/*` event's unknown payload. */
function asRecord(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
}

/** One in-flight review, keyed by the exit tool call's id. */
interface ReviewRecord {
  /** Set when the plan-review question actually reached the answerer. */
  questionSeen: boolean
  /** The reviewer's structured answer, once it settles. */
  answer?: { approved: boolean; custom: string | null }
  /** The question ended without an answer: dismissed by the user. */
  dismissed?: boolean
  /** The question ended without an answer: aborted or errored. */
  failed?: boolean
}

/**
 * Fold one event into the ledger. Submissions raise `nextRevision`
 * monotonically and carry the newest plan path. Approvals apply only to a
 * revision at least as new as the recorded approval and below
 * `nextRevision` — an approval for an older or unknown revision is folded as
 * history and changes nothing (the X05 replay guard). `writtenSha256` tracks
 * only approvals that actually wrote the file, so a preserved external edit
 * is never mistaken for this session's content later.
 */
function applyPlanReviewEvent(state: GhPlanReviewUnitState, event: { type: string; data: unknown }): GhPlanReviewUnitState {
  if (event.type === 'gh-plan/submitted') {
    const data = asRecord(event.data)
    const revision = typeof data.revision === 'number' ? data.revision : 0
    const planPath = typeof data.planPath === 'string' ? data.planPath : null
    return {
      ...state,
      nextRevision: Math.max(state.nextRevision, revision + 1),
      planPath: planPath ?? state.planPath,
    }
  }
  if (event.type === 'gh-plan/approved') {
    const data = asRecord(event.data)
    const revision = typeof data.revision === 'number' ? data.revision : 0
    const planSha256 = typeof data.planSha256 === 'string' ? data.planSha256 : ''
    const fileWritten = data.fileWritten === true
    if (revision < (state.approvedRevision ?? 0) || revision >= state.nextRevision) return state
    return {
      ...state,
      approvedRevision: revision,
      writtenSha256: fileWritten && planSha256 !== '' ? planSha256 : state.writtenSha256,
    }
  }
  return state
}

/** Projection of the plan-review ledger. */
export const planReviewProjectionDefinition = {
  key: 'ghPlanReview',
  stateVersion: 1,
  stateSchema: unitStateSchema,
  init: () => ({ nextRevision: 1, approvedRevision: null, writtenSha256: null, planPath: null }),
  apply: applyPlanReviewEvent,
  wire: {
    viewSchema,
    view: state => ({
      revision: state.nextRevision - 1,
      approvedRevision: state.approvedRevision,
      planPath: state.planPath,
    }),
  },
} satisfies ProjectionDefinition<'ghPlanReview', GhPlanReviewUnitState>

/** The model-facing exit tool this ledger records around. */
const EXIT_PLAN_MODE = 'exit_plan_mode'

/**
 * `ctx.ghPlanReview`: the plan-review ledger. Observes the plan-review
 * question and the exit tool's settled result, assigns one revision per
 * presented plan, appends the `gh-plan/*` events, and maintains the plan
 * file under the session's workspace cwd.
 */
export class GhPlanReviewService extends Service {
  static inject = ['tools', 'sessionProjections']

  /** Validated workspace-relative plans directory. */
  private readonly plansDir: string

  /** In-flight reviews keyed by exit tool call id; cleared when each settles. */
  private readonly reviews = new Map<string, ReviewRecord>()

  /** Newest assigned revision per session, seeded from the projection. */
  private readonly lastRevision = new WeakMap<Session, number>()

  constructor(ctx: Context, config: GhPlanReviewConfig = { plansDir: '.glm/plans' }) {
    super(ctx, 'ghPlanReview')
    this.plansDir = resolveConfig(config).plansDir
    ctx.sessionProjections.register(planReviewProjectionDefinition)

    ctx.on('user-questions/request', async (request, next) => {
      const question = request.questions.find(item => item.intent?.kind === 'plan-review')
      if (question?.intent?.kind !== 'plan-review' || question.intent.callId === undefined) return next()
      const callId = question.intent.callId
      const record = this.reviews.get(callId) ?? { questionSeen: false }
      record.questionSeen = true
      this.reviews.set(callId, record)
      try {
        const answer = await next()
        const item = answer.answers.find(entry => entry.id === question.id)
        record.answer = {
          approved: item !== undefined && item.selected.length === 1 && item.selected[0] === question.intent.approve,
          custom: typeof item?.custom === 'string' && item.custom !== '' ? item.custom : null,
        }
        return answer
      } catch (cause: unknown) {
        if (cause instanceof UserQuestionError && cause.code === 'ASK_CANCELLED') record.dismissed = true
        else record.failed = true
        throw cause
      }
    })

    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.name !== EXIT_PLAN_MODE || exec.agent === undefined) return decision
      const plan = (exec.arguments as { plan?: unknown } | undefined)?.plan
      const record = this.reviews.get(exec.callId)
      // A call that never reached the review (mode/heading validation, no
      // answerer channel) is not a plan revision: no events, no file.
      if (record?.questionSeen !== true || typeof plan !== 'string') {
        this.reviews.delete(exec.callId)
        return decision
      }
      const session = exec.agent.session
      const revision = this.assignRevision(session)
      const planPath = this.planPathOf(session)
      const planSha256 = sha256Text(plan)
      session.append('gh-plan/submitted', { revision, planPath, planSha256 })
      const value = result.isError ? undefined : (result.value as { approved?: unknown } | undefined)
      if (!result.isError && value?.approved === true) {
        let fileWritten = false
        if (planPath !== null) {
          try {
            fileWritten = this.writePlanFile(planPath, plan, this.stateOf(session).writtenSha256)
          } catch (error: unknown) {
            ctx.logger.warn('gh-plan-review: failed to write the plan file after approval: %o', error)
          }
        }
        session.append('gh-plan/approved', { revision, planPath, planSha256, fileWritten })
      } else {
        const outcome: GhPlanRejectionOutcome = record.answer !== undefined
          ? 'keep-planning'
          : !result.isError && value?.approved === false && record.dismissed === true
            ? 'dismissed'
            : 'failed'
        session.append('gh-plan/rejected', {
          revision,
          outcome,
          feedback: outcome === 'keep-planning' ? record.answer?.custom ?? null : null,
        })
      }
      this.reviews.delete(exec.callId)
      return decision
    })

    ctx.effect(() => () => {
      this.reviews.clear()
    }, 'gh-plan-review: drop in-flight reviews')
  }

  /**
   * Read the folded ledger for one agent's session.
   *
   * @param agent - the agent whose plan history is read.
   * @returns the newest revision, the newest approval, and the plan file path.
   */
  describe(agent: Agent): GhPlanReviewView {
    const state = this.stateOf(agent.session)
    return { revision: state.nextRevision - 1, approvedRevision: state.approvedRevision, planPath: state.planPath }
  }

  /**
   * Resolve the deterministic plan file path for a session's workspace.
   *
   * @param session - the session whose header cwd anchors the path.
   * @returns `<cwd>/<plansDir>/plan-<sanitized id>.md`, or null without a cwd.
   */
  planPathOf(session: Session): string | null {
    const cwd = session.header.cwd
    return cwd === undefined || cwd === '' ? null : join(cwd, this.plansDir, `plan-${sanitizeSessionId(session.id)}.md`)
  }

  /** Read the required projection state or fail at the first ledger access. */
  private stateOf(session: Session): GhPlanReviewUnitState {
    const state = this.ctx.sessionProjections.stateOf(session, 'ghPlanReview')
    if (state === undefined) throw new Error('gh-plan-review requires the ghPlanReview session projection')
    return state
  }

  /** Assign the next revision for a session, seeded from the durable fold. */
  private assignRevision(session: Session): number {
    const durable = this.stateOf(session).nextRevision - 1
    const revision = Math.max(this.lastRevision.get(session) ?? 0, durable) + 1
    this.lastRevision.set(session, revision)
    return revision
  }

  /**
   * Write the approved plan text to the plan file, atomically, and only when
   * the file is absent or still holds what this session last wrote. Any other
   * content is a user or external edit and is preserved untouched.
   *
   * @param path - the plan file path.
   * @param plan - the approved plan markdown, written verbatim.
   * @param previousWrittenSha256 - digest of the content this session last
   * wrote to the file, or null when it never wrote.
   * @returns whether the file now holds the approved text.
   */
  private writePlanFile(path: string, plan: string, previousWrittenSha256: string | null): boolean {
    let existing: string | null = null
    try {
      existing = readFileSync(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing !== null && sha256Text(existing) !== previousWrittenSha256) return false
    mkdirSync(dirname(path), { recursive: true })
    const staging = `${path}.tmp-${process.pid.toString(36)}-${randomUUID()}`
    writeFileSync(staging, plan, 'utf8')
    renameSync(staging, path)
    return true
  }
}

export default GhPlanReviewService
