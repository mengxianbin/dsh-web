import { describe, expect, it } from 'vitest'
import { ActiveSetTracker } from '../src/active-set.ts'
import { AutoRouteController, type CatalogApi, type DefaultModelApi, type SwitchApi, type ControllerLogger } from '../src/controller.ts'
import { resolveConfig, type Config, type ResolvedConfig } from '../src/config.ts'
import type { MeterReading, WindowKey } from '../src/meters.ts'

const WINDOW = 30 * 60_000

/** Mutable rig: fake clock, scriptable meter ratios, captured switches. */
function rig(options: { config?: Config; groups?: { id: string; models: { id: string }[] }[] } = {}) {
  let now = 10_000_000
  const ratios: Record<WindowKey, number> = { fiveHour: 0.02, week: 0.03, month: 0.05 }
  let meterError: string | undefined
  const selects: { sessionId: string; provider: string; model: string; reasoningEffort?: string }[] = []
  const saves: { provider: string; model: string; reasoningEffort?: string }[] = []
  const failures = new Map<string, Error>()
  const logs: Record<'info' | 'warn' | 'error', string[]> = { info: [], warn: [], error: [] }
  const logger: ControllerLogger = {
    info: message => { logs.info.push(message) },
    warn: message => { logs.warn.push(message) },
    error: message => { logs.error.push(message) },
  }
  const tracker = new ActiveSetTracker()
  const config: ResolvedConfig = resolveConfig(options.config ?? {})
  let groups = options.groups ?? [
    { id: 'mimo', models: [{ id: 'mimo-v2.6-flash' }, { id: 'mimo-v2.5' }] },
    { id: 'opencode-go', models: [{ id: 'mimo-v2.6-flash' }, { id: 'deepseek-v4-flash' }] },
  ]
  const sessions: SwitchApi = {
    async selectModel(request) {
      const failure = failures.get(request.sessionId)
      if (failure !== undefined) throw failure
      selects.push({ ...request })
      return { selected: { provider: request.provider, model: request.model } }
    },
  }
  const catalog: CatalogApi = { async modelCatalog() { return { groups } } }
  const defaultModel: DefaultModelApi = { async saveSelection(selection) { saves.push({ ...selection }) } }
  const controller = new AutoRouteController({
    config,
    tracker,
    logger,
    now: () => now,
    sessions,
    catalog,
    defaultModel,
    meters: async (): Promise<MeterReading> => {
      if (meterError !== undefined) throw new Error(meterError)
      const windows = Object.fromEntries(Object.entries(ratios).map(([key, ratio]) =>
        [key, { key: key as WindowKey, used: ratio * 100, limit: 100, ratio }])) as MeterReading['windows']
      return { at: now, windows }
    },
  })
  return {
    rig: controller, tracker, selects, saves, logs, config,
    advance: (ms: number) => { now += ms },
    setRatios: (next: Partial<Record<WindowKey, number>>) => { Object.assign(ratios, next) },
    failMetersWith: (message: string | undefined) => { meterError = message },
    failSelectFor: (sessionId: string, error: Error | undefined) => {
      if (error === undefined) failures.delete(sessionId)
      else failures.set(sessionId, error)
    },
    setGroups: (next: { id: string; models: { id: string }[] }[]) => { groups = next },
    source: () => controller.status().policy.effectiveSource,
    phase: () => controller.status().policy.phase,
  }
}

const MIMO = { provider: 'mimo', model: 'mimo-v2.6-flash' }
const BACK = { provider: 'opencode-go', model: 'mimo-v2.6-flash', reasoningEffort: 'high' }

