import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LogRecord, PolicyRecord } from '../src/policy.ts'
import { classifySweepRow, makeListRows, runBootSweep, scanOpenTurn, type BootSweepDeps, type SweepListApi, type SweepRow } from '../src/sweep.ts'

function row(sessionId: string, extra: Partial<SweepRow> = {}): SweepRow {
  return { sessionId, running: false, agentAvailable: false, ...extra }
}

function ev(type: string, data: Record<string, unknown> = {}): SessionEvent {
  return { seq: 1, time: 0, type, data } as unknown as SessionEvent
}

const TB_OPEN = { values: { turnBoundary: { openTurnStartSeq: 7 } } }
const TB_CLOSED = { values: { turnBoundary: { openTurnStartSeq: null } } }

interface Sinks {
  decided: Array<{ sessionId: string; at: number; contextTokens: number | undefined }>
  applied: PolicyRecord[][]
  logged: LogRecord[]
  reads: string[]
}

function makeDeps(
  listRows: BootSweepDeps['listRows'],
  extra: Partial<BootSweepDeps> = {},
): { deps: BootSweepDeps; sinks: Sinks } {
  const sinks: Sinks = { decided: [], applied: [], logged: [], reads: [] }
  const deps: BootSweepDeps = {
    listRows,
    readEvents: async () => [],
    isAttached: () => false,
    decide: (sessionId, at, contextTokens) => {
      sinks.decided.push({ sessionId, at, contextTokens })
      return [{ kind: 'decision', at, sessionId, chainId: sessionId, action: 'revive', reason: 'ok' }]
    },
    apply: (records) => {
      sinks.applied.push([...records])
    },
    log: (record) => {
      sinks.logged.push(record)
    },
    now: () => 1000,
    signal: new AbortController().signal,
    retryMs: 1,
    ...extra,
  }
  return { deps, sinks }
}

function summary(sinks: Sinks): LogRecord | undefined {
  return sinks.logged.find((record) => record.event === 'boot-sweep')
}

function failures(sinks: Sinks): LogRecord[] {
  return sinks.logged.filter((record) => record.event === 'boot-sweep-failed')
}

describe('list-row screen (turnBoundary projection)', () => {
  it('classifies live, closed, candidate, and checkpoint-less rows', () => {
    expect(classifySweepRow(row('L', { running: true }))).toBe('live')
    expect(classifySweepRow(row('A', { agentAvailable: true }))).toBe('live')
    expect(classifySweepRow(row('C', { projections: TB_CLOSED }))).toBe('closed')
    expect(classifySweepRow(row('O', { projections: TB_OPEN }))).toBe('candidate')
    expect(classifySweepRow(row('N'))).toBe('unknown')
    expect(classifySweepRow(row('X', { projections: { values: {} } }))).toBe('unknown')
  })
})

describe('controller list binding (makeListRows)', () => {
  // Regression: the binding once promised a bare array while the controller
  // returns the SessionListValue envelope ({ items }), so the first real boot
  // died at `for...of` with "rows is not iterable" and screened nothing.
  it('unwraps the { items } envelope the controller actually returns', async () => {
    const rows = [row('a'), row('b')]
    const controller: SweepListApi = { list: async () => ({ items: rows }) }
    const listRows = makeListRows(controller)
    await expect(listRows(new AbortController().signal)).resolves.toEqual(rows)
  })

  it('passes the ruled row-scope request (archived excluded, heavy projections trimmed)', async () => {
    const seen: unknown[] = []
    const controller: SweepListApi = {
      list: async (request) => {
        seen.push(request)
        return { items: [] }
      },
    }
    await makeListRows(controller)(new AbortController().signal)
    expect(seen).toEqual([{ includeArchived: false, trimHeavyProjections: true }])
  })

  it('drives the sweep end to end through the envelope without failing', async () => {
    const controller: SweepListApi = {
      list: async () => ({ items: [row('cand', { projections: TB_OPEN })] }),
    }
    const { deps, sinks } = makeDeps(makeListRows(controller))
    deps.readEvents = async () => [ev('turn/start')]
    await runBootSweep(deps)
    expect(failures(sinks)).toHaveLength(0)
    expect(sinks.decided).toEqual([{ sessionId: 'cand', at: 1000, contextTokens: undefined }])
    expect(summary(sinks)?.detail).toMatchObject({ rows: 1, candidates: 1, revived: 1 })
  })
})

