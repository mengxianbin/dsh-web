/** The Workshop page contribution: Web Extensions parent or standalone section. */

import { installWebExtensionPage, type WebExtensionPageContext } from './web-extension-page.ts'

export const WORKSHOP_SECTION_ID = 'dsh-workshop'
export const WEB_UI_EXTENSION_SEAT = 'web-ui.extension'
export const LEGACY_SETTINGS_SEAT = 'settings.section'

/** The context slice needed by the contribution. */
export type WorkshopSectionContext = WebExtensionPageContext

export interface WorkshopSectionRegistration {
  locale: string
  label(): string
  inject(): object
  component: unknown
}

/** Keep exactly one reachable Workshop page while the parent loads or unloads. */
export function installWorkshopSection(
  ctx: WorkshopSectionContext,
  registration: WorkshopSectionRegistration,
): () => void {
  return installWebExtensionPage(ctx, {
    key: WORKSHOP_SECTION_ID,
    order: 150,
    locale: registration.locale,
    label: registration.label,
    inject: registration.inject,
    component: registration.component,
    children: { 'dsh-workshop.panel': { kind: 'keyed', scope: 'root' } },
  })
}
