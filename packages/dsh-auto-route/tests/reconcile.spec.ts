import { describe, expect, it } from 'vitest'
import { ActiveSetTracker } from '../src/active-set.ts'
import { AutoRouteController, type CatalogApi, type ControllerLogger, type DefaultModelApi, type SwitchApi } from '../src/controller.ts'
import { resolveConfig, type Config, type ResolvedConfig } from '../src/config.ts'
import type { MeterReading, WindowKey } from '../src/meters.ts'
import type { ManualLockEntry } from '../src/manual-lock.ts'
import type { LockStore } from '../src/lock-store.ts'

const WINDOW = 30 * 60_000
const MIMO = { provider: 'mimo', model: 'mimo-v2.6-flash' }
const BACK = { provider: 'opencode-go', model: 'mimo-v2.6-flash', reasoningEffort: 'high' }
const MIMO_VALUE = 'mimo/mimo-v2.6-flash'
const GO_VALUE = 'opencode-go/mimo-v2.6-flash'

/** Rig with fold feeding, a live default model, and a capturing lock store. */
function rig(options: { config?: Config; groups?: { id: string; models: { id: string }[] }[]; locks?: ManualLockEntry[] } = {}) {
  let now = 10_000_000
  const ratios: Record<WindowKey, number> = { fiveHour: 0.02, week: 0.03, month: 0.05 }
  const selects: { sessionId: string; provider: string; model: string; reasoningEffort?: string }[] = []
  const saves: { provider: string; model: string }[] = []
  const failures = new Map<string, Error>()
  const logs: Record<'info' | 'warn' | 'error', string[]> = { info: [], warn: [], error: [] }
  const logger: ControllerLogger = {
    info: message => { logs.info.push(message) },
    warn: message => { logs.warn.push(message) },
    error: message => { logs.error.push(message) },
  }
  const tracker = new ActiveSetTracker()
  let defaultSelection: { provider: string; model: string } = { provider: 'opencode-go', model: 'mimo-v2.6-flash' }
  let groups = options.groups ?? [
    { id: 'mimo', models: [{ id: 'mimo-v2.6-flash' }] },
    { id: 'opencode-go', models: [{ id: 'mimo-v2.6-flash' }] },
  ]
  let defaultSaveFails: Error | undefined
  const lockSaves: ManualLockEntry[][] = []
  let locks = options.locks
  const lockStore: LockStore = {
    load: () => locks,
    save: entries => { locks = [...entries]; lockSaves.push([...entries]) },
  }
  const sessions: SwitchApi = {
    async selectModel(request) {
      const failure = failures.get(request.sessionId)
      if (failure !== undefined) throw failure
      selects.push({
        sessionId: request.sessionId,
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      })
      return {}
    },
  }
  const catalog: CatalogApi = { async modelCatalog() { return { groups } } }
  const defaultModel: DefaultModelApi = {
    async saveSelection(selection) {
      if (defaultSaveFails !== undefined) throw defaultSaveFails
      saves.push({ provider: selection.provider, model: selection.model })
      defaultSelection = { provider: selection.provider, model: selection.model }
    },
    currentSelection: () => defaultSelection,
  }
  const config: ResolvedConfig = resolveConfig(options.config ?? {})
  const controller = new AutoRouteController({
    config, tracker, logger, now: () => now, sessions, catalog, defaultModel, lockStore,
    meters: async (): Promise<MeterReading> => {
      const windows = Object.fromEntries(Object.entries(ratios).map(([key, ratio]) =>
        [key, { key: key as WindowKey, used: ratio * 100, limit: 100, ratio }])) as MeterReading['windows']
      return { at: now, windows }
    },
  })
  return {
    rig: controller, tracker, selects, saves, logs, lockSaves,
    advance: (ms: number) => { now += ms },
    setRatios: (next: Partial<Record<WindowKey, number>>) => { Object.assign(ratios, next) },
    failSelectFor: (sessionId: string, error: Error | undefined) => {
      if (error === undefined) failures.delete(sessionId)
      else failures.set(sessionId, error)
    },
    failDefaultSaveWith: (error: Error | undefined) => { defaultSaveFails = error },
    setGroups: (next: { id: string; models: { id: string }[] }[]) => { groups = next },
    setDefault: (selection: { provider: string; model: string }) => { defaultSelection = selection },
    /** Fold one active session as observed on a route (request or selection). */
    observe: (sessionId: string, route: string) => {
      tracker.recordRequest(sessionId, now)
      tracker.recordSelection(sessionId, route)
    },
    status: () => controller.status().policy,
  }
}

