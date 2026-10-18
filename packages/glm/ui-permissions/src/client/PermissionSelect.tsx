import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular, Menu, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular,
  PermissionIconWorkspaceWriteRegular, RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { GhPermissionMode, GhPermissionSelection } from '@glm-harness/gh-permissions/client'
// Type-only: pulls the conversation-owned permission slot declaration and
// the standard session projection hook into this package's Client face.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { GH_PERMISSION_ACCESS_NS } from './locales.ts'
import css from './PermissionSelect.module.css'

/** The fixed mode set; options are a product constant, not a host catalog. */
const MODES: readonly GhPermissionMode[] = ['build', 'guarded', 'yolo']

/** Glyph per GH mode; permission glyphs follow currentColor like the preset rows. */
const modeGlyphs = new Map<GhPermissionMode, ReactNode>([
  ['build', <PermissionIconReadOnlyRegular />],
  ['guarded', <PermissionIconWorkspaceWriteRegular />],
  ['yolo', <PermissionIconFullAccessRegular />],
])

/** Business face injected by this package's slot registration. */
export interface PermissionSelectInjected {
  /** The session's ghPermissions face snapshot; undefined while unsupplied. */
  hooks: {
    permissionState: HostObservable<GhPermissionSelection | undefined>
  }
  /** Submit one current-session mode through the /permission command writer. */
  select: (mode: GhPermissionMode) => Promise<boolean>
  /** Toggle plan mode through /plan or /plan off. */
  togglePlan: () => Promise<boolean>
}

/** Complete props derived from the conversation slot, injected hooks, and locale. */
export type PermissionSelectProps =
  PropsRuntime<'conversation.input.permission'>
  & InjectFace<PermissionSelectInjected>
  & PropsLocale<typeof GH_PERMISSION_ACCESS_NS>

/**
 * The GH composer permission chip: the three ZCode-aligned modes as one radio
 * group plus an independent plan toggle, mirroring ZCode's Composer mode
 * control. Current values come from the host-folded projections — never
 * client optimism — and picks write through the /permission and /plan
 * commands, so every surface shares one durable path.
 */
export function PermissionSelect({
  locked, select, togglePlan, usePermissionState, useProjection, t,
}: PermissionSelectProps) {
  const selection = usePermissionState(value => value)
  const plan = useProjection('plan')
  const [pick, setPick] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (!locked && selection !== undefined && (confirmation === null || MODES.includes(confirmation as GhPermissionMode))) return
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(null)
  }, [confirmation, locked, selection])

  if (selection === undefined) return null

  // A pending 'plan' toggle never masquerades as a mode pick.
  const currentValue: GhPermissionMode = pick !== null && MODES.includes(pick as GhPermissionMode)
    ? pick as GhPermissionMode : selection.currentValue
  const currentLabel = t(`mode.${currentValue}`)
  const busy = pick !== null || confirmation !== null
  const planActive = plan === undefined ? false : (plan.pending ? !plan.active : plan.active)

  const items: MenuEntry[] = []
  if (plan !== undefined) {
    items.push({
      id: 'plan',
      label: `${planActive ? '✓ ' : ''}${t('plan')}`,
    }, { type: 'separator', id: 'plan-separator' })
  }
  for (const mode of MODES) {
    items.push({
      id: mode,
      label: t(`mode.${mode}`),
      icon: modeGlyphs.get(mode),
    })
  }

  const choose = (id: string): void => {
    setOpen(false)
    if (id === 'plan') {
      setPick('plan')
      void togglePlan().catch(() => false).then(() => { setPick(null) })
      return
    }
    if (id === currentValue) return
    if (id === 'yolo') {
      setAcknowledged(false)
      setConfirmation(id)
      return
    }
    setPick(id)
    void select(id as GhPermissionMode).catch(() => false).then(() => { setPick(null) })
  }

  return (
    <>
      <Menu
        open={open}
        items={items}
        selectedId={currentValue}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        portal
        anchor={
          <button
            type="button"
            className={css.trigger}
            aria-label={t('mode', { name: currentLabel })}
            title={t(`description.${currentValue}`)}
            disabled={locked || busy}
            onClick={() => { setOpen(!open) }}
          >
            <span className={css.triggerIcon} aria-hidden>{modeGlyphs.get(currentValue)}</span>
            <span className={css.triggerLabel}>{currentLabel}</span>
            <span className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden>
              <IconChevronDownOutlineRegular />
            </span>
          </button>
        }
      />
      {confirmation !== null && (
        <RiskConfirmation
          open
          title={t('confirm.title')}
          description={t('confirm.description')}
          acknowledgeLabel={t('confirm.acknowledge')}
          cancelLabel={t('confirm.cancel')}
          closeLabel={t('close')}
          confirmLabel={t('confirm.enable')}
          acknowledged={acknowledged}
          disabled={locked}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => {
            setAcknowledged(false)
            setConfirmation(null)
          }}
          onConfirm={() => {
            setAcknowledged(false)
            setConfirmation(null)
            setPick(confirmation)
            void select(confirmation as GhPermissionMode).catch(() => false).then(() => { setPick(null) })
          }}
        />
      )}
    </>
  )
}
