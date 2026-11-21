import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('message-edit client apply', () => {
  it('user receives one ordered Turn-tail entry with its required services', () => {
    // Given a root context with the official slot and locale faces
    const injected: string[] = []
    const registrations: Array<Record<string, unknown>> = []
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      locale: { register: vi.fn(() => () => {}) },
      slots: {
        inject: (key: string, callback: () => unknown) => {
          injected.push(key)
          callback()
          return () => {}
        },
        register: (options: Record<string, unknown>) => {
          registrations.push(options)
          return () => {}
        },
      },
      sessions: {},
      uiWorkspace: { openSession: vi.fn() },
    }
    // When the browser plugin applies in a storage-free runtime
    apply(ctx as never)
    // Then its service declaration and single additive registration are visible
    expect(inject).toEqual(['slots', 'locale', 'sessions', 'uiWorkspace'])
    expect(injected).toEqual(['conversation.chat.turnTail'])
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({ name: 'conversation.chat.turnTail', id: 'message-edit', order: 10, locale: 'message-edit' })
  })
})
