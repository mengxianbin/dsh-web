/**
 * The Web Plugins TAB of the Web Extensions section. The strip above already
 * names the page, so it opens straight on its two labelled groups: General,
 * whose one row is the family-wide telemetry switch, and Plugins, the family
 * plugin cards rendered through the child slot.
 */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TelemetryToggle } from './TelemetryToggle.tsx'
import css from './web-ui-settings.module.css'

/** Props the settings section binds for the family plugin cards page. */
export type WebUIPluginsSectionProps =
  PropsRuntime<'web-ui.extension'>
  & PropsLocale<'web-ui-plugins'>
  & PropsRenderSlots<'web-ui.plugin.item'>

/** Render the General group's telemetry row and the Plugins group's cards. */
export function WebUIPluginsSection(props: WebUIPluginsSectionProps): ReactNode {
  const { t, renderSlot } = props
  // Each label is its group's heading, so a screen reader moves between the
  // two groups without passing every row.
  return (
    <div className={css.section}>
      <div className={css.group} role="heading" aria-level={3}>{t('group.general')}</div>
      <TelemetryToggle t={t} />
      <div className={css.group} role="heading" aria-level={3}>{t('group.plugins')}</div>
      <ul className={css.subcards}>
        {renderSlot('web-ui.plugin.item', {})}
      </ul>
    </div>
  )
}