describe('raw tail balance (scanOpenTurn)', () => {
  it('reports an open tail turn and folds the latest usage', () => {
    expect(scanOpenTurn([])).toEqual({ open: false })
    expect(scanOpenTurn([ev('turn/start')])).toEqual({ open: true })
    expect(scanOpenTurn([ev('turn/start'), ev('turn/end')])).toEqual({ open: false })
    const scan = scanOpenTurn([
      ev('turn/start'),
      ev('assistant/message', { usage: { inputTokens: 100, cacheReadTokens: 50 } }),
      ev('assistant/message', { usage: { inputTokens: 120 } }),
      ev('turn/end'),
      ev('turn/start'),
    ])
    expect(scan).toEqual({ open: true, contextTokens: 120 })
    // A committed `interrupted` closer is still a `turn/end`: closed.
    expect(scanOpenTurn([ev('turn/start'), ev('turn/end', { reason: { kind: 'interrupted' } })])).toEqual({ open: false })
  })

  it('folds the route the stored log proves, selection pending over request header', () => {
    // A selection nobody used yet is what the next request would take.
    expect(scanOpenTurn([ev('turn/start'), ev('model/selection', { provider: 'pi', model: 'm1' })]).route).toEqual({
      provider: 'pi',
      model: 'm1',
    })
    // The header alone still proves the route when no selection was ever logged.
    expect(
      scanOpenTurn([ev('request/header', { header: { config: { provider: 'ds', model: 'old' } } })]).route,
    ).toEqual({ provider: 'ds', model: 'old' })
    // A selection applies from the next request: it wins over an older header.
    expect(
      scanOpenTurn([
        ev('request/header', { header: { config: { provider: 'ds', model: 'old' } } }),
        ev('model/selection', { provider: 'pi', model: 'new' }),
      ]).route,
    ).toEqual({ provider: 'pi', model: 'new' })
    // A different header does not retire the pending selection (same fold as
    // the harness's modelSelection projection).
    expect(
      scanOpenTurn([
        ev('model/selection', { provider: 'pi', model: 'new' }),
        ev('request/header', { header: { config: { provider: 'ds', model: 'old' } } }),
      ]).route,
    ).toEqual({ provider: 'pi', model: 'new' })
    // No route evidence at all: no route key (the gate stays fail-closed).
    expect(scanOpenTurn([ev('turn/start')]).route).toBeUndefined()
  })
})

