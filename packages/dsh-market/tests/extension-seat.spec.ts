import { describe, expect, it } from 'vitest'
import { installWorkshopSection } from '../src/client/extension-seat.ts'

function makeCtx(declared: () => boolean = () => true) {
  let current: object | undefined
  let changed: (() => void) | undefined
  const registered: Array<{ options: Record<string, unknown> }> = []
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
  const service = {
    sectionId: 'web-ui-plugins',
    label: () => 'Web Extensions',
    open: () => true,
    registerPage: (page: Record<string, unknown>) => push({ name: 'web-ui.extension', ...page }),
  }
  const ctx = {
    get: () => current,
    on: (_event: string, listener: () => void) => { changed = listener; return () => { changed = undefined } },
    slots: {
      spec: () => declared() ? { kind: 'keyed', scope: 'root' } : undefined,
      entries: (slot: string) => registered.filter(entry => entry.options.name === slot),
      register: push,
    },
  }
  return {
    ctx,
    registered,
    service,
    notify() { changed?.() },
    setService(value: object | undefined) { current = value; changed?.() },
  }
}

const registration = { locale: 'dsh-web-ui-market', label: () => 'Workshop', inject: () => ({}), component: () => null }

describe('Workshop extension seat', () => {
  it('user keeps one page while the parent service changes', () => {
    // Given a standalone Workshop registration and an observable slot registry
    const { ctx, registered, service, setService } = makeCtx()
    const dispose = installWorkshopSection(ctx, registration)
    expect(registered[0]?.options).toMatchObject({ name: 'settings.section', id: 'dsh-workshop' })

    // When the parent appears and later disappears
    setService(service)
    // Then the same single page moves through the parent service and returns
    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toMatchObject({ name: 'web-ui.extension', key: 'dsh-workshop' })
    expect(registered[0]?.options).not.toHaveProperty('id')

    setService(undefined)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toMatchObject({ name: 'settings.section', id: 'dsh-workshop' })
    dispose()
    expect(registered).toHaveLength(0)
  })

  it('user gets registered only after the target declaration is ready', () => {
    // Given a parent service whose child seat is not declared yet
    let declared = false
    const { ctx, registered, service, notify } = makeCtx(() => declared)
    ctx.get = () => service
    installWorkshopSection(ctx, registration)
    expect(registered).toHaveLength(0)
    // When the declaration arrives
    declared = true
    notify()
    // Then registration happens once through the parent service
    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toMatchObject({ name: 'web-ui.extension', key: 'dsh-workshop' })
  })
})
