/**
 * Cross-plugin contract for the integrated Web Extensions settings section.
 * The service is the availability signal: satellite plugins seat their page in
 * web-ui.extension while it exists and keep their standalone section otherwise.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export const WEB_EXTENSIONS_SECTION_ID = 'web-ui-plugins'
export const WEB_EXTENSIONS_SLOT = 'web-ui.extension'

interface SettingsShellStore {
  create(): { actions: { openSection(id: string): void } }
}

/** One settings page contributed to the Web Extensions parent. */
export interface WebExtensionPage {
  /** Stable TAB/seat key; also the standalone first-level entry id. */
  key: string
  /** TAB position and standalone registration order. */
  order: number
  /** Locale namespace supplying the page's copy. */
  locale: string
  /** Localized TAB and standalone-section label. */
  label(): string
  /** Business face rendered into the page component. */
  inject(): object
  /** Page component. */
  component: unknown
  /** Child slots the page declares (for example the Workshop's asset panels). */
  children?: Record<string, { kind: 'keyed' | 'list'; scope: 'root' }>
}

/** Public face consumed through ctx.get('webUiExtensions'). */
export interface WebUiExtensionsFace {
  readonly sectionId: typeof WEB_EXTENSIONS_SECTION_ID
  label(): string
  open(id: string): boolean
  registerPage(page: WebExtensionPage): () => void
}

interface PageRecord {
  page: WebExtensionPage
  dispose?: () => void
}

/** Owns page registration, TAB selection and native settings navigation. */
export class WebUiExtensions extends Service implements WebUiExtensionsFace {
  readonly sectionId = WEB_EXTENSIONS_SECTION_ID
  private selected = WEB_EXTENSIONS_SECTION_ID
  private readonly listeners = new Set<() => void>()
  private readonly pages = new Map<string, PageRecord>()
  private pageSnapshot: readonly WebExtensionPage[] = []
  private syncing = false

  constructor(ctx: Context) {
    super(ctx, 'webUiExtensions')
    ctx.effect(() => {
      const unsubscribe = ctx.slots.subscribe(WEB_EXTENSIONS_SLOT, () => { this.syncPages() })
      this.syncPages()
      return () => {
        unsubscribe()
        for (const record of this.pages.values()) {
          record.dispose?.()
          record.dispose = undefined
        }
        this.pages.clear()
        this.listeners.clear()
      }
    }, 'web-ui-settings: extension pages')
  }

  label(): string {
    return this.ctx.locale.bind('web-ui-plugins')('extensions.title')
  }

  getSnapshot = (): string => this.selected

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeEntries = (listener: () => void): (() => void) => this.ctx.slots.subscribe(WEB_EXTENSIONS_SLOT, listener)

  getEntries = (): readonly StoredEntry[] => this.ctx.slots.entries(WEB_EXTENSIONS_SLOT)

  getPages = (): readonly WebExtensionPage[] => this.pageSnapshot

  subscribePages = (listener: () => void): (() => void) => {
    this.pageListeners.add(listener)
    return () => { this.pageListeners.delete(listener) }
  }

  private readonly pageListeners = new Set<() => void>()

  /** Register one page; disposal is idempotent and removes it from the parent. */
  registerPage(page: WebExtensionPage): () => void {
    if (this.pages.has(page.key)) {
      throw new Error(`web-ui.extension already has an entry with key "${page.key}"`)
    }
    const record: PageRecord = { page }
    this.pages.set(page.key, record)
    this.syncPages()
    this.publishPages()
    return () => {
      if (this.pages.get(page.key) !== record) return
      this.pages.delete(page.key)
      record.dispose?.()
      record.dispose = undefined
      this.publishPages()
    }
  }

  private syncPages(): void {
    if (this.syncing || this.ctx.slots.spec(WEB_EXTENSIONS_SLOT) === undefined) return
    this.syncing = true
    try {
      const mounted = new Set(this.getEntries().map(entry => entry.options.key))
      for (const [key, record] of this.pages) {
        if (mounted.has(key)) continue
        record.dispose?.()
        record.dispose = undefined
        try {
          record.dispose = this.ctx.slots.register({
            name: WEB_EXTENSIONS_SLOT,
            key,
            locale: record.page.locale,
            inject: record.page.inject as never,
            ...(record.page.children === undefined ? {} : { children: record.page.children }),
          } as never, record.page.component as never) as () => void
        } catch (error) {
          try {
            console.warn(`[web-ui-settings] page "${key}" could not be mounted`, error)
          } catch {
            // A restricted console must not break the remaining pages.
          }
        }
      }
    } finally {
      this.syncing = false
      this.publishPages()
    }
  }

  private publishPages(): void {
    this.pageSnapshot = [...this.pages.values()]
      .map(record => record.page)
      .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    for (const listener of this.pageListeners) listener()
  }

  select(id: string): void {
    if (this.selected === id) return
    this.selected = id
    for (const listener of this.listeners) listener()
  }

  open(id: string): boolean {
    // Select first: even a shell without an exposed store keeps the requested
    // TAB ready for its DOM-replay fallback.
    this.select(id)
    try {
      const slots = this.ctx.slots as unknown as { entries(key: string): readonly { store?: unknown }[] }
      const store = slots.entries('sidebar.settings')[0]?.store as SettingsShellStore | undefined
      if (typeof store?.create !== 'function') return false
      store.create().actions.openSection(this.sectionId)
      return true
    } catch {
      return false
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Integrated Web Extensions settings parent provided by dsh-web-settings. */
    webUiExtensions: WebUiExtensions
  }
}
