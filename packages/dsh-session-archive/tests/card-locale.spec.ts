// @vitest-environment jsdom
// Card-body localization contract (issue #1830): the archived-sessions card
// resolves its copy through the locale service, so a language a pack registers
// for this namespace (dsh-i18n's ru) reaches the card body instead of the zh
// branch a document-language pick picks. That pick stays in force exactly when
// the service is unavailable.
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply } from '../src/client/index.ts'
import { AutoSettingsPanel } from '../src/client/AutoSettings.tsx'
import { ArchiveController } from '../src/client/archive-controller.ts'
import { en, setRuntimeTranslate, t, zh } from '../src/client/locales.ts'
import type { SessionArchiveConfig } from '../src/core/config.ts'

/**
 * The ru copy the language pack registers for this namespace, copied from
 * packages/dsh-i18n/src/client/ru/session-archive.ts (the pack itself is a
 * separate package, so its dictionary is fixture data here rather than an
 * import). Only the keys these tests read are listed; every other key resolves
 * through the fallback chain, exactly as the SDK resolves it.
 */
const RU: Record<string, string> = {
  'arch.title': 'Менеджер архива сессий',
  'arch.results.count': 'Всего сессий: {n}',
  'arch.auto.title': 'Автоматическое обслуживание',
}

/**
 * The lookup the host locale service performs for the active language: its
 * dictionary, then the fallback chain it declares (ru -> en), then the key.
 * @param key - dictionary key.
 * @param params - template values interpolated into the resolved string.
 * @returns the resolved copy.
 */
function packLookup(key: string, params?: Record<string, unknown>): string {
  const text = RU[key] ?? (en as Record<string, string>)[key] ?? key
  let out = text
  for (const [name, value] of Object.entries(params ?? {})) {
    out = out.replaceAll('{' + name + '}', String(value))
  }
  return out
}

/** Ready config form; the panel binds subscribe/getSnapshot before subscribing. */
class ReadyConfigForm implements ConfigForm<SessionArchiveConfig> {
  private readonly snapshot: ConfigFormSnapshot<SessionArchiveConfig>

  constructor(value: Partial<SessionArchiveConfig>) {
    this.snapshot = { status: 'ready', value, base: {}, user: {}, revision: 1, writable: true }
  }

  getSnapshot(): ConfigFormSnapshot<SessionArchiveConfig> {
    return this.snapshot
  }

  subscribe(): () => void {
    return () => {}
  }

  async set(): Promise<boolean> {
    return true
  }

  async unset(): Promise<boolean> {
    return true
  }

  async mutate(): Promise<boolean> {
    return true
  }
}

/** The capture-only ctx every mount below shares; the locale seat is added per test. */
function baseCtx(): Record<string, unknown> {
  const configForm = new ReadyConfigForm({})
  return {
    effect: (run: () => unknown) => {
      run()
      return () => {}
    },
    get: () => undefined,
    configForms: { get: () => configForm },
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: () => () => {},
    },
  }
}

/**
 * Mount the browser half against a locale service serving this namespace.
 * @returns nothing; the copy seat is read back through `t`.
 */
function mountWithLocale(): void {
  const ctx = {
    ...baseCtx(),
    locale: { register: () => () => {}, bind: () => packLookup },
  }
  apply(ctx as never)
}

/**
 * Mount the browser half against a composition where the locale service seat
 * cannot be answered, the way an absent plugin leaves it.
 */
function mountWithoutLocale(): void {
  const ctx = Object.defineProperty(baseCtx(), 'locale', {
    get(): never {
      throw new Error('locale service unavailable')
    },
  })
  apply(ctx as never)
}

describe('archived-sessions card copy language', () => {
  afterEach(() => {
    setRuntimeTranslate(undefined)
    document.documentElement.lang = ''
    cleanup()
  })

  it('user reads the card body in the language the locale service serves, not in Chinese', () => {
    // Given a browser half whose locale service serves ru for this namespace,
    // and a document language the zh/en-only pick would have answered in Chinese
    document.documentElement.lang = 'ru'
    mountWithLocale()

    // When the card renders its body copy
    const { container } = render(createElement(AutoSettingsPanel, {
      settings: new ReadyConfigForm({}),
      controller: new ArchiveController({ sessions: undefined }),
    }))

    // Then the copy is the served ru dictionary, never the zh one
    expect(t('arch.title')).toBe(RU['arch.title'])
    expect(t('arch.title')).not.toBe(zh['arch.title'])
    expect(container.textContent).toContain(RU['arch.auto.title'])
    expect(container.textContent).not.toContain(zh['arch.auto.title'])
  })

  it('user counts sessions with the served dictionary interpolating the template values', () => {
    // Given a browser half whose locale service serves ru for this namespace
    mountWithLocale()

    // When the card interpolates a counted label
    const copy = t('arch.results.count', { n: 3 })

    // Then the value lands in the served string, and the zh template is untouched
    expect(copy).toBe('Всего сессий: 3')
    expect(zh['arch.results.count']).toBe('共 {n} 条会话')
  })

  it('user still reads the card when the locale service is unavailable', () => {
    // Given a browser half mounted without the locale service, in an English document
    document.documentElement.lang = 'en-US'
    mountWithoutLocale()

    // When the card reads its copy
    const copy = t('arch.auto.title')

    // Then the document-language fallback answers in English rather than Chinese
    expect(copy).toBe(en['arch.auto.title'])
    expect(copy).not.toBe(zh['arch.auto.title'])
  })
})
