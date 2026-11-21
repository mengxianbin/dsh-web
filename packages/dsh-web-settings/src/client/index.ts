/**
 * Web Extensions settings parent. The stable web-ui-plugins first-level entry
 * hosts keyed secondary TABs for the family cards and optional satellite pages.
 * The web-ui-plugins TAB still owns web-ui.plugin.item, so existing family card
 * registrations and their migration lifecycle stay unchanged.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { WebUiSettingsBinder } from './compat-settings-scope.ts'
import { WebExtensionsSection } from './WebExtensionsSection.tsx'
import { WebUIPluginsSection } from './WebUIPluginsCard.tsx'
import { en, zh, type WebUIPluginsKey } from './locales.ts'
import { reportDailyHeartbeat } from './telemetry.ts'
import { WEB_EXTENSIONS_SECTION_ID, WEB_EXTENSIONS_SLOT, WebUiExtensions } from './web-ui-extensions.ts'

export type { WebUIPluginsSectionProps } from './WebUIPluginsCard.tsx'
export type { WebExtensionsSectionProps } from './WebExtensionsSection.tsx'
export { WEB_EXTENSIONS_SECTION_ID, WEB_EXTENSIONS_SLOT, WebUiExtensions } from './web-ui-extensions.ts'
export type { WebUiExtensionsFace } from './web-ui-extensions.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-ui-plugins': WebUIPluginsKey
  }

  interface SlotMap {
    'web-ui.plugin.item': { kind: 'list'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
    /** One keyed settings page per installed Web extension. */
    'web-ui.extension': { kind: 'keyed'; scope: 'root'; owner: SettingsExtensionOwnerProps }
  }
}

export interface SettingsPluginItemOwnerProps {
  children?: never
}

/** The parent forwards the native settings-section owner props to each TAB. */
export interface SettingsExtensionOwnerProps {
  close: () => void
}

export const inject = ['slots', 'locale', 'connection', 'configForms', 'remote']

export function apply(ctx: ClientContext): void {
  reportDailyHeartbeat([{ name: '@linxin666/dsh-client-ui-web-ui-settings' }])

  ctx.effect(() => {
    try {
      return ctx.locale.register('web-ui-plugins', { zh, en })
    } catch {
      return () => {}
    }
  }, 'web-ui-settings: dictionaries')

  new WebUiSettingsBinder(ctx)
  const extensions = new WebUiExtensions(ctx)

  ctx.slots.inject('settings.section', () => {
    try {
      return ctx.slots.register({
        name: 'settings.section',
        id: WEB_EXTENSIONS_SECTION_ID,
        order: 110,
        label: () => extensions.label(),
        locale: 'web-ui-plugins',
        children: { [WEB_EXTENSIONS_SLOT]: { kind: 'keyed', scope: 'root' } },
        inject: () => ({ extensions }),
      }, WebExtensionsSection)
    } catch {
      return () => {}
    }
  })

  ctx.effect(() => extensions.registerPage({
    key: WEB_EXTENSIONS_SECTION_ID,
    order: 100,
    locale: 'web-ui-plugins',
    label: () => ctx.locale.bind('web-ui-plugins')('title'),
    inject: () => ({}),
    component: WebUIPluginsSection,
    children: { 'web-ui.plugin.item': { kind: 'list', scope: 'root' } },
  }), 'web-ui-settings: Web Plugins page')
}