describe('reconcile — steady-state alignment (2026-11-01 ruling A 稳态对账)', () => {
  it('pulls an active session stranded on the wrong side back on the next hold poll', async () => {
    const env = rig()
    // The exact tonight-shape: phase baseline, session observed on mimo.
    env.observe('stranded', MIMO_VALUE)

    await env.rig.tick()
    expect(env.selects).toEqual([{ sessionId: 'stranded', ...BACK }]) // baseline target = opencode-go
    expect(env.status().lastReconcile).toMatchObject({ checked: 1, switched: 1, aligned: 0, skippedLocked: 0, skippedUnknown: 0, defaultRestored: false })
    // The manual-lock machinery books the controller's own reconcile write as
    // `auto`: the durable echo of that write must NOT lock the session.
    env.rig.onSelectionEvent('stranded', { provider: 'opencode-go', model: 'mimo-v2.6-flash' })
    expect(env.status().manualLocks).toEqual([])
  })

  it('stays quiet when everything already aligns (no redundant selectModel, no spam)', async () => {
    const env = rig()
    env.observe('aligned', GO_VALUE)

    await env.rig.tick()
    await env.advance(45_000)
    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.saves).toEqual([])
    expect(env.status().lastReconcile).toMatchObject({ checked: 1, aligned: 1, switched: 0 })
    // Steady state logs nothing — the leg proves itself on the status payload.
    expect(env.logs.info.filter(line => line.includes('reconcile'))).toEqual([])
  })

  it('skips sessions it has never observed since boot (never switched blind)', async () => {
    const env = rig()
    env.tracker.recordRequest('unknown', 10_000_000) // active but no fold data
    expect(env.tracker.effectiveRoute('unknown')).toBeUndefined()

    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.status().lastReconcile).toMatchObject({ checked: 0, skippedUnknown: 1, switched: 0 })
  })

  it('skips manual-locked sessions (A case 2026-10-27 survives in the reconcile leg)', async () => {
    const env = rig({ locks: [{ sessionId: 'parked', value: MIMO_VALUE, lockedAt: 5 }] })
    env.observe('parked', MIMO_VALUE)

    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.status().lastReconcile).toMatchObject({ skippedLocked: 1, switched: 0 })
  })

  it('enforces the mimo side while triggered (both directions, not just home-going)', async () => {
    const env = rig()
    env.tracker.recordRequest('late', 10_000_000)
    env.setRatios({ week: 0.995 })
    await env.rig.tick() // trigger edge: batch-switches the active set
    expect(env.selects).toEqual([{ sessionId: 'late', ...MIMO }])

    // A session folds onto go mid-triggered-phase (e.g. a selection made while
    // the controller was down): the next hold poll pulls it to mimo.
    env.advance(45_000)
    env.setRatios({ week: 0.995 }) // stay above the restore line → hold
    env.tracker.recordSelection('late', GO_VALUE)
    await env.rig.tick()
    expect(env.selects.at(-1)).toEqual({ sessionId: 'late', ...MIMO })
    expect(env.status().lastReconcile).toMatchObject({ switched: 1 })
  })

  it('does not run on edge ticks (the edge just aligned the set)', async () => {
    const env = rig()
    env.observe('stranded', MIMO_VALUE)

    env.setRatios({ week: 0.995 })
    await env.rig.tick() // trigger edge: execute() ran, reconcile did not
    expect(env.selects).toEqual([{ sessionId: 'stranded', ...MIMO }]) // the EDGE switched it
    expect(env.status().lastReconcile).toBeUndefined() // no reconcile record on edge ticks
    expect(env.status().lastPoll).toMatchObject({ ok: true })
  })
})