describe('auto-route closed loop — ruling thresholds over synthetic readings', () => {
  it('baseline → trigger at any window ≥0.99 → recovery <all → restore', async () => {
    const env = rig()
    // Active set: one running+recent session, one cold (40 min), one subagent.
    env.tracker.recordRequest('s-active', 10_000_000 - 60_000)
    env.tracker.recordStatus('s-active', true)
    env.tracker.recordRequest('s-cold', 10_000_000 - 40 * 60_000)
    env.tracker.recordRequest('s-child', 10_000_000, 'subagent')

    // 1) Quiet baseline: nothing switches, badge source stays opencode-go.
    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.phase()).toBe('baseline')
    expect(env.source()).toBe('opencode-go')
    expect(env.rig.status().policy.lastPoll).toMatchObject({ ok: true })

    // 2) Week window crosses the 0.99 line → edge switches the active set.
    env.advance(30_000)
    env.setRatios({ week: 0.995 })
    await env.rig.tick()
    expect(env.selects).toEqual([{ sessionId: 's-active', ...MIMO }])
    expect(env.saves.at(-1)).toEqual(MIMO) // default follows the policy
    expect(env.phase()).toBe('triggered')
    expect(env.source()).toBe('mimo') // what the badge renders as current source
    const trigger = env.rig.status().policy.lastTrigger
    expect(trigger).toMatchObject({ switched: 1, skipped: 0, failed: 0, defaultSaved: true, ratios: { week: 0.995 } })
    expect(env.rig.status().policy.lastOutcome?.results).toEqual([{ sessionId: 's-active', status: 'switched' }])

    // 3) Simulated recovery: every window under the 0.95 restore line → both legs home.
    env.advance(30_000)
    env.setRatios({ fiveHour: 0.05, week: 0.3, month: 0.4 })
    await env.rig.tick()
    expect(env.selects).toEqual([
      { sessionId: 's-active', ...MIMO },
      { sessionId: 's-active', ...BACK },
    ])
    expect(env.saves.at(-1)).toEqual(BACK)
    expect(env.phase()).toBe('baseline')
    expect(env.source()).toBe('opencode-go')
    expect(env.rig.status().policy.lastRestore).toMatchObject({ switched: 1, failed: 0, defaultSaved: true })
    // The cold and subagent sessions were never touched, in either direction.
    expect(env.selects.map(s => s.sessionId)).toEqual(['s-active', 's-active'])
    expect(env.logs.error).toEqual([])
  })

  it('keeps the target switch only at the edge — later polls do not re-fire', async () => {
    const env = rig()
    env.tracker.recordRequest('s-active', 10_000_000)
    env.setRatios({ week: 0.995 })
    await env.rig.tick()
    await env.rig.tick()
    await env.rig.tick()
    expect(env.selects).toHaveLength(1)
    expect(env.phase()).toBe('triggered')
  })

  it('default leg at ≥0.95 moves only the default — sessions keep running until 0.99', async () => {
    const env = rig()
    env.tracker.recordRequest('s-active', 10_000_000)

    // 1) 95–99 dead zone: the default flips to mimo, the running session does not.
    env.setRatios({ week: 0.96 })
    await env.rig.tick()
    expect(env.selects).toEqual([]) // in-flight leg untouched
    expect(env.saves).toEqual([MIMO]) // new sessions are born on mimo
    expect(env.phase()).toBe('baseline') // badge still renders Go
    expect(env.source()).toBe('opencode-go')
    expect(env.rig.status().policy.defaultsSource).toBe('mimo') // divergence is observable
    expect(env.rig.status().policy.lastDefaultSwitch).toMatchObject({ defaultSaved: true, switched: 0, ratios: { week: 0.96 } })

    // 2) Crossing 0.99 engages the in-flight leg (the default save repeats idempotently).
    env.advance(30_000)
    env.setRatios({ week: 0.995 })
    await env.rig.tick()
    expect(env.selects).toEqual([{ sessionId: 's-active', ...MIMO }])
    expect(env.saves.at(-1)).toEqual(MIMO)
    expect(env.phase()).toBe('triggered')
    expect(env.source()).toBe('mimo')

    // 3) Recovery below the shared 0.95 line returns both legs home.
    env.advance(30_000)
    env.setRatios({ fiveHour: 0.05, week: 0.3, month: 0.4 })
    await env.rig.tick()
    expect(env.selects.at(-1)).toEqual({ sessionId: 's-active', ...BACK })
    expect(env.saves.at(-1)).toEqual(BACK)
    expect(env.phase()).toBe('baseline')
    expect(env.rig.status().policy.defaultsSource).toBe('opencode-go')
    expect(env.logs.error).toEqual([])
  })

  it('a default-only restore never touches running sessions', async () => {
    const env = rig()
    env.tracker.recordRequest('s-active', 10_000_000)
    env.setRatios({ week: 0.96 })
    await env.rig.tick()
    expect(env.saves).toEqual([MIMO])
    // The window resets below the line before 0.99 was ever reached: the
    // policy never moved the session, so the down-edge must not stomp it.
    env.advance(30_000)
    env.setRatios({ fiveHour: 0.05, week: 0.3, month: 0.4 })
    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.saves.at(-1)).toEqual(BACK) // the default still comes home
    expect(env.phase()).toBe('baseline')
    expect(env.rig.status().policy.defaultsSource).toBe('opencode-go')
    expect(env.rig.status().policy.lastRestore).toMatchObject({ switched: 0, defaultSaved: true })
  })
})

