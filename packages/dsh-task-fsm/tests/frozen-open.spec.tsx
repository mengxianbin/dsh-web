// @vitest-environment jsdom
/**
 * Frozen-open acceptance (frozen-open-1123, design §3.5 点开形态): opening a
 * frozen/locked session elects a true read-only snapshot — the takeover
 * card is non-interactive (no input/textarea/button), carries the freeze
 * notice + state snapshot + wake triggers, and the publish bridge drives it
 * through the pending-interaction channel ahead of the ask card. The
 * non-frozen half of the acceptance is selector null + watcher silence: a
 * plain session elects nothing and renders exactly as before.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { FsmFrozenComposer, type FsmFrozenMatch } from '../src/client/FsmFrozenComposer.tsx'
import { FROZEN_POLL_MS, FsmFrozenWatcher } from '../src/client/FsmFrozenWatcher.tsx'
import {
  FROZEN_KIND,
  FROZEN_PRECEDENCE,
  FROZEN_PRIORITY,
  selectFrozenReadonly,
  type FrozenReadonlyInteraction,
} from '../src/client/frozenOpen.ts'
import { lookupFsmView, refreshFsmView, resetFsmLookup } from '../src/client/api.ts'

const fetchMock = vi.fn()

function jsonOk(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

function sessionView(mode: 'active' | 'frozen' | 'locked', reason = '等前置：#hibernate-wake-1122 未终态') {
  return {
    ok: true,
    found: true,
    view: {
      taskRef: 'content/tech/ai/dsh/tasks.md#demo',
      state: mode === 'active' ? 'active' : 'deferred',
      queue:
        mode === 'active'
          ? { tier: 'none', reason: 'idle', label: '不入', example: '进行中' }
          : { tier: 'yellow', reason: 'prereq-unruled', label: '黄', example: '缺前置未裁' },
      ...(mode === 'active' ? {} : { session: { id: 'session-1', mode, reason } }),
      subreasons: {
        what: '等前置：前置任务未终态/未裁定',
        why: mode === 'active' ? '进行中' : '黄档：缺前置未裁',
        who: '人',
        next: '前置终态到达即解冻续跑',
      },
      pendingAck: false,
    },
  }
}

/** Structural stand-in for the uiSession pending-interaction service. */
function makeUiSession() {
  const state = {
    precedence: undefined as ((interaction: FrozenReadonlyInteraction) => number) | undefined,
    live: new Map<string, FrozenReadonlyInteraction>(),
    publishCount: 0,
    released: [] as string[],
  }
  const face = {
    registerPendingInteraction(precedence: (interaction: FrozenReadonlyInteraction) => number) {
      state.precedence = precedence
      return (interaction: FrozenReadonlyInteraction, _delegate: () => Promise<void>) => {
        state.publishCount += 1
        state.live.set(interaction.key, interaction)
        return () => {
          state.released.push(interaction.key)
          state.live.delete(interaction.key)
        }
      }
    },
  }
  return { face, state }
}

interface CapturedRegistration {
  name: string
  id?: string
  priority?: number
  order?: number
  select?: (owner: unknown) => unknown
  inject?: (arg: string) => unknown
}

function applyWith(uiSession?: ReturnType<typeof makeUiSession>): CapturedRegistration[] {
  const registrations: CapturedRegistration[] = []
  const ctx = {
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, factory: () => unknown) => {
        factory()
        return () => {}
      },
      register: (options: Record<string, unknown>) => {
        registrations.push({ ...options, name: String(options.name) } as CapturedRegistration)
        return () => {}
      },
    },
    get: (name: string) => (name === 'uiSession' ? uiSession?.face : undefined),
  }
  apply(ctx as never)
  return registrations
}

function frozenInteraction(overrides: Partial<FrozenReadonlyInteraction> = {}): FrozenReadonlyInteraction {
  return {
    key: 'frozen:session-1#0',
    kind: FROZEN_KIND,
    sessionId: 'session-1',
    mode: 'frozen',
    reason: '等前置：#hibernate-wake-1122 未终态',
    ...overrides,
  }
}

