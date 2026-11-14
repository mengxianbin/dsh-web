/**
 * The family-wide anonymous install telemetry switch: the General group's row
 * on the Web Plugins page, above the plugin cards.
 *
 * The control is a settings-section fragment, not a plugin root, so it carries
 * no data-dsh-plugin attribute. It is one settings row: the setting's name and
 * what it sends on the left, the switch on the right, which the title names.
 *
 * The switch is the positive value, checked meaning the heartbeat runs, which
 * is the default. The stored preference is the opt-out, so the switch and the
 * stored value are inverses. The browser's Do Not Track signal suppresses the
 * heartbeat independently; a note under the description says so while it does.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { WebUIPluginsKey } from './locales.ts'
import {
  isTelemetryOptedOut,
  isTelemetrySuppressed,
  setTelemetryOptedOut,
} from './telemetry.ts'
import { ToggleSwitch } from './PluginSettingsCard.tsx'
import css from './web-ui-settings.module.css'

/** Props the settings section binds for the telemetry switch. */
export type TelemetryToggleProps = {
  /** Locale reader for the 'web-ui-plugins' namespace. */
  t: (key: WebUIPluginsKey) => string
}

/** Render the telemetry row: its title, what it sends, the switch, and the Do Not Track note. */
export function TelemetryToggle(props: TelemetryToggleProps): ReactNode {
  const { t } = props
  const titleId = useId()
  // Read after mount: the first client render has no storage to consult, and a
  // server-rendered frame must not disagree with the browser's stored value.
  const [optedOut, setOptedOut] = useState(false)
  const [doNotTrack, setDoNotTrack] = useState(false)
  useEffect(() => {
    setOptedOut(isTelemetryOptedOut())
    setDoNotTrack(isTelemetrySuppressed() && !isTelemetryOptedOut())
  }, [])

  const store = (nextOptedOut: boolean): void => {
    setOptedOut(nextOptedOut)
    setTelemetryOptedOut(nextOptedOut)
    setDoNotTrack(isTelemetrySuppressed() && !isTelemetryOptedOut())
  }

  return (
    <div className={css.row} data-dsh-part="telemetry">
      <div className={css.rowText}>
        <div className={css.rowTitle} id={titleId}>{t('telemetry.title')}</div>
        <div className={css.rowDesc}>
          {t('telemetry.description')}
          {doNotTrack ? <span className={css.rowNote} role="status">{t('telemetry.dnt')}</span> : null}
        </div>
      </div>
      <ToggleSwitch
        labelledBy={titleId}
        checked={!optedOut}
        onChange={(next) => { store(!next) }}
      />
    </div>
  )
}
