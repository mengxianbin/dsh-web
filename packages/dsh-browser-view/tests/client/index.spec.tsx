// @vitest-environment jsdom
/**
 * Plugin wiring: what the browser half contributes to the right sidebar and
 * under which ids. The shell is a hand-written fake here - no module graph
 * patching - so the test reads the same registrations the real services would
 * receive.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply, inject as browserViewInject } from '../../src/client/index.ts'
import { zh } from '../../src/client/locales.ts'
import {
  BROWSER_VIEW_GUIDE_ENTRY_ID,
  BROWSER_VIEW_GUIDE_ENTRY_ORDER,
  BROWSER_VIEW_TAB_ID,
  BROWSER_VIEW_TAB_KIND,
} from '../../src/client/tab-type.ts'
import { createFakeTabRegistry, type FakeTabRegistry } from './fake-registry.ts'
import { render, type RenderedTree } from './render.tsx'

/** One registration the fake slot registry received. */
interface RecordedRegistration {
  /** Slot the entry contributes into. */
  readonly name: string
  /** Registration options as the entry declared them. */
  readonly options: Record<string, unknown>
}

/** A hand-written shell the plugin can boot against. */
interface FakeShell {
  /** The context handed to apply(). */
  readonly ctx: ClientContext
  /** Registrations in submit order. */
  readonly registrations: ReadonlyArray<RecordedRegistration>
  /** Seats the plugin waited for, in submit order. */
  readonly awaitedSeats: ReadonlyArray<string>
  /** The recording tab-type registry. */
  readonly tabs: FakeTabRegistry
  /** Swap the copy the bound translate resolves (a language switch). */
  setCopy(copy: Record<string, string>): void
  /** Run every disposer apply() installed, newest first. */
  unload(): void
}

/**
 * Build the fake shell.
 * @param options - `bindThrows` reproduces a locale face that cannot bind.
 * @returns the shell.
 */