describe('boot sweep orchestration', () => {
  it('screens rows, confirms candidates by raw read, and decides only confirmed orphans', async () => {
    const { deps, sinks } = makeDeps(async () => [
      row('cand', { projections: TB_OPEN }),
      row('unk'),
      row('closedRow', { projections: TB_CLOSED }),
      row('liveRow', { running: true }),
    ])
    deps.readEvents = async (sessionId) => {
      sinks.reads.push(sessionId)
      return sessionId === 'cand'
        ? [ev('turn/start'), ev('assistant/message', { usage: { inputTokens: 100, cacheReadTokens: 50 } })]
        : [ev('turn/start'), ev('turn/end')]
    }
    await runBootSweep(deps)
    expect(sinks.reads).toEqual(['cand', 'unk'])
    expect(sinks.decided).toEqual([{ sessionId: 'cand', at: 1000, contextTokens: 150 }])
    expect(sinks.applied).toHaveLength(1)
    expect(summary(sinks)?.detail).toEqual({
      rows: 4,
      live: 1,
      closed: 1,
      candidates: 2,
      unknown: 1,
      reads: 2,
      revived: 1,
      parked: 0,
      confirmedClosed: 1,
      attached: 0,
    })
    expect(failures(sinks)).toHaveLength(0)
  })

  it('seeds the machine route from the stored log before deciding the confirmed orphan', async () => {
    const order: string[] = []
    const { deps, sinks } = makeDeps(async () => [row('cand', { projections: TB_OPEN })], {
      seedRoute: (sessionId, route) => order.push(`seed:${sessionId}:${route.provider}`),
    })
    const decide = deps.decide
    deps.decide = (sessionId, at, contextTokens) => {
      order.push(`decide:${sessionId}`)
      return decide(sessionId, at, contextTokens)
    }
    deps.readEvents = async () => [
      ev('turn/start'),
      ev('request/header', { header: { config: { provider: 'pi', model: 'm1' } } }),
    ]
    await runBootSweep(deps)
    // Route evidence lands before the decision, so the v2 gate never sees a
    // boot decision without a route.
    expect(order).toEqual(['seed:cand:pi', 'decide:cand'])
    expect(failures(sinks)).toHaveLength(0)
  })

  it('retries a listing that rejects during boot readiness', async () => {
    let calls = 0
    const { deps, sinks } = makeDeps(async () => {
      calls += 1
      if (calls === 1) throw new Error('listState not ready')
      return [row('cand', { projections: TB_OPEN })]
    })
    deps.readEvents = async () => [ev('turn/start')]
    await runBootSweep(deps)
    expect(calls).toBe(2)
    expect(sinks.decided).toHaveLength(1)
    expect(failures(sinks)).toHaveLength(0)
  })

  it('falls through to raw reads when no row carries a turnBoundary (projection-less deployment)', async () => {
    let calls = 0
    const { deps, sinks } = makeDeps(async () => {
      calls += 1
      return [row('plain')]
    })
    deps.readEvents = async () => [ev('turn/end')]
    await runBootSweep(deps)
    expect(calls).toBeGreaterThan(1)
    expect(sinks.decided).toHaveLength(0)
    expect(summary(sinks)?.detail).toMatchObject({ candidates: 1, confirmedClosed: 1 })
  })

  it('gives up with a loud line when the listing never answers', async () => {
    const { deps, sinks } = makeDeps(async () => {
      throw new Error('boom')
    })
    await runBootSweep(deps)
    expect(sinks.decided).toHaveLength(0)
    expect(failures(sinks)).toHaveLength(1)
    expect(failures(sinks)[0]?.detail).toMatchObject({ stage: 'list' })
    expect(summary(sinks)).toBeUndefined()
  })

  it('fails closed when the persistence seam is missing and candidates exist', async () => {
    const { deps, sinks } = makeDeps(async () => [row('cand', { projections: TB_OPEN })], { readEvents: undefined })
    await runBootSweep(deps)
    expect(sinks.decided).toHaveLength(0)
    expect(failures(sinks)[0]?.detail).toMatchObject({ stage: 'read' })
    expect(summary(sinks)).toBeUndefined()
  })

  it('never decides a session that attached between list and read', async () => {
    const { deps, sinks } = makeDeps(async () => [row('cand', { projections: TB_OPEN })], {
      isAttached: () => true,
    })
    deps.readEvents = async () => [ev('turn/start')]
    await runBootSweep(deps)
    expect(sinks.decided).toHaveLength(0)
    expect(summary(sinks)?.detail).toMatchObject({ revived: 0, attached: 1 })
  })

  it('stops quietly when the sweep was aborted before it started', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const { deps, sinks } = makeDeps(async () => {
      called = true
      return []
    })
    deps.signal = controller.signal
    await runBootSweep(deps)
    expect(called).toBe(false)
    expect(sinks.logged).toHaveLength(0)
  })

  it('contains a per-session read failure without abandoning the sweep', async () => {
    const { deps, sinks } = makeDeps(async () => [
      row('bad', { projections: TB_OPEN }),
      row('good', { projections: TB_OPEN }),
    ])
    deps.readEvents = async (sessionId) => {
      if (sessionId === 'bad') throw new Error('gone')
      return [ev('turn/start')]
    }
    await runBootSweep(deps)
    expect(sinks.decided.map((entry) => entry.sessionId)).toEqual(['good'])
    expect(failures(sinks)).toHaveLength(1)
    expect(failures(sinks)[0]).toMatchObject({ sessionId: 'bad' })
    expect(summary(sinks)?.detail).toMatchObject({ revived: 1 })
  })
})
