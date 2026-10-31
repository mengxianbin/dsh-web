import { describe, expect, it } from 'vitest'
import { ActiveSetTracker } from '../src/active-set.ts'

const WINDOW = 30 * 60_000
// Realistic epoch ms: the tracker's `0` sentinel means "no request seen yet",
// so a clock near zero would conflate the two.
const T0 = 1_700_000_000_000

describe('ActiveSetTracker — the set the policy may switch', () => {
  it('includes a session that made a request within the window', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s-recent', T0 - 5 * 60_000)
    expect(tracker.snapshot(T0, WINDOW)).toEqual(['s-recent'])
  })

  it('excludes an idle session whose window lapsed (cold sessions stay untouched)', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s-old', T0 - 31 * 60_000)
    expect(tracker.snapshot(T0, WINDOW)).toEqual([])
  })

  it('keeps a running session regardless of request recency', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s-running', T0 - 60 * 60_000)
    tracker.recordStatus('s-running', true)
    expect(tracker.snapshot(T0, WINDOW)).toEqual(['s-running'])
  })

  it('drops a stopped session with no recent request', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordStatus('s-fresh', true)
    expect(tracker.snapshot(T0, WINDOW)).toEqual(['s-fresh'])
    tracker.recordStatus('s-fresh', false)
    expect(tracker.snapshot(T0, WINDOW)).toEqual([])
  })

  it('never offers a subagent session, even running or recent (resolveAgent refuses it)', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s-child', T0, 'subagent')
    tracker.recordStatus('s-child', true)
    tracker.markSubagent('s-other')
    tracker.recordRequest('s-other', T0)
    expect(tracker.snapshot(T0, WINDOW)).toEqual([])
  })

  it('keeps recency monotonic across duplicate stamps', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s', T0)
    tracker.recordRequest('s', T0 - 1000) // an older replay must not rewind
    tracker.recordStatus('s', false)
    tracker.recordRequest('s', T0 + 500)
    expect(tracker.snapshot(T0 + 600, WINDOW)).toEqual(['s'])
  })

  it('orders the snapshot by newest request first', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s-older', T0 - 10_000)
    tracker.recordRequest('s-newer', T0 - 1_000)
    expect(tracker.snapshot(T0, WINDOW)).toEqual(['s-newer', 's-older'])
  })
})

describe('ActiveSetTracker — prune and view', () => {
  it('prunes lapsed idle entries but keeps running and subagent ones', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s-idle', T0 - 60 * 60_000)
    tracker.recordRequest('s-runs', T0 - 60 * 60_000)
    tracker.recordStatus('s-runs', true)
    tracker.recordRequest('s-kid', T0 - 60 * 60_000, 'subagent')
    tracker.prune(T0, WINDOW)
    expect(tracker.size).toBe(2) // s-idle gone; running + subagent retained
    expect(tracker.snapshot(T0, WINDOW)).toEqual(['s-runs'])
  })

  it('views entries with bound and shape for the status payload', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s-a', T0, 'subagent')
    tracker.recordStatus('s-b', true)
    const view = tracker.view(50)
    expect(view).toHaveLength(2)
    expect(view.find(entry => entry.sessionId === 's-a')).toMatchObject({ subagent: true })
    // A never-requested session carries no lastRequestAt key at all.
    expect(view.find(entry => entry.sessionId === 's-b')).toEqual({ sessionId: 's-b', running: true })
    expect(tracker.view(1)).toHaveLength(1)
  })
})

describe('ActiveSetTracker — selection fold for the reconcile leg (2026-11-01 ruling A)', () => {
  it('folds pending ?? used exactly like the harness model-selection projection', () => {
    const tracker = new ActiveSetTracker()
    // Nothing observed yet: the fold cannot judge (reconcile skips unknown).
    expect(tracker.effectiveRoute('s1')).toBeUndefined()

    // A request header is the first observation: used only.
    tracker.recordRequest('s1', T0, undefined, 'mimo/mimo-v2.6-flash')
    expect(tracker.effectiveRoute('s1')).toBe('mimo/mimo-v2.6-flash')

    // A model/selection event becomes pending and outranks the used route —
    // the NEXT request will use it, which is what reconcile judges.
    tracker.recordSelection('s1', 'opencode-go/mimo-v2.6-flash')
    expect(tracker.effectiveRoute('s1')).toBe('opencode-go/mimo-v2.6-flash')

    // A request that USES the pending route retires it; the route stands as used.
    tracker.recordRequest('s1', T0 + 1000, undefined, 'opencode-go/mimo-v2.6-flash')
    expect(tracker.effectiveRoute('s1')).toBe('opencode-go/mimo-v2.6-flash')
  })

  it('keeps pending alive when a request uses a different route (stale in-flight header)', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordSelection('s1', 'mimo/mimo-v2.6-flash')
    // An in-flight request dispatched on the OLD route lands after the selection.
    tracker.recordRequest('s1', T0, undefined, 'opencode-go/mimo-v2.6-flash')
    // The selection is still pending: the next request uses mimo.
    expect(tracker.effectiveRoute('s1')).toBe('mimo/mimo-v2.6-flash')
  })

  it('keeps the last known used route across a header without one', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s1', T0, undefined, 'opencode-go/mimo-v2.6-flash')
    tracker.recordRequest('s1', T0 + 1000) // shape-guarded header: no config extracted
    expect(tracker.effectiveRoute('s1')).toBe('opencode-go/mimo-v2.6-flash')
  })

  it('carries the fold through status updates and exposes it on the view', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordSelection('s1', 'mimo/mimo-v2.6-flash')
    tracker.recordStatus('s1', true)
    expect(tracker.effectiveRoute('s1')).toBe('mimo/mimo-v2.6-flash')
    expect(tracker.view(50).find(entry => entry.sessionId === 's1')).toMatchObject({ selection: 'mimo/mimo-v2.6-flash' })
  })

  it('prune drops the entry and its fold with it: the next use re-observes', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordRequest('s1', T0, undefined, 'mimo/mimo-v2.6-flash')
    expect(tracker.effectiveRoute('s1')).toBe('mimo/mimo-v2.6-flash')
    tracker.prune(T0 + 60 * 60_000, WINDOW)
    expect(tracker.effectiveRoute('s1')).toBeUndefined()
  })

  it('folds a selection for a session never seen before (born-on-wrong-side detection)', () => {
    const tracker = new ActiveSetTracker()
    tracker.recordSelection('fresh', 'mimo/mimo-v2.6-flash')
    expect(tracker.effectiveRoute('fresh')).toBe('mimo/mimo-v2.6-flash')
    // Not active yet (no request): outside the snapshot until it speaks.
    expect(tracker.snapshot(T0, WINDOW)).toEqual([])
  })
})
