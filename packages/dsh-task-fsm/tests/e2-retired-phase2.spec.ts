/**
 * E2 retirement fixture (freeze-reclaim-phase2-1127 分期4, 裁定 #19): the
 * transition-table deletion AND the ledger migration must be green together.
 *
 * ① Event set: 20 events (E1, E3–E21); no cell, no label, no pin carries the
 *    former 开工核验过 event — `cellFor` answers undefined for it.
 * ② Migration (the load-bearing half): real ledgers still carry its history
 *    entries (8 in the live file at dispatch time) and `parseFsmFile`
 *    fail-closes on unknown events, so the read face tolerates it exactly
 *    like the rebind marks (`RETIRED_EVENTS`) — a legacy record parses and
 *    round-trips byte-identical.
 * ③ Unfirable: the transition route rejects it at the face (400) — the
 *    tolerance is read-only, never a write path.
 * ④ Hover rendering: a legacy entry still gets its label (frozen fallback).
 *
 * test-standards-allow: dsh-task-fsm machine-behavior fixture — no user role
 * exists for an event-set retirement (bdd-title would be fiction, the script
 * header says so itself); bodies are seed -> act -> assert (corpus style).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  EVENT_LABELS, EVENTS, MATRIX, cellFor, type EventId,
} from '../src/core/table.ts'
import { parseFsmFile, type FsmFile, type HistoryEntry } from '../src/core/schema.ts'
import { deriveSubReasons } from '../src/core/subreason.ts'
import { makeTaskFsmRoutes } from '../src/host/routes.ts'
import { FsmStore } from '../src/host/store.ts'

const LEGACY_REF = 'content/tech/ai/dsh/tasks.md#e2-retired-legacy'

interface FakeRes {
  status: number
  body: string
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
}

function fakeRes(): FakeRes {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { if (body !== undefined) this.body = body.toString() },
  }
}

/** A legacy record exactly as the live ledger carries it (E1 then E2). */
function legacyRecord() {
  const history: HistoryEntry[] = [
    { event: 'E1', from: 'backlog', to: 'active', at: '2026-11-26T10:00:00.000Z' },
    { event: 'E2', from: 'active', to: 'active', at: '2026-11-26T10:00:01.000Z' },
  ]
  return {
    version: 1 as const,
    taskRef: LEGACY_REF,
    scope: 'content/tech/ai/dsh',
    state: 'active' as const,
    queue: 'none' as const,
    title: 'e2 退役夹具·存量行',
    attempts: { redisp: 0, autofix: 0 },
    session: { id: 'sess-legacy', mode: 'frozen' as const, reason: '排队位：等待开工核验' },
    history,
  }
}

function legacyFile(): FsmFile {
  return {
    version: 1,
    scopes: { 'content/tech/ai/dsh': { intent: '', prio: 'yellow', declaredAt: '2026-11-26T10:00:00.000Z' } },
    tasks: { [LEGACY_REF]: legacyRecord() },
  } as FsmFile
}

describe('E2 退役 · 事件面（表 / 标签 / 单元格全数摘除）', () => {
  it('the event set is exactly 20 events (E1, E3–E21) with no label entry', () => {
    expect(EVENTS).toHaveLength(20)
    expect(EVENTS).not.toContain('E2' as EventId)
    expect(EVENTS[0]).toBe('E1')
    expect(EVENTS[1]).toBe('E3') // numeric order with the hole closed
    expect(Object.keys(EVENT_LABELS)).toHaveLength(20)
    expect('E2' in EVENT_LABELS).toBe(false)
  })

  it('no matrix cell exists for the retired event (undefined = completeness hole, now by design)', () => {
    for (const state of ['backlog', 'active', 'deferred', 'blocked', 'done', 'cancelled'] as const) {
      expect(cellFor(state, 'E2' as EventId), `${state} cell`).toBeUndefined()
      expect('E2' in MATRIX[state].transfer).toBe(false)
      expect('E2' in MATRIX[state].forbid).toBe(false)
      expect('E2' in MATRIX[state].na).toBe(false)
    }
  })
})

describe('E2 退役 · 迁移面（存量史条目只读容忍）', () => {
  it('a legacy record carrying retired-event history parses instead of fail-closing the ledger', () => {
    const parsed = parseFsmFile(legacyFile())
    expect(parsed.tasks[LEGACY_REF].history.map((h) => h.event)).toEqual(['E1', 'E2'])
    // Round-trip: the tolerance is lossless (history preserved verbatim).
    expect(JSON.parse(JSON.stringify(parsed.tasks[LEGACY_REF].history))).toEqual(legacyFile().tasks[LEGACY_REF].history)
  })

  it('an actually-unknown event still fail-closes (the tolerance is a closed list, not a free pass)', () => {
    const file = legacyFile()
    ;(file.tasks[LEGACY_REF].history as HistoryEntry[]).push(
      { event: 'E99' as unknown as HistoryEntry['event'], from: 'active', to: 'active', at: '2026-11-26T11:00:00.000Z' },
    )
    expect(() => parseFsmFile(file)).toThrow(/unknown event "E99"/)
  })

  it('the hover four-piece still renders a legacy entry through the frozen label', () => {
    const parsed = parseFsmFile(legacyFile())
    const view = deriveSubReasons(parsed.tasks[LEGACY_REF])
    expect(view.why).toContain('开工核验过（已退役）（E2）→ active')
  })
})

describe('E2 退役 · 发射面（路由拒绝，容忍只读不回写）', () => {
  it('the transition route answers 400 for the retired event (not in the EVENTS whitelist)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fsm-e2-retired-'))
    try {
      const store = new FsmStore(join(dir, 'task-fsm-state.json'))
      store.save(legacyFile())
      const routes = makeTaskFsmRoutes({ store, dshHome: dir, maxRedisp: 3 })
      const transition = routes.find((r) => r.path === '/api/task-fsm/transition')
      if (transition === undefined) throw new Error('transition route missing')

      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ taskRef: LEGACY_REF, event: 'E2' }), 'utf8')]), {
        method: 'POST',
        url: transition.path,
        headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as IncomingMessage
      const res = fakeRes()
      await transition.handler(req, res as unknown as ServerResponse)
      expect(res.status).toBe(400)
      expect(res.body).toContain('E1|E3..E21')
      // Zero write: the refusal happens before any store.update.
      expect(store.load().tasks[LEGACY_REF].history).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
