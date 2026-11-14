import { describe, expect, it, vi } from 'vitest'
import { installUsageSection, openIntegratedUsageSettings } from '../src/client/section-integration.ts'

function makeCtx() {
  let service: object | undefined
  let changed: (() => void) | undefined
  const registered: Array<Record<string, unknown>> = []
  const push = (options: Record<string, unknown>) => {
    const entry = { options }
    registered.push(entry)
    changed?.()
    return () => {
      const index = registered.indexOf(entry)
      if (index >= 0) registered.splice(index, 1)
      changed?.()
    }
  }
  const ctx = {
    get: (name: string) => name === 'webUiExtensions' ? service : undefined,
    on: (_event: string, listener: () => void) => { changed = listener; return () => { changed = undefined } },
    slots: {
      register: push,
      entries: (_key: string) => [],
    },
  }
  return {
    ctx,
    registered,
    setService(value: object | undefined) {
      service = value === undefined
        ? undefined
        : {
          ...value,
          registerPage: (page: Record<string, unknown>) => push({
            name: 'web-ui.extension',
            key: page.key,
            locale: page.locale,
            inject: page.inject,
            children: page.children,
          }),
        }
      changed?.()
    },
  }
}

function exposeNativeStore(ctx: ReturnType<typeof makeCtx>['ctx'], openSection: (id: string) => void): void {
  Object.assign(ctx.slots, {
    entries: (key: string) => key === 'sidebar.settings'
      ? [{ store: { create: () => ({ actions: { openSection } }) } }]
      : [],
  })
}

const registration = {
  order: 151,
  locale: 'dsh-usage',
  label: () => 'Usage',
  inject: () => ({}),
  component: () => null,
}

describe('usage Web Extensions registration', () => {
  it('user keeps one section while moving between standalone and integrated seats', () => {
    // Given a standalone usage registration
    const { ctx, registered, setService } = makeCtx()
    installUsageSection(ctx as never, registration)
    expect(registered[0]?.options).toMatchObject({ name: 'settings.section', id: 'dsh-usage', order: 151 })

    // When the parent appears and later disappears
    setService({ sectionId: 'web-ui-plugins', label: () => 'Web Extensions', open: () => true })
    // Then one live entry moves seats and returns without duplication
    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toMatchObject({ name: 'web-ui.extension', key: 'dsh-usage' })
    expect(registered[0]?.options).not.toHaveProperty('id')
    expect(registered[0]?.options).not.toHaveProperty('order')
    expect(registered[0]?.options).not.toHaveProperty('label')

    setService(undefined)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toMatchObject({ name: 'settings.section', id: 'dsh-usage' })
  })
})

describe('usage settings deep link', () => {
  it('user opens usage through the parent service first', () => {
    // Given an integrated parent that accepts native navigation
    const { ctx, setService } = makeCtx()
    const openSection = vi.fn()
    exposeNativeStore(ctx, openSection)
    const open = vi.fn(() => true)
    setService({ sectionId: 'web-ui-plugins', label: () => 'Web Extensions', open })
    // When the foot card opens usage
    openIntegratedUsageSettings(ctx as never)
    // Then the service handles it without a second native-store call
    expect(open).toHaveBeenCalledWith('dsh-usage')
    expect(openSection).not.toHaveBeenCalled()
  })

  it('user lands on the parent section after a declined native open', () => {
    // Given a parent whose own navigation call declines
    const { ctx, setService } = makeCtx()
    const openSection = vi.fn()
    exposeNativeStore(ctx, openSection)
    setService({ sectionId: 'web-ui-plugins', label: () => 'Web Extensions', open: () => false })
    // When the foot card falls back to the native settings store
    openIntegratedUsageSettings(ctx as never)
    // Then the stable parent section opens
    expect(openSection).toHaveBeenCalledWith('web-ui-plugins')
  })

  it('user keeps the standalone target when no parent exists', () => {
    // Given a standalone install with only the native settings store
    const { ctx } = makeCtx()
    const openSection = vi.fn()
    exposeNativeStore(ctx, openSection)
    // When the foot card opens usage
    openIntegratedUsageSettings(ctx as never)
    // Then the original usage section opens
    expect(openSection).toHaveBeenCalledWith('dsh-usage')
  })
})