describe('reconcile — the default leg (side-effect hijack repair)', () => {
  it('restores a deployment default rewritten away by a human session switch', async () => {
    const env = rig()
    // The harness side effect: a human picked mimo on ONE session → default = mimo.
    env.setDefault({ provider: 'mimo', model: 'mimo-v2.6-flash' })

    await env.rig.tick()
    expect(env.saves).toEqual([{ provider: 'opencode-go', model: 'mimo-v2.6-flash' }])
    expect(env.status().lastReconcile).toMatchObject({ defaultRestored: true })
    expect(env.logs.info.some(line => line.includes('deployment default mimo/mimo-v2.6-flash drifted'))).toBe(true)
  })

  it('leaves an aligned default alone (no write, no log)', async () => {
    const env = rig()
    await env.rig.tick()
    expect(env.saves).toEqual([])
    expect(env.status().lastReconcile).toMatchObject({ defaultRestored: false })
  })

  it('follows the default leg in the dead zone while the session leg pauses', async () => {
    // 0.96 → default-switch edge: defaultsPhase=triggered, phase=baseline.
    const env = rig()
    env.setRatios({ week: 0.96 })
    await env.rig.tick()
    expect(env.saves).toEqual([{ provider: 'mimo', model: 'mimo-v2.6-flash' }]) // hedge armed

    // A mimo-born session speaks during the dead zone: NOT pulled to go —
    // the hedge is the point; and the default drifts back to go behind us.
    env.advance(45_000)
    env.observe('born-hedged', MIMO_VALUE)
    env.setDefault({ provider: 'opencode-go', model: 'mimo-v2.6-flash' })
    await env.rig.tick()
    expect(env.selects).toEqual([]) // session leg paused
    expect(env.saves.at(-1)).toEqual({ provider: 'mimo', model: 'mimo-v2.6-flash' }) // default leg re-armed
    expect(env.status().lastReconcile).toMatchObject({ sessionLegPaused: true, defaultRestored: true })

    // Window recovers fully → restore edge → both latches home → the hedged
    // session is pulled back on the next hold poll (the tonight-fix).
    env.advance(45_000)
    env.setRatios({ week: 0.5 })
    await env.rig.tick() // restore edge (default-only: phase never triggered)
    expect(env.status().phase).toBe('baseline')
    env.advance(45_000)
    await env.rig.tick()
    expect(env.selects.at(-1)).toEqual({ sessionId: 'born-hedged', ...BACK })
    expect(env.status().lastReconcile).toMatchObject({ switched: 1, sessionLegPaused: false })
  })

  it('warns once for a persistently failing default save, not every poll', async () => {
    const env = rig()
    env.setDefault({ provider: 'mimo', model: 'mimo-v2.6-flash' })
    env.failDefaultSaveWith(new Error('guard refused'))

    await env.rig.tick()
    await env.advance(45_000)
    await env.rig.tick()
    await env.advance(45_000)
    await env.rig.tick()
    const warnings = env.logs.warn.filter(line => line.includes('could not restore the default'))
    expect(warnings).toHaveLength(1)
    expect(env.status().lastReconcile).toMatchObject({ defaultRestored: false, defaultError: 'guard refused' })

    // Recovery clears the dedup: a later drift of the same shape logs again.
    env.failDefaultSaveWith(undefined)
    await env.advance(45_000)
    await env.rig.tick() // aligned now → dedup key cleared
    env.setDefault({ provider: 'mimo', model: 'mimo-v2.6-flash' })
    env.failDefaultSaveWith(new Error('guard refused'))
    await env.advance(45_000)
    await env.rig.tick()
    expect(env.logs.warn.filter(line => line.includes('could not restore the default'))).toHaveLength(2)
  })
})

