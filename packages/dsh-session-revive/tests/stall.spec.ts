/**
 * Stall-probe readings for the two watchdog death causes revive absorbed
 * (pure-worker-migration-1123 §三 缺项①②): owner-heartbeat staleness and
 * turnOpen silence. The written acceptance is literally "one probe reading
 * each + green tests", so every case below asserts a structured
 * `stall-detected`/`stall-cleared` line with its measurements and the E13
 * handoff, plus the edge/cadence discipline that keeps the probes quiet
 * between crossings.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HEARTBEAT_READ_MS,
  HEARTBEAT_RETRY_MS,
  STALL_HEARTBEAT_GRACE_MS,
  STALL_TURN_OPEN_MS,
  StallTracker,
  makeHeartbeatReader,
  type HeartbeatSource,
} from '../src/stall.ts'

const T0 = 1_700_000_000_000
const GRACE = STALL_HEARTBEAT_GRACE_MS
const TURN = STALL_TURN_OPEN_MS

interface Harness {
  tracker: StallTracker
  now: number
  source: HeartbeatSource | undefined
  reads: number
}

function makeHarness(source: HeartbeatSource | undefined): Harness {
  const h: Harness = { now: T0, source, reads: 0, tracker: undefined as unknown as StallTracker }
  h.tracker = new StallTracker(
    { heartbeatGraceMs: GRACE, turnOpenStallMs: TURN },
    () => {
      h.reads += 1
      return h.source
    },
    () => h.now,
  )
  return h
}

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

function writeState(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'revive-stall-'))
  tempDirs.push(dir)
  const path = join(dir, 'taskbot-state.json')
  writeFileSync(path, contents, 'utf8')
  return path
}

/** Open a turn on `h` with the heartbeat axis isolated (no source to read). */
function openTurn(h: Harness, sessionId = 's1', at = T0): void {
  h.source = undefined
  h.tracker.onEvent(sessionId, 'turn/start', at)
  h.now = at
}

describe('owner-heartbeat probe (缺项① owner 心跳超时, grace 15min)', () => {
  it('reads a stale checkpoint once and ships the E13 handoff reading', () => {
    const staleAt = T0 - GRACE - 1_000
    const h = makeHarness({ at: staleAt, field: 'heartbeatAt', ownerSessionId: 'owner-1' })
    const records = h.tracker.sweep(T0)
    expect(records).toHaveLength(1)
    const [record] = records
    expect(record.kind).toBe('log')
    expect(record.event).toBe('stall-detected')
    expect(record.sessionId).toBe('owner-1')
    expect(record.detail.cause).toBe('owner-heartbeat-stall')
    expect(record.detail.next).toBe('E13')
    expect(record.detail.staleMs).toBeGreaterThanOrEqual(GRACE)
    expect(record.detail.graceMs).toBe(GRACE)
    expect(record.detail.heartbeatAt).toBe(staleAt)
    expect(record.detail.field).toBe('heartbeatAt')
    expect(h.tracker.snapshot().heartbeatStalled).toBe(true)
  })

  it('is edge-triggered: one reading per episode, clear on fresh heartbeat', () => {
    const h = makeHarness({ at: T0 - GRACE - 1_000, field: 'heartbeatAt' })
    expect(h.tracker.sweep(T0)).toHaveLength(1)
    // Same stale value at the next cadence tick: no repeat.
    h.now = T0 + HEARTBEAT_READ_MS
    expect(h.tracker.sweep(h.now)).toHaveLength(0)
    // The owner writes again: the episode ends with one clear line.
    h.source = { at: h.now - 1_000, field: 'heartbeatAt' }
    h.now = T0 + 2 * HEARTBEAT_READ_MS
    const records = h.tracker.sweep(h.now)
    expect(records).toHaveLength(1)
    expect(records[0]?.event).toBe('stall-cleared')
    expect(records[0]?.detail.cause).toBe('owner-heartbeat-stall')
    expect(records[0]?.detail.reason).toBe('heartbeat-fresh')
    expect(h.tracker.snapshot().heartbeatStalled).toBe(false)
  })

  it('produces no reading when the checkpoint has no source at all', () => {
    const h = makeHarness(undefined)
    expect(h.tracker.sweep(T0)).toHaveLength(0)
    expect(h.reads).toBe(1)
    expect(h.tracker.snapshot().heartbeatStalled).toBe(false)
  })

  it('clears a stalled episode when the source disappears (retired boss)', () => {
    const h = makeHarness({ at: T0 - GRACE - 1_000, field: 'heartbeatAt', ownerSessionId: 'owner-1' })
    expect(h.tracker.sweep(T0)).toHaveLength(1)
    h.now = T0 + HEARTBEAT_READ_MS
    h.source = undefined
    const records = h.tracker.sweep(h.now)
    expect(records).toHaveLength(1)
    expect(records[0]?.event).toBe('stall-cleared')
    expect(records[0]?.detail.reason).toBe('no-heartbeat-source')
    expect(h.tracker.snapshot().heartbeatStalled).toBe(false)
  })

  it('honours the read cadence: no file read between ticks', () => {
    const h = makeHarness({ at: T0 - 1_000, field: 'heartbeatAt' })
    expect(h.tracker.sweep(T0)).toHaveLength(0)
    expect(h.reads).toBe(1)
    expect(h.tracker.sweep(T0 + HEARTBEAT_READ_MS - 1)).toHaveLength(0)
    expect(h.reads).toBe(1)
    expect(h.tracker.sweep(T0 + HEARTBEAT_READ_MS)).toHaveLength(0)
    expect(h.reads).toBe(2)
  })

  it('backs off to the no-source retry cadence when the file is absent', () => {
    const h = makeHarness(undefined)
    h.tracker.sweep(T0)
    expect(h.reads).toBe(1)
    h.tracker.sweep(T0 + HEARTBEAT_RETRY_MS - 1)
    expect(h.reads).toBe(1)
    h.tracker.sweep(T0 + HEARTBEAT_RETRY_MS)
    expect(h.reads).toBe(2)
  })
})

