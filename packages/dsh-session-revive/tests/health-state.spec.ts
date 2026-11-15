import { describe, expect, it } from 'vitest'
import {
  MechanismHealth,
  REVIVE_TRIP_STREAK_LIMIT,
  reviveHealthOk,
  type ReviveHealthFacts,
  type ReviveHealthState,
} from '../src/health-state.ts'

const T0 = 1_760_000_000_000

function tracker(options: { mode?: 'shadow' | 'live' } = {}) {
  const writes: ReviveHealthState[] = []
  const box = { removed: 0, status: 'ok' as 'ok' | 'error', halted: false, now: T0 }
  const health = new MechanismHealth({
    mode: options.mode ?? 'live',
    readStatus: () => box.status,
    readHalted: () => box.halted,
    write: (state) => writes.push(state),
    remove: () => {
      box.removed += 1
    },
    now: () => box.now,
  })
  return { health, writes, box }
}

describe('mechanism-health ledger (拍板⑮)', () => {
  it('writes on the first evaluation and stays silent while the facts hold (只在状态变化时写)', () => {
    const { health, writes, box } = tracker()
    health.sync()
    health.sync()
    health.sync()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      at: T0,
      active: true,
      mode: 'live',
      status: 'ok',
      breakerTrips: 0,
      breakerOk: true,
      halted: false,
      ok: true,
    })
    // A new stamp alone is not a state change — no rewrite (近零写入).
    box.now = T0 + 60_000
    health.sync()
    expect(writes).toHaveLength(1)
    // A fact flip rewrites with the fresh stamp.
    box.halted = true
    health.sync()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ at: T0 + 60_000, halted: true, ok: false })
  })

  it('keeps reading healthy through two trips, reddens at 连跳, and clears on a completed turn', () => {
    const { health, writes, box } = tracker()
    health.sync()
    health.noteTrip()
    health.sync()
    health.noteTrip()
    health.sync()
    expect(writes.at(-1)).toMatchObject({ breakerTrips: 2, breakerOk: true, ok: true })
    health.noteTrip()
    health.sync()
    expect(writes.at(-1)).toMatchObject({ breakerTrips: REVIVE_TRIP_STREAK_LIMIT, breakerOk: false, ok: false })
    health.noteCompleted()
    health.sync()
    expect(writes.at(-1)).toMatchObject({ breakerTrips: 0, breakerOk: true, ok: true })
    // A failed status read reddens too (status 端点可读 is one of the five).
    box.status = 'error'
    health.sync()
    expect(writes.at(-1)).toMatchObject({ status: 'error', ok: false })
  })

  it('reads a shadow-mode plugin as unhealthy (mode=live is one of the five facts)', () => {
    const { health, writes } = tracker({ mode: 'shadow' })
    health.sync()
    expect(writes[0]).toMatchObject({ mode: 'shadow', ok: false })
    expect(reviveHealthOk({ active: true, mode: 'shadow', status: 'ok', breakerTrips: 0, breakerOk: true, halted: false } satisfies ReviveHealthFacts)).toBe(false)
  })

  it('dispose removes the ledger — 停用 = 面消失, not 面变坏', () => {
    const { health, box } = tracker()
    health.sync()
    health.dispose()
    expect(box.removed).toBe(1)
  })
})