function createShell(options: { bindThrows?: boolean } = {}): FakeShell {
  let copy: Record<string, string> = {}
  const registrations: Array<RecordedRegistration> = []
  const awaitedSeats: string[] = []
  const disposers: Array<() => void> = []
  const tabs = createFakeTabRegistry()

  const ctx = {
    effect(factory: () => (() => void) | void): () => void {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose ?? (() => {})
    },
    locale: {
      register(): () => void {
        return () => {}
      },
      bind(): (key: string) => string {
        if (options.bindThrows === true) throw new Error('locale face unavailable')
        return (key: string): string => copy[key] ?? key
      },
    },
    slots: {
      inject(key: string, callback: () => () => void): () => void {
        awaitedSeats.push(key)
        const dispose = callback()
        disposers.push(dispose)
        return dispose
      },
      register(registration: { name: string } & Record<string, unknown>): () => void {
        registrations.push({ name: registration.name, options: registration })
        return () => {}
      },
    },
    sidebarRightTabs: tabs.service,
  } as unknown as ClientContext

  return {
    ctx,
    registrations,
    awaitedSeats,
    tabs,
    setCopy(next: Record<string, string>): void {
      copy = next
    },
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

/** Read one registration by slot name, failing loudly when the plugin skipped it. */
function registrationOf(shell: FakeShell, name: string): RecordedRegistration {
  const found = shell.registrations.find((registration) => registration.name === name)
  if (found === undefined) throw new Error(`no registration for ${name}`)
  return found
}

/** Shells booted by one case, torn down after it. */
let shell: FakeShell | null = null
/** Mounted tree shared by one case. */
let tree: RenderedTree | null = null

afterEach(() => {
  tree?.unmount()
  tree = null
  shell?.unload()
  shell = null
})

describe('browser view plugin wiring', () => {
  it('operator loads the plugin and the browser view becomes a right-sidebar tab type with a body and a chip', () => {
    // Given a shell that declares the sidebar tab registry and the two pane seats
    // When the plugin applies
    // Then it declares the tab type, waits for the two keyed seats, and registers the body and the chip under the type own id
    shell = createShell()
    shell.setCopy({ 'tab.title': zh['tab.title'] })

    apply(shell.ctx)

    expect(browserViewInject).not.toContain('sidebarRight')
    expect(browserViewInject).toContain('sidebarRightTabs')
    expect(shell.awaitedSeats).toEqual(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
    expect(shell.registrations.map((registration) => registration.name)).toEqual([
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
    ])
    // No session-header entry any more, and nothing takes the center column or the global panel list over.
    expect(shell.awaitedSeats).not.toContain('conversation.session.header.actions')
    expect(shell.awaitedSeats).not.toContain('main')
    expect(shell.awaitedSeats).not.toContain('sidebar.panellist')

    const definition = shell.tabs.definitions[0]
    expect(definition.id).toBe(BROWSER_VIEW_TAB_ID)
    expect(definition.kind).toBe(BROWSER_VIEW_TAB_KIND)
    expect(definition.kind).not.toBe('browser')
    expect(definition.keepMounted).toBe(true)
    expect(definition.priority).toBe('extension')
    expect(definition.title(BROWSER_VIEW_TAB_KIND)).toBe(zh['tab.title'])

    const body = registrationOf(shell, 'sidebar.right.pane.tab')
    expect(body.options.key).toBe(BROWSER_VIEW_TAB_ID)
    expect(body.options.locale).toBe('browser-view')

    const chip = registrationOf(shell, 'sidebar.right.pane.tab.title')
    expect(chip.options.key).toBe(BROWSER_VIEW_TAB_ID)
    expect(chip.options.locale).toBe('browser-view')

    // Unloading withdraws the type as well: its disposer runs exactly once.
    shell.unload()
    expect(shell.tabs.disposed()).toBe(1)
  })

  it('user switches language and the tab chip text follows without a second registration', () => {
    // Given the plugin applied with one set of copy
    // When the bound translate starts resolving a different language and the chip text is read again
    // Then the thunk returns the new copy and no tab type was registered twice
    shell = createShell()
    shell.setCopy({ 'tab.title': 'Browser view' })
    apply(shell.ctx)
    const definition = shell.tabs.definitions[0]
    expect(definition.title(BROWSER_VIEW_TAB_KIND)).toBe('Browser view')

    shell.setCopy({ 'tab.title': 'Vista del navegador' })

    expect(definition.title(BROWSER_VIEW_TAB_KIND)).toBe('Vista del navegador')
    expect(shell.tabs.definitions).toHaveLength(1)
  })

  it('operator loads the plugin where the locale face cannot bind and the chip keeps its source copy', () => {
    // Given a shell whose locale face refuses to bind a namespace
    // When the plugin applies and the chip text is read
    // Then the tab type is still registered and falls back to the source dictionary
    shell = createShell({ bindThrows: true })

    apply(shell.ctx)

    expect(shell.tabs.definitions).toHaveLength(1)
    expect(shell.tabs.definitions[0].title(BROWSER_VIEW_TAB_KIND)).toBe(zh['tab.title'])
  })

  it('user opens the right sidebar guide and finds a browser view capsule', () => {
    // Given a shell that declares the sidebar and its tab registry
    // When the plugin applies and the guide asks the type for its entries
    // Then one capsule carries this plugin's own title, its one-line purpose, a stable id and a position of its own
    shell = createShell()
    shell.setCopy({ 'tab.title': zh['tab.title'], 'guide.description': zh['guide.description'] })

    apply(shell.ctx)

    const entries = shell.tabs.definitions[0].guide ?? []
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.id).toBe(BROWSER_VIEW_GUIDE_ENTRY_ID)
    expect(entry.order).toBe(BROWSER_VIEW_GUIDE_ENTRY_ORDER)
    expect(entry.title()).toBe(zh['tab.title'])
    expect(entry.description?.()).toBe(zh['guide.description'])
    // No keyboard shortcut is registered, so the capsule declares no key hint.
    expect(entry.commandId).toBeUndefined()
  })

  it('user switches language and the guide capsule copy follows without a second registration', () => {
    // Given the plugin applied with one set of copy
    // When the bound translate starts resolving a different language and the capsule is read again
    // Then both the title and the description return the new copy and the type was registered once
    shell = createShell()
    shell.setCopy({ 'tab.title': 'Browser view', 'guide.description': 'Watch the page the agent is driving' })
    apply(shell.ctx)
    const entry = (shell.tabs.definitions[0].guide ?? [])[0]

    shell.setCopy({ 'tab.title': 'Vista del navegador', 'guide.description': 'Mira la pagina que maneja el agente' })

    expect(entry.title()).toBe('Vista del navegador')
    expect(entry.description?.()).toBe('Mira la pagina que maneja el agente')
    expect(shell.tabs.definitions).toHaveLength(1)
  })

  it('operator sees the guide capsule draw the plugin own glyph at the size the guide asks for', () => {
    // Given the tab type's guide entry as the registry received it
    // When the guide renders that entry's icon at its described-capsule size
    // Then a decorative svg carries the requested square edge
    shell = createShell()
    apply(shell.ctx)
    const Icon = (shell.tabs.definitions[0].guide ?? [])[0].icon
    if (Icon === undefined) throw new Error('the guide entry declares no glyph')

    const mounted = render(<Icon size={26} />)
    tree = mounted

    const glyph = mounted.container.querySelector('svg')
    expect(glyph?.getAttribute('width')).toBe('26')
    expect(glyph?.getAttribute('height')).toBe('26')
    expect(glyph?.getAttribute('aria-hidden')).toBe('true')
  })
})