describe('auto-route guards', () => {
  it('blocks the edge when the target model is missing from the catalog (首验缺口防线)', async () => {
    const env = rig({ groups: [{ id: 'mimo', models: [{ id: 'mimo-v2.5' }] }, { id: 'opencode-go', models: [{ id: 'mimo-v2.6-flash' }] }] })
    env.tracker.recordRequest('s-active', 10_000_000)
    env.setRatios({ week: 0.995 })
    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.phase()).toBe('baseline') // nothing half-switched
    expect(env.source()).toBe('opencode-go')
    const problem = env.rig.status().policy.targetProblem
    expect(problem).toMatchObject({ action: 'switch', provider: 'mimo', model: 'mimo-v2.6-flash' })
    expect(problem?.reason).toContain('not offered by provider')
    expect(env.logs.error).toHaveLength(1)
    // ...and it retries once the catalog offers the model again.
    env.setGroups([{ id: 'mimo', models: [{ id: 'mimo-v2.6-flash' }] }, { id: 'opencode-go', models: [{ id: 'mimo-v2.6-flash' }] }])
    await env.rig.tick()
    expect(env.selects).toHaveLength(1)
    expect(env.phase()).toBe('triggered')
    expect(env.rig.status().policy.targetProblem).toBeUndefined()
  })

  it('blocks the default edge when the target model is missing from the catalog', async () => {
    const env = rig({ groups: [{ id: 'mimo', models: [{ id: 'mimo-v2.5' }] }, { id: 'opencode-go', models: [{ id: 'mimo-v2.6-flash' }] }] })
    env.setRatios({ week: 0.96 }) // 95–99 dead zone: only the default leg would move
    await env.rig.tick()
    expect(env.saves).toEqual([]) // the default never points at an unroutable model
    expect(env.rig.status().policy.defaultsSource).toBe('opencode-go')
    const problem = env.rig.status().policy.targetProblem
    expect(problem).toMatchObject({ action: 'default-switch', provider: 'mimo', model: 'mimo-v2.6-flash' })
    expect(problem?.reason).toContain('not offered by provider')
    expect(env.logs.error).toHaveLength(1)
    expect(env.rig.status().policy.lastDecision).toBeUndefined() // blocked edge advances nothing
  })

  it('never decides on a failed poll (state and source untouched)', async () => {
    const env = rig()
    env.tracker.recordRequest('s-active', 10_000_000)
    env.failMetersWith('ECONNREFUSED')
    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.phase()).toBe('baseline')
    expect(env.rig.status().policy.lastPoll).toMatchObject({ ok: false })
    expect(env.rig.status().policy.lastPoll?.error).toContain('ECONNREFUSED')
    expect(env.logs.warn.at(-1)).toContain('state untouched')
    // A later good reading still decides normally.
    env.failMetersWith(undefined)
    env.setRatios({ week: 0.995 })
    await env.rig.tick()
    expect(env.phase()).toBe('triggered')
  })

  it('classifies per-session failures: subagent rejections skip, others fail', async () => {
    const env = rig()
    env.tracker.recordRequest('s-ok', 10_000_000)
    env.tracker.recordRequest('s-child', 10_000_000)
    env.tracker.recordRequest('s-boom', 10_000_000)
    env.failSelectFor('s-child', new Error('session "s-child" is owned by subagent routing'))
    env.failSelectFor('s-boom', new Error('session/model-unavailable: resolver exploded'))
    env.setRatios({ week: 0.995 })
    await env.rig.tick()
    const outcome = env.rig.status().policy.lastOutcome
    expect(outcome?.results).toEqual([
      { sessionId: 's-ok', status: 'switched' },
      { sessionId: 's-child', status: 'skipped', detail: expect.stringContaining('subagent') },
      { sessionId: 's-boom', status: 'failed', detail: expect.stringContaining('resolver exploded') },
    ])
    expect(env.rig.status().policy.lastTrigger).toMatchObject({ switched: 1, skipped: 1, failed: 1 })
    expect(env.phase()).toBe('triggered') // policy still advances on partial success
  })

  it('an empty active set still flips the policy and saves the default (new sessions follow)', async () => {
    const env = rig()
    env.setRatios({ month: 0.99 })
    await env.rig.tick()
    expect(env.selects).toEqual([])
    expect(env.phase()).toBe('triggered')
    expect(env.source()).toBe('mimo')
    expect(env.saves).toEqual([MIMO])
    expect(env.rig.status().policy.lastTrigger).toMatchObject({ switched: 0, defaultSaved: true })
    // defaultModel is present, so the "no default-model service" warning stays quiet.
    expect(env.logs.warn.join('\n')).not.toContain('active set empty')
  })

  it('serves the ruling lines, targets, and the disabled balance guardrail on the status payload', async () => {
    const env = rig()
    const { policy } = env.rig.status()
    expect(policy.lines).toEqual({ triggerRatio: 0.99, defaultRatio: 0.95, restoreRatio: 0.95, minDwellMs: 0, pollIntervalMs: 45_000, activeWindowMs: WINDOW })
    expect(policy.targets).toEqual({ switchTo: MIMO, restoreTo: BACK })
    expect(policy.defaultsSource).toBe('opencode-go')
    expect(policy.balanceGuardrail.enabled).toBe(false)
    expect(policy.balanceGuardrail.note).toContain('2026-10-27')
    expect(env.rig.status().service).toBe('dsh-auto-route')
    expect(policy.activeSet.tracked).toBe(0)
  })
})

