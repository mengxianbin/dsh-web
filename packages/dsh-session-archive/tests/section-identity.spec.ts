/**
 * Section-identity contract (issue #1955): the plugin seats its OWN
 * `settings.section` id (`dsh-session-archive`) at order 25 instead of
 * claiming the official `archived-sessions` id. The settings shell never
 * merges same-id sections, and its registry refuses a second registration of
 * the same `id` at the same `priority` (default 0); `order` only sorts the
 * rendered nav rows and never arbitrates the seat. Claiming the official id
 * therefore made this plugin collide with any other archive plugin seating that
 * id: one registration threw, or one of the two entries silently vanished, and
 * no choice of order could avoid it. A distinct id lets the official page and a
 * third-party archive plugin coexist with this one, one entry each, while a
 * single-archive-plugin install still shows exactly one entry.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

interface Registration {
  name: string
  options: Record<string, unknown>
}

/** A section seat as the shell keys it: `id` plus `priority`; `order` only sorts. */
interface Seat {
  id: string
  order: number
  priority?: number
}

/** One mounted browser half plus the handles a test needs to inspect it. */
interface MountedClient {
  registrations: Registration[]
  /** Attempt one more registration against the same fake registry. */
  attempt: (seat: Seat) => void
  releases: () => number
  unmount: () => void
}

const configForm = {
  getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true }),
  subscribe: () => () => {},
  set: async () => true,
  unset: async () => true,
  mutate: async () => true,
}

/** The conflict key the shell registry applies: same id at the same priority. */
function seatKey(seat: Seat): string {
  return `${seat.id}@${seat.priority ?? 0}`
}

/**
 * Mount the browser half against a capture-only ctx. The fake registry models
 * the one shell rule this contract depends on: a second registration of the
 * same `id` at the same `priority` (default 0) is refused, while `order` is
 * only a sort key and never decides whether a seat is still free.
 */
function mountClient(foreign: Seat[] = []): MountedClient {
  const registrations: Registration[] = []
  const seated = new Set(foreign.map(seatKey))
  const cleanups: (() => void)[] = []
  let releases = 0

  const register = (options: Record<string, unknown>): (() => void) => {
    const seat: Seat = {
      id: String(options.id),
      order: Number(options.order),
      priority: Number(options.priority ?? 0),
    }
    const key = seatKey(seat)
    if (seated.has(key)) {
      throw new Error(`settings.section id ${seat.id} is already registered at priority ${seat.priority ?? 0}`)
    }
    seated.add(key)
    registrations.push({ name: String(options.name), options })
    return () => {
      releases += 1
      seated.delete(key)
    }
  }

  const ctx = {
    effect: (run: () => unknown) => {
      const dispose = run()
      if (typeof dispose === 'function') cleanups.push(dispose as () => void)
      return () => {}
    },
    get: () => undefined,
    configForms: { get: () => configForm },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => (zh as Record<string, string>)[key] ?? key,
    },
    slots: {
      inject: (_name: string, run: () => unknown) => {
        const dispose = run()
        if (typeof dispose === 'function') cleanups.push(dispose as () => void)
        return () => {}
      },
      register,
    },
  }
  apply(ctx as never)
  return {
    registrations,
    attempt: (seat: Seat) => {
      register({ name: 'settings.section', ...seat })
    },
    releases: () => releases,
    unmount: () => {
      for (const dispose of cleanups) dispose()
    },
  }
}

function section(mounted: MountedClient): Registration | undefined {
  return mounted.registrations.find((entry) => entry.name === 'settings.section')
}

describe('archived-sessions section identity', () => {
  it('user sees the plugin own section id at order 25', () => {
    // Given the plugin's browser half mounted against a capture-only settings ctx
    const mounted = mountClient()

    // When the registered settings section is read
    // Then it carries this plugin's own id at the archive nav order
    expect(section(mounted)?.options.id).toBe('dsh-session-archive')
    expect(section(mounted)?.options.order).toBe(25)
  })

  it('user never sees the official archived-sessions id claimed', () => {
    // Given the plugin's browser half mounted against a capture-only settings ctx
    const mounted = mountClient()

    // When the registered settings section is read
    // Then the official id stays free for the official page or another archive plugin
    expect(section(mounted)?.options.id).not.toBe('archived-sessions')
  })

  it('user keeps this entry when another archive plugin already seats the official seat', () => {
    // Given an archive plugin already seated on the official id at priority 0
    const mounted = mountClient([{ id: 'archived-sessions', order: 25, priority: 0 }])

    // When this plugin's browser half registers beside it
    // Then both entries exist, because the ids differ and no key is shared
    expect(section(mounted)?.options.id).toBe('dsh-session-archive')
    expect(mounted.registrations.filter((entry) => entry.name === 'settings.section')).toHaveLength(1)
  })

  it('user still hits the taken seat when the same id is claimed at another order', () => {
    // Given an archive plugin seated on the official id at priority 0 and order 30
    const mounted = mountClient([{ id: 'archived-sessions', order: 30, priority: 0 }])

    // When a second registration claims that id at priority 0 with order 25
    // Then it is refused: order only sorts the rows and never frees the seat
    expect(() => mounted.attempt({ id: 'archived-sessions', order: 25 })).toThrow(/priority 0/u)
  })

  it('user gets a second seat when only the priority differs', () => {
    // Given an archive plugin seated on the official id at the default priority
    const mounted = mountClient([{ id: 'archived-sessions', order: 25, priority: 0 }])

    // When another registration claims the same id at a different priority
    // Then the registry seats it: the conflict key is id plus priority
    expect(() => mounted.attempt({ id: 'archived-sessions', order: 25, priority: 10 })).not.toThrow()
  })

  it('user reads the archive nav copy on that entry', () => {
    // Given the plugin's browser half mounted with the zh locale bound
    const label = section(mountClient())?.options.label as (() => string) | undefined

    // When the seated section's label is resolved
    // Then the entry renders the archive nav copy in both languages
    expect(typeof label).toBe('function')
    expect(label?.()).toBe('已归档会话')
    expect(en['arch.nav']).toBe('Archived sessions')
  })

  it('user gets one registration per mount and a clean release on unmount', () => {
    // Given the plugin's browser half mounted once
    const mounted = mountClient()

    // When the fiber unmounts and the half mounts again
    // Then the seat is released on unmount and re-taken on the next mount
    expect(mounted.registrations).toHaveLength(1)
    expect(mounted.releases()).toBe(0)
    mounted.unmount()
    expect(mounted.releases()).toBe(1)

    const remounted = mountClient()
    expect(remounted.registrations).toHaveLength(1)
    remounted.unmount()
    expect(remounted.releases()).toBe(1)
  })
})
