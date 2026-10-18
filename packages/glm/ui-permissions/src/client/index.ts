/**
 * GH permission chip plugin, browser half — the three ZCode-aligned modes as
 * one composer control with an independent plan toggle, hung on the host
 * `/permission` and `/plan` commands. The current mode comes from the
 * session's `ghPermissions` projection and the plan state from `plan`; both
 * are host-folded durable facts, so the chip renders what the executor
 * enforces, never client optimism. A pick submits the command line, so the
 * slash surface, the chip, and the session log share one write path, and the
 * pushed projection frame is the one confirmation. The yolo option carries
 * the same explicit risk confirmation as every full-access surface. Options
 * are the fixed product mode set — no process catalog Remote, unlike the
 * upstream preset menu this row replaces in GH compositions.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { GhPermissionMode, GhPermissionSelection } from '@glm-harness/gh-permissions/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings slot types are not used; commands carry the picker.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ctx.remote merge (remote.commands executes the writes).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the plan projection's client wire declaration ('plan' key).
import type {} from '@deepseek-ai/dsh-plan-mode/client'
import { GH_PERMISSION_ACCESS_NS, en, zh } from './locales.ts'
import type { GhPermissionAccessKey } from './locales.ts'
import { PermissionSelect } from './PermissionSelect.tsx'
import type { PermissionSelectInjected } from './PermissionSelect.tsx'

export type { PermissionSelectInjected, PermissionSelectProps } from './PermissionSelect.tsx'

/** Required services (cordis fiber inject). */
export const inject = [
  'commandUi', 'sessions', 'slots', 'locale', 'remote', 'remote.commands',
]

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GH permission chip and /permission picker copy. */
    'gh-permission.access': keyof typeof zh
  }
}

/** Read one session's current ghPermissions projection value (undefined = capability absent). */
function selectionOf(session: SessionFace | undefined): GhPermissionSelection | undefined {
  return session?.projections.faceOf('ghPermissions').getSnapshot() as GhPermissionSelection | undefined
}

/** The face snapshot itself is the chip's observable; absence yields a static undefined. */
const EMPTY_SELECTION: HostObservable<GhPermissionSelection | undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}

function selectionFaceOf(session: SessionFace | undefined): HostObservable<GhPermissionSelection | undefined> {
  if (session === undefined) return EMPTY_SELECTION
  return session.projections.faceOf('ghPermissions') as HostObservable<GhPermissionSelection | undefined>
}

/** One command execution's success; failures surface through the caller. */
async function executeCommand(ctx: ClientContext, sessionId: SessionId, line: string): Promise<boolean> {
  const result = await ctx.remote.commands.execute(sessionId, line, [])
  if (!result.ok) {
    throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
  }
  if (result.value === undefined) throw new Error(`the host offers no ${line.split(' ')[0]} command`)
  return true
}

/** The fixed picker options: three modes, yolo behind the risk confirmation. */
function optionsOf(currentValue: string, t: (key: GhPermissionAccessKey) => string): SelectOption[] {
  return (['build', 'guarded', 'yolo'] as const).map(mode => ({
    id: mode,
    label: t(`mode.${mode}`),
    detail: t(`description.${mode}`),
    ...(mode === currentValue ? { active: true } : {}),
    ...(mode === 'yolo'
      ? {
        confirmation: {
          title: t('confirm.title'),
          description: t('confirm.description'),
          acknowledgeLabel: t('confirm.acknowledge'),
          cancelLabel: t('confirm.cancel'),
          confirmLabel: t('confirm.enable'),
        },
      }
      : {}),
  }))
}

/**
 * Client plugin body: register the composer chip over the ghPermissions and
 * plan projections and decorate the host /permission command with the same
 * fixed picker.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const command = ctx.get('commandUi') as CommandUiContract
  const sessions = ctx.sessions
  ctx.effect(
    () => ctx.locale.register(GH_PERMISSION_ACCESS_NS, { zh, en }),
    'gh-ui-permissions: current-session dictionaries',
  )
  const t = ctx.locale.bind(GH_PERMISSION_ACCESS_NS)
  const sessionFor = (session: ClientSessionContext): SessionFace | undefined =>
    sessions.binding(session.sessionId)?.session

  const select = (sessionId: SessionId, mode: GhPermissionMode): Promise<boolean> =>
    executeCommand(ctx, sessionId, `/permission ${mode}`)
  const togglePlan = (sessionId: SessionId): Promise<boolean> => {
    const live = sessions.binding(sessionId)?.session
    const plan = live === undefined ? undefined : live.projections.faceOf('plan').getSnapshot() as { active: boolean; pending: boolean } | undefined
    const active = plan === undefined ? false : (plan.pending ? !plan.active : plan.active)
    return executeCommand(ctx, sessionId, active ? '/plan off' : '/plan')
  }

  ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({
    name: 'conversation.input.permission',
    locale: GH_PERMISSION_ACCESS_NS,
    inject: (sessionId: SessionId): PermissionSelectInjected => ({
      hooks: {
        permissionState: selectionFaceOf(sessions.binding(sessionId)?.session),
      },
      select: mode => select(sessionId, mode),
      togglePlan: () => togglePlan(sessionId),
    }),
  }, PermissionSelect))

  ctx.effect(() => command.decorate({
    name: 'permission',
    // The projection key alone decides availability: absence means the GH
    // permission service is not composed on this host.
    available: session => selectionOf(sessionFor(session)) !== undefined,
    ui: {
      kind: 'popupSelect',
      options: (session) => {
        const selection = selectionOf(sessionFor(session))
        if (selection === undefined) throw new Error('GH permission modes are not available on this host')
        return Promise.resolve(optionsOf(selection.currentValue, t))
      },
      onSelect: (option, session) => select(session.sessionId, option.id as 'build' | 'guarded' | 'yolo').then(() => undefined),
    },
  }), 'gh-ui-permissions: /permission decoration')
}