describe('reconcile — pre-flight and failure containment', () => {
  it('blocks the whole pass when the target is unroutable, with action reconcile on the problem', async () => {
    const env = rig({ groups: [{ id: 'opencode-go', models: [{ id: 'other-model' }] }] })
    env.observe('stranded', MIMO_VALUE)

    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.status().targetProblem).toMatchObject({
      action: 'reconcile',
      provider: 'opencode-go',
      reason: expect.stringContaining('not offered'),
    })
    expect(env.logs.error.filter(line => line.includes('reconcile blocked'))).toHaveLength(1)
    expect(env.status().lastReconcile).toMatchObject({ switched: 0 })

    // Same block next poll: status refreshes the timestamp, log stays deduped.
    await env.advance(45_000)
    await env.rig.tick()
    expect(env.logs.error.filter(line => line.includes('reconcile blocked'))).toHaveLength(1)

    // Catalog recovers → pass runs and the stale problem clears.
    env.setGroups([
      { id: 'mimo', models: [{ id: 'mimo-v2.6-flash' }] },
      { id: 'opencode-go', models: [{ id: 'mimo-v2.6-flash' }] },
    ])
    await env.advance(45_000)
    await env.rig.tick()
    expect(env.status().targetProblem).toBeUndefined()
    expect(env.selects).toEqual([{ sessionId: 'stranded', ...BACK }])
  })

  it('counts per-session selectModel failures without aborting the rest of the pass', async () => {
    const env = rig()
    env.observe('broken', MIMO_VALUE)
    env.observe('healthy', MIMO_VALUE)
    env.failSelectFor('broken', new Error('session vanished'))

    await env.rig.tick()
    expect(env.selects).toEqual([{ sessionId: 'healthy', ...BACK }])
    expect(env.status().lastReconcile).toMatchObject({ switched: 1, failed: 1 })
    expect(env.logs.warn.some(line => line.includes('failed session broken during reconcile'))).toBe(true)
  })

  it('a reconcile throw never marks the meter poll as failed', async () => {
    const env = rig()
    env.observe('stranded', MIMO_VALUE)
    // Make the session leg blow up in an unexpected way (the fold is the one
    // reconcile-owned dependency that can throw here).
    const tracker = env.tracker
    const original = tracker.snapshot.bind(tracker)
    tracker.snapshot = () => { throw new Error('fold exploded') }

    await env.rig.tick()
    expect(env.logs.warn.some(line => line.includes('reconcile pass failed (state untouched)'))).toBe(true)
    expect(env.status().lastPoll).toMatchObject({ ok: true }) // the reading itself succeeded
    expect(env.selects).toEqual([])
    tracker.snapshot = original
  })

  it('is off when reconcile: false (edge-only behavior restored)', async () => {
    const env = rig({ config: { reconcile: false } })
    env.observe('stranded', MIMO_VALUE)
    env.setDefault({ provider: 'mimo', model: 'mimo-v2.6-flash' })

    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.saves).toEqual([])
    expect(env.status().lastReconcile).toBeUndefined()
    expect(env.status().lines.reconcile).toBe(false)
  })
})

describe('reconcile — lock durability across a Host restart', () => {
  it('a lock persisted before restart still skips the first reconcile pass after boot', async () => {
    const persisted: ManualLockEntry[] = [{ sessionId: 'parked', value: MIMO_VALUE, lockedAt: 5 }]
    const env = rig({ locks: persisted })
    env.observe('parked', MIMO_VALUE)
    env.observe('stranded', MIMO_VALUE)

    await env.rig.tick()
    // The parked session survives; the un-locked strander comes home.
    expect(env.selects).toEqual([{ sessionId: 'stranded', ...BACK }])
    expect(env.status().lastReconcile).toMatchObject({ switched: 1, skippedLocked: 1 })
    expect(env.status().manualLocks).toEqual(persisted)
  })
})