/** Warm the page cache for session-1 with one fetched view. */
async function warmView(mode: 'frozen' | 'locked'): Promise<void> {
  fetchMock.mockResolvedValue(jsonOk(sessionView(mode)))
  await lookupFsmView('session-1')
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  resetFsmLookup()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('seat registration (apply)', () => {
  it('seats the composer takeover at -20 and the watcher under its occupant id', () => {
    const registrations = applyWith()
    const composer = registrations.find((r) => r.name === 'conversation.composer')
    expect(composer).toBeDefined()
    expect(composer?.priority).toBe(FROZEN_PRIORITY)
    expect(composer?.priority).toBe(-20) // precedes subagent -10 / question 0 / approval 1
    expect(typeof composer?.select).toBe('function')
    const watcher = registrations.find((r) => r.id === 'task-fsm-frozen-watcher')
    expect(watcher?.name).toBe('conversation.input.overlay')
    expect(typeof watcher?.inject).toBe('function')
    expect(watcher?.inject?.('session-9')).toEqual({ sessionId: 'session-9' })
  })

  it('registers without the uiSession service (quiet degradation, no throw)', () => {
    expect(() => applyWith(undefined)).not.toThrow()
  })
})

describe('chain selector (pure function of the owner currency)', () => {
  it('elects the readonly card for a published frozen interaction', () => {
    expect(selectFrozenReadonly({ sessionId: 'session-1', pendingInteraction: frozenInteraction() })).toEqual({
      sessionId: 'session-1',
      mode: 'frozen',
      reason: '等前置：#hibernate-wake-1122 未终态',
    })
    expect(
      selectFrozenReadonly({ sessionId: 'session-1', pendingInteraction: frozenInteraction({ mode: 'locked', reason: '长等待锁定' }) }),
    ).toEqual({ sessionId: 'session-1', mode: 'locked', reason: '长等待锁定' })
  })

  it('declines everything else — non-frozen sessions elect nothing (regression green)', () => {
    expect(selectFrozenReadonly({ sessionId: 'session-1', pendingInteraction: undefined })).toBeNull()
    expect(selectFrozenReadonly({ sessionId: 'session-1' })).toBeNull()
    // Other domains' interactions (ask card / approval) never elect this entry.
    expect(selectFrozenReadonly({ sessionId: 'session-1', pendingInteraction: { kind: 'question' } })).toBeNull()
    expect(selectFrozenReadonly({ sessionId: 'session-1', pendingInteraction: { kind: 'approval' } })).toBeNull()
    // A frozen state without a bound session cannot take over a composer.
    expect(selectFrozenReadonly({ pendingInteraction: frozenInteraction() })).toBeNull()
  })

  it('uses only the owner currency (same input, same output — contract purity)', () => {
    const owner = { sessionId: 'session-1', session: { anything: true }, pendingInteraction: frozenInteraction() }
    expect(selectFrozenReadonly(owner)).toEqual(selectFrozenReadonly(owner))
  })
})

describe('publish bridge (react path: view fetch → pending interaction)', () => {
  it('publishes on a frozen view, releases on wake, and re-keys a re-freeze', async () => {
    const ui = makeUiSession()
    applyWith(ui)
    expect(ui.state.publishCount).toBe(0)

    fetchMock.mockResolvedValue(jsonOk(sessionView('frozen')))
    await refreshFsmView('session-1')
    expect(ui.state.publishCount).toBe(1)
    const first = [...ui.state.live.values()][0]
    expect(first?.kind).toBe(FROZEN_KIND)
    expect(first?.sessionId).toBe('session-1')
    expect(first?.mode).toBe('frozen')

    // Precedence beats the ask card's plan-review (2) / question (1) / approval (0),
    // so the session-status winner is this face while frozen — their selectors decline.
    expect(ui.state.precedence?.(first as FrozenReadonlyInteraction)).toBe(FROZEN_PRECEDENCE)
    expect(FROZEN_PRECEDENCE).toBeGreaterThan(2)

    // Wake: the active view releases the interaction (composer comes back).
    fetchMock.mockResolvedValue(jsonOk(sessionView('active')))
    await refreshFsmView('session-1')
    expect(ui.state.live.size).toBe(0)
    expect(ui.state.released).toHaveLength(1)

    // Re-freeze publishes under a NEW key (the pending-slot replacement contract).
    fetchMock.mockResolvedValue(jsonOk(sessionView('frozen')))
    await refreshFsmView('session-1')
    expect(ui.state.publishCount).toBe(2)
    const second = [...ui.state.live.values()][0]
    expect(second?.key).not.toBe(first?.key)
  })

  it('ignores a failed fetch (last known state stays — fail-safe, no thaw)', async () => {
    const ui = makeUiSession()
    applyWith(ui)
    fetchMock.mockResolvedValue(jsonOk(sessionView('frozen')))
    await refreshFsmView('session-1')
    expect(ui.state.live.size).toBe(1)

    fetchMock.mockRejectedValue(new Error('transient'))
    await refreshFsmView('session-1')
    expect(ui.state.live.size).toBe(1) // still frozen: a 5xx/network blip never clears
  })

  it('catches up on a view that resolved before wiring (warm cache)', async () => {
    fetchMock.mockResolvedValue(jsonOk(sessionView('frozen')))
    await lookupFsmView('session-1') // warms the cache with no subscriber yet
    const ui = makeUiSession()
    applyWith(ui)
    expect(ui.state.publishCount).toBe(1)
    expect([...ui.state.live.values()][0]?.mode).toBe('frozen')
  })
})

describe('FsmFrozenComposer (打不进字: the readonly snapshot card)', () => {
  it('renders the freeze notice, reason, state snapshot and wake triggers', async () => {
    await warmView('frozen')
    const match: FsmFrozenMatch = { sessionId: 'session-1', mode: 'frozen', reason: '等前置：#hibernate-wake-1122 未终态' }
    render(<FsmFrozenComposer matched={match} />)
    const card = screen.getByRole('status')
    expect(card.textContent).toContain('只读快照')
    expect(card.textContent).toContain('等前置：#hibernate-wake-1122 未终态')
    expect(card.textContent).toContain('任务状态')
    expect(card.textContent).toContain('两触发')
    for (const label of ['等什么', '为什么', '谁', '下一步']) {
      expect(card.textContent, label).toContain(label)
    }
  })

  it('is non-interactive: no input, textarea, button or editable region', async () => {
    await warmView('frozen')
    const match: FsmFrozenMatch = { sessionId: 'session-1', mode: 'frozen', reason: '等前置' }
    const { container } = render(<FsmFrozenComposer matched={match} />)
    expect(container.querySelector('input, textarea, button, select, [contenteditable="true"]')).toBeNull()
  })

  it('shows the locked variant mark for a locked session', async () => {
    await warmView('locked')
    const match: FsmFrozenMatch = { sessionId: 'session-1', mode: 'locked', reason: '长等待锁定' }
    render(<FsmFrozenComposer matched={match} />)
    expect(screen.getByRole('status').textContent).toContain('🔒')
    expect(screen.getByRole('status').getAttribute('data-fsm-frozen-mode')).toBe('locked')
  })

  it('still renders the notice when the view cache is cold (interaction alone suffices)', () => {
    const match: FsmFrozenMatch = { sessionId: 'session-cold', mode: 'frozen', reason: '排队位：等待开工核验' }
    render(<FsmFrozenComposer matched={match} />)
    const card = screen.getByRole('status')
    expect(card.textContent).toContain('只读快照')
    expect(card.textContent).toContain('排队位：等待开工核验')
  })
})

describe('FsmFrozenWatcher (invisible freshness poll)', () => {
  it('renders nothing and fetches immediately, then on every tick', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(jsonOk(sessionView('frozen')))
    const { container } = render(<FsmFrozenWatcher sessionId="session-1" />)
    expect(container.innerHTML).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FROZEN_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      vi.advanceTimersByTime(FROZEN_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stays silent without a bound session (no fetch, no timer)', () => {
    vi.useFakeTimers()
    render(<FsmFrozenWatcher />)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its interval on unmount', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(jsonOk(sessionView('frozen')))
    const { unmount } = render(<FsmFrozenWatcher sessionId="session-1" />)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(FROZEN_POLL_MS * 3)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the mount tick ran
  })

  // fsm-poll-404-1124 reversal fixture: the two-state pair. Exactly 404 stops
  // this watcher's polling (the endless 404 row growth in the access log was
  // pure waste for sessions with no FSM record); 5xx keeps the cadence
  // (fail-open — a transient failure must never silence a live session).
  it('operator sees polling stop on 404 (no FSM record): one fetch, interval cleared, zero growth', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ ok: false, found: false }) } as Response)
    // Given a session that never entered the FSM store (the host answers 404)
    render(<FsmFrozenWatcher sessionId="session-1" />)
    expect(fetchMock).toHaveBeenCalledTimes(1) // the mount tick
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0) // flush the verdict microtask
    })
    // Then the interval is stopped, silently (no log, no state)
    expect(vi.getTimerCount()).toBe(0)
    // When three more cadence windows elapse without a remount
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FROZEN_POLL_MS * 3)
    })
    // Then no request fires: the 404 rows stop growing (access-log equivalence)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('operator sees polling continue on 5xx (fail-open: a transient error never silences the watcher)', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ ok: false, error: 'unavailable' }) } as Response)
    // Given a session whose FSM route answers 503 (transient server trouble)
    render(<FsmFrozenWatcher sessionId="session-1" />)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // When two cadence windows elapse, each tick fetches again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FROZEN_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FROZEN_POLL_MS)
    })
    // Then polling continues and the interval stays armed
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1) // the cadence stays armed
  })

  it('operator sees polling continue after a network failure (a timeout resolves through the same fail-open path)', async () => {
    vi.useFakeTimers()
    fetchMock.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(jsonOk(sessionView('frozen')))
    // Given a first poll that fails with a network error (a timeout resolves the same way)
    render(<FsmFrozenWatcher sessionId="session-1" />)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // When the next cadence window elapses, the watcher polls again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FROZEN_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FROZEN_POLL_MS)
    })
    // Then the fail-open path keeps the cadence armed
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
  })
})
