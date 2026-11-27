/**
 * Completeness spec (design §2.3): the 6 states x 20 events cartesian
 * product (E1, E3–E21; the former 开工核验过 event retired by
 * freeze-reclaim-phase2-1127 分期4) must be fully covered by explicit
 * transfer/forbid/na entries — a missing cell fails HERE (测试期炸), never
 * at runtime. Also pins the guard vocabulary: every G1–G6 id is referenced
 * by the table.
 */
import { describe, expect, it } from 'vitest'
import { EVENTS, MATRIX, STATES, cellFor, type EventId, type State } from '../src/core/table.ts'

function buckets(state: State) {
  const cells = MATRIX[state]
  return {
    transfer: Object.keys(cells.transfer) as EventId[],
    forbid: Object.keys(cells.forbid) as EventId[],
    na: Object.keys(cells.na) as EventId[],
  }
}

describe('state x event completeness (§2.3)', () => {
  it('covers every event exactly once per state (no holes, no overlaps)', () => {
    const problems: string[] = []
    for (const state of STATES) {
      const { transfer, forbid, na } = buckets(state)
      const seen = new Set<EventId>()
      for (const [bucket, keys] of [['transfer', transfer], ['forbid', forbid], ['na', na]] as const) {
        for (const key of keys) {
          if (seen.has(key)) problems.push(`${state} × ${key}: in both ${bucket} and an earlier bucket`)
          seen.add(key)
        }
      }
      for (const event of EVENTS) {
        if (!seen.has(event)) problems.push(`${state} × ${event}: EMPTY CELL`)
      }
      expect(problems, problems.join('\n')).toEqual([])
    }
  })

  it('cellFor returns an entry for all 120 cells', () => {
    let checked = 0
    for (const state of STATES) {
      for (const event of EVENTS) {
        const cell = cellFor(state, event)
        expect(cell, `${state} × ${event}`).toBeDefined()
        expect(['transfer', 'forbid', 'na']).toContain(cell!.kind)
        checked += 1
      }
    }
    expect(checked).toBe(STATES.length * EVENTS.length)
  })

  it('transfer cells carry a design-row note and a valid target', () => {
    for (const state of STATES) {
      for (const [event, cell] of Object.entries(MATRIX[state].transfer)) {
        expect(cell.note, `${state} × ${event} note`).not.toBe('')
        expect(cell.to === 'dynamic' || STATES.includes(cell.to), `${state} × ${event} to`).toBe(true)
      }
    }
  })

  it('references every guard G1–G6 at least once (§2.4 vocabulary)', () => {
    const used = new Set<string>()
    for (const state of STATES) {
      for (const cell of Object.values(MATRIX[state].transfer)) {
        for (const guard of cell.guards) used.add(guard)
      }
    }
    for (const guard of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
      expect(used.has(guard), `${guard} never referenced`).toBe(true)
    }
  })

  it('terminal states refuse every mutating work event (done/cancelled safety)', () => {
    const workEvents: EventId[] = ['E3', 'E4', 'E5', 'E7', 'E9', 'E10', 'E14']
    for (const state of ['done', 'cancelled'] as const) {
      for (const event of workEvents) {
        const cell = cellFor(state, event)
        expect(cell?.kind, `${state} × ${event}`).not.toBe('transfer')
      }
    }
  })
})
