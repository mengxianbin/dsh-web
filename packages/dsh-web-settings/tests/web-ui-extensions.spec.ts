import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebUiExtensions } from '../src/client/web-ui-extensions.ts'

describe('WebUiExtensions navigation', () => {
  it('user selects the requested TAB before opening the stable parent section', () => {
    // Given a native settings store and the Web Extensions service
    const ctx = new Context()
    const openSection = vi.fn()
    Object.assign(ctx, {
      locale: { bind: () => (key: string) => key },
      slots: {
        entries: (key: string) => key === 'sidebar.settings'
          ? [{ store: { create: () => ({ actions: { openSection } }) } }]
          : [],
        spec: () => ({ kind: 'keyed', scope: 'root' }),
        subscribe: () => () => {},
        register: () => () => {},
      },
    })
    const service = new WebUiExtensions(ctx)
    expect(service.label()).toBe('extensions.title')
    // When usage opens through the service
    // Then selection happens before the stable parent opens
    expect(service.open('dsh-usage')).toBe(true)
    expect(service.getSnapshot()).toBe('dsh-usage')
    expect(openSection).toHaveBeenCalledWith('web-ui-plugins')
  })

  it('user gets TABs dynamically in page order from the registration service', () => {
    // Given an observable keyed slot and the service
    const ctx = new Context()
    const entries: Array<{ options: Record<string, unknown>; component: unknown }> = []
    let changed: (() => void) | undefined
    Object.assign(ctx, {
      locale: { bind: () => (key: string) => key },
      slots: {
        spec: () => ({ kind: 'keyed', scope: 'root' }),
        subscribe: (listener: () => void) => { changed = listener; return () => { changed = undefined } },
        entries: () => entries,
        register: (options: Record<string, unknown>, component: unknown) => {
          const entry = { options, component }
          entries.push(entry)
          if (typeof changed === 'function') changed()
          return () => {
            const index = entries.indexOf(entry)
            if (index >= 0) entries.splice(index, 1)
            if (typeof changed === 'function') changed()
          }
        },
      },
    })
    const service = new WebUiExtensions(ctx)
    const page = (key: string, order: number) => ({
      key,
      order,
      locale: 'test',
      label: () => key,
      inject: () => ({}),
      component: () => null,
    })

    // When pages register out of order and one unmounts
    const disposeLate = service.registerPage(page('late', 200))
    const disposeEarly = service.registerPage(page('early', 100))
    // Then the parent sees ordered pages and the unregister removes exactly one
    expect(service.getPages().map(item => item.key)).toEqual(['early', 'late'])
    expect(entries.map(entry => entry.options.key)).toEqual(['late', 'early'])
    disposeEarly()
    expect(service.getPages().map(item => item.key)).toEqual(['late'])
    expect(entries.map(entry => entry.options.key)).toEqual(['late'])
    disposeLate()
    expect(service.getPages()).toHaveLength(0)
  })

  it('user keeps the selection when native navigation is unavailable', () => {
    // Given no native settings store
    const ctx = new Context()
    Object.assign(ctx, {
      locale: { bind: () => (key: string) => key },
      slots: {
        entries: () => [],
        spec: () => ({ kind: 'keyed', scope: 'root' }),
        subscribe: () => () => {},
        register: () => () => {},
      },
    })
    const service = new WebUiExtensions(ctx)
    // When native navigation declines
    // Then the requested TAB remains selected for the DOM fallback
    expect(service.open('pet')).toBe(false)
    expect(service.getSnapshot()).toBe('pet')
  })
})