describe('manual locks (A case, 2026-10-27 人工锁定优先)', () => {
  it('a human touch locks the session — the trigger edge skips it as manual-lock', async () => {
    const env = rig()
    env.tracker.recordRequest('s-lock', 10_000_000)
    env.tracker.recordRequest('s-free', 10_000_000)
    // baseline live target = opencode-go side; a human flip to mimo diverges → lock
    env.rig.onSelectionEvent('s-lock', MIMO)
    expect(env.rig.status().policy.manualLocks).toEqual([
      { sessionId: 's-lock', value: 'mimo/mimo-v2.6-flash', lockedAt: 10_000_000 },
    ])
    env.setRatios({ week: 0.995 })
    await env.rig.tick()
    expect(env.selects).toEqual([{ sessionId: 's-free', ...MIMO }])
    expect(env.rig.status().policy.lastOutcome?.results).toEqual([
      { sessionId: 's-lock', status: 'skipped', detail: 'manual-lock' },
      { sessionId: 's-free', status: 'switched' },
    ])
    expect(env.rig.status().policy.lastTrigger).toMatchObject({ switched: 1, skipped: 1, failed: 0 })
    expect(env.logs.info.join('\n')).toContain('manual lock session s-lock')
  })

  it('the restore edge skips it too; a realigning touch unlocks it for the next edge', async () => {
    const env = rig()
    env.tracker.recordRequest('s-lock', 10_000_000)
    env.tracker.recordRequest('s-free', 10_000_000)
    env.rig.onSelectionEvent('s-lock', MIMO)
    env.setRatios({ week: 0.995 })
    await env.rig.tick() // trigger: s-lock skipped, s-free switched
    expect(env.selects).toHaveLength(1)
    env.advance(30_000)
    env.setRatios({ fiveHour: 0.05, week: 0.3, month: 0.4 })
    await env.rig.tick() // restore: s-lock STILL skipped, s-free comes back
    expect(env.selects.map(s => s.sessionId)).toEqual(['s-free', 's-free'])
    expect(env.rig.status().policy.lastRestore).toMatchObject({ switched: 1, skipped: 1 })
    expect(env.rig.status().policy.manualLocks).toHaveLength(1)
    // human realigns with the live target (baseline = opencode-go) → unlock
    env.rig.onSelectionEvent('s-lock', BACK)
    expect(env.rig.status().policy.manualLocks).toEqual([])
    env.advance(30_000)
    env.setRatios({ week: 0.995 })
    await env.rig.tick() // next trigger manages s-lock again
    expect(env.selects.map(s => s.sessionId)).toEqual(['s-free', 's-free', 's-lock', 's-free'])
    expect(env.rig.status().policy.lastTrigger).toMatchObject({ switched: 2, skipped: 0 })
  })

  it("the controller's own switch is never read back as a human touch", async () => {
    const env = rig()
    env.tracker.recordRequest('s-active', 10_000_000)
    env.setRatios({ week: 0.995 })
    await env.rig.tick()
    expect(env.selects).toHaveLength(1)
    // the durable event echo arrives late — must not self-lock
    env.rig.onSelectionEvent('s-active', MIMO)
    expect(env.rig.status().policy.manualLocks).toEqual([])
    env.advance(30_000)
    env.setRatios({ fiveHour: 0.05, week: 0.3, month: 0.4 })
    await env.rig.tick() // restore still touches it
    expect(env.selects.map(s => s.sessionId)).toEqual(['s-active', 's-active'])
  })

  it('a touch to the live target never locks (same-value blind spot stays clean)', async () => {
    const env = rig()
    env.rig.onSelectionEvent('s-x', BACK) // baseline target = opencode-go side
    expect(env.rig.status().policy.manualLocks).toEqual([])
    await env.rig.tick()
    expect(env.selects).toEqual([])
  })
})