describe('makeHeartbeatReader (checkpoint seam, dual-name watchdog parity)', () => {
  it('reads the contract name and the legacy alias, stripping the session- prefix', () => {
    const iso = new Date(T0).toISOString()
    const contract = makeHeartbeatReader(writeState(JSON.stringify({ heartbeatAt: iso, ownerSessionId: 'session-abc' })))
    expect(contract()).toEqual({ at: T0, field: 'heartbeatAt', ownerSessionId: 'abc' })
    const legacy = makeHeartbeatReader(writeState(JSON.stringify({ heartbeat: iso })))
    expect(legacy()).toEqual({ at: T0, field: 'heartbeat' })
  })

  it('fails silent to absence: missing file, corrupt blob, invalid timestamp', () => {
    expect(makeHeartbeatReader(join(tmpdir(), 'does-not-exist-1123.json'))()).toBeUndefined()
    expect(makeHeartbeatReader(writeState('{not json'))()).toBeUndefined()
    expect(makeHeartbeatReader(writeState(JSON.stringify({ heartbeatAt: 'not-a-date' })))()).toBeUndefined()
    expect(makeHeartbeatReader(writeState(JSON.stringify({ ownerSessionId: 'session-x' })))()).toBeUndefined()
  })
})

describe('turnOpen probe (缺项② 回合开但静默 ≥30min, turnOpen 第二轴)', () => {
  it('reads an open turn silent past the threshold with the E13 handoff', () => {
    const h = makeHarness(undefined)
    openTurn(h)
    h.now = T0 + TURN - 1_000
    expect(h.tracker.sweep(h.now)).toHaveLength(0)
    h.now = T0 + TURN + 500
    const records = h.tracker.sweep(h.now)
    expect(records).toHaveLength(1)
    const [record] = records
    expect(record.event).toBe('stall-detected')
    expect(record.sessionId).toBe('s1')
    expect(record.detail.cause).toBe('turn-open-stall')
    expect(record.detail.next).toBe('E13')
    expect(record.detail.silentMs).toBeGreaterThanOrEqual(TURN)
    expect(record.detail.thresholdMs).toBe(TURN)
    expect(record.detail.turnStartAt).toBe(T0)
    expect(h.tracker.snapshot().stalledTurns).toBe(1)
  })

  it('is edge-triggered: silence staying past the threshold reads once', () => {
    const h = makeHarness(undefined)
    openTurn(h)
    h.now = T0 + TURN + 500
    expect(h.tracker.sweep(h.now)).toHaveLength(1)
    h.now = T0 + 3 * TURN
    expect(h.tracker.sweep(h.now)).toHaveLength(0)
    expect(h.tracker.snapshot().stalledTurns).toBe(1)
  })

  it('any event restarts the silence clock and clears the episode', () => {
    const h = makeHarness(undefined)
    openTurn(h)
    h.now = T0 + TURN + 500
    expect(h.tracker.sweep(h.now)).toHaveLength(1)
    const activityAt = h.now + 1_000
    const clearedRecords = h.tracker.onEvent('s1', 'tool/call', activityAt)
    expect(clearedRecords).toHaveLength(1)
    expect(clearedRecords[0]?.event).toBe('stall-cleared')
    expect(clearedRecords[0]?.detail.reason).toBe('activity')
    // Silence restarted at activityAt: one full threshold later it reads again.
    h.now = activityAt + TURN
    const again = h.tracker.sweep(h.now)
    expect(again).toHaveLength(1)
    expect(again[0]?.event).toBe('stall-detected')
    expect(again[0]?.detail.silentMs).toBeGreaterThanOrEqual(TURN)
  })

  it('turn/end closes the episode with an evidence line', () => {
    const h = makeHarness(undefined)
    openTurn(h)
    h.now = T0 + TURN + 500
    expect(h.tracker.sweep(h.now)).toHaveLength(1)
    const closed = h.tracker.onEvent('s1', 'turn/end', h.now + 10)
    expect(closed).toHaveLength(1)
    expect(closed[0]?.event).toBe('stall-cleared')
    expect(closed[0]?.detail.reason).toBe('turn-end')
    expect(h.tracker.snapshot().openTurns).toBe(0)
    expect(h.tracker.snapshot().stalledTurns).toBe(0)
    h.now += TURN
    expect(h.tracker.sweep(h.now)).toHaveLength(0)
  })

  it('dispose clears a stalled episode', () => {
    const h = makeHarness(undefined)
    openTurn(h)
    h.now = T0 + TURN + 500
    expect(h.tracker.sweep(h.now)).toHaveLength(1)
    const records = h.tracker.onDisposed('s1')
    expect(records).toHaveLength(1)
    expect(records[0]?.event).toBe('stall-cleared')
    expect(records[0]?.detail.reason).toBe('disposed')
    expect(h.tracker.snapshot().openTurns).toBe(0)
  })

  it('seeds a pre-mount open turn from the checkpoint projection', () => {
    const h = makeHarness(undefined)
    h.tracker.seedTurn('s2', T0)
    h.now = T0 + TURN
    const records = h.tracker.sweep(h.now)
    expect(records).toHaveLength(1)
    expect(records[0]?.sessionId).toBe('s2')
    expect(records[0]?.detail.cause).toBe('turn-open-stall')
    expect(h.tracker.snapshot().openTurns).toBe(1)
  })

  it('seed never resets an already tracked turn (no retroactive clock)', () => {
    const h = makeHarness(undefined)
    h.tracker.onEvent('s3', 'turn/start', T0)
    h.tracker.seedTurn('s3', T0 + 10 * TURN) // late re-seed must be a no-op
    h.now = T0 + TURN
    expect(h.tracker.sweep(h.now)).toHaveLength(1)
  })
})

describe('nextCheckAt (the shell timer contract)', () => {
  it('schedules the first heartbeat read at construction, then the cadence', () => {
    const h = makeHarness({ at: T0 - 1_000, field: 'heartbeatAt' })
    expect(h.tracker.nextCheckAt()).toBe(T0)
    h.tracker.sweep(T0)
    expect(h.tracker.nextCheckAt()).toBe(T0 + HEARTBEAT_READ_MS)
  })

  it('returns the soonest open-turn threshold when it precedes the heartbeat read', () => {
    const h = makeHarness(undefined) // construction at T0 -> first read due at T0
    // Turn opened TURN-100s ago: still under the silence threshold (no detect)
    // but its deadline (T0+100s) beats the absent-source retry (T0+300s).
    h.tracker.seedTurn('s1', T0 - TURN + 100_000)
    h.tracker.sweep(T0)
    expect(h.tracker.nextCheckAt()).toBe(T0 + 100_000)
  })
})
