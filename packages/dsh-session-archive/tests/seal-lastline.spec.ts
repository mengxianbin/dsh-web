// @vitest-environment node
/**
 * The last-line gate (seal-judge-lastline-1106, 2026-11-06): `judge()` reads
 * only the last assistant message's **last non-empty trimmed line** — the
 * endorsement-line form, isomorphic to the save SKILL's "sentinel line = the
 * completion report's last line", verbatim-same as the m-note scanner's
 * `judge()` (contract C1). Prose quotes of `SAVE_STATUS=` inside the message
 * body no longer read green (live sample: session-8feabd20, verdict DONE →
 * UNSEALED under the gate).
 *
 * Positive/negative trio from the task acceptance (b): last-line endorsement
 * → DONE; body quote (not on the last line) → non-DONE; last-line
 * `SAVE_STATUS=N_A` → N_A. Existing save fixtures keep working because every
 * save fixture ends its sentinel on the last line (checked by seal.spec.ts).
 * @module tests/seal-lastline.spec
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSeal, isGreenSeal } from '../src/host/seal.ts'
import { assistantMsg, createFakeHost, userMsg, writeTranscript, type FakeHost } from './fixtures.ts'

function dirOf(host: FakeHost, id: string): string {
  return join(host.home, 'sessions', '--Users-demo--', id.startsWith('session-') ? id.slice('session-'.length) : id)
}

/** One session = user + assistant; returns the seal read of the last assistant message. */
function seal(events: readonly Record<string, unknown>[]): ReturnType<typeof analyzeSeal> {
  const host = createFakeHost()
  writeTranscript(host, 'session-a', events)
  return analyzeSeal('session-a', dirOf(host, 'session-a'))
}

const ENDORSED_DONE = '三刀全落（`a1` / `b2` / `c3`），status 干净。\n\n## ✅ 执行完成\nSAVE_STATUS=DONE commits=1/1 pushed=1/1 merged=1/1 pushedMain=1/1 marker=clean'
const ENDORSED_NA = '本轮确认无产出。\n\n## ✅ 执行完成\nSAVE_STATUS=N_A'
const BODY_QUOTE_DONE = '讨论归档机制：判据是 merge ∧ SAVE_STATUS=DONE（引自 decision-log 2026-11-04T16:27 条），正文引用不构成收口。\n\n📋 本次对账：+1 新任务 · 0 转进行中 · 0 待你确认完成'
const QUOTE_PLUS_ENDORSED = '正文里提过一句 SAVE_STATUS=DONE 的散文引用（不作数）。\n落点头 `a1b2c34` 已记账。\n\n## ✅ 执行完成\nSAVE_STATUS=DONE commits=1/1 marker=clean'
const PENDING = '还有两步没收口。\n\n## ✅ 执行完成\nSAVE_STATUS=PENDING(2)'
const SAVE_TAIL = '## ✅ 执行完成\n保存状态：执行中，稍后继续'
const CLEAN_REPLY = '这是最后一条普通回复，不含任何保存信号。'

describe('seal last-line gate — seal-judge-lastline-1106', () => {
  it('last-line endorsement line reads DONE (真哨兵不被误杀)', () => {
    const result = seal([userMsg('收口'), assistantMsg(ENDORSED_DONE)])
    expect(result).toMatchObject({ id: 'session-a', verdict: 'DONE', detail: 'sentinel-ok' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('trailing blank lines after the endorsement line still read DONE (末行 = 最后一个非空 trimmed 行)', () => {
    const result = seal([assistantMsg(`${ENDORSED_DONE}\n\n`)])
    expect(result).toMatchObject({ verdict: 'DONE', detail: 'sentinel-ok' })
  })

  it('body quote of SAVE_STATUS=DONE (not on the last line) reads non-DONE (假绿根因反例)', () => {
    const result = seal([userMsg('收口'), assistantMsg(BODY_QUOTE_DONE)])
    expect(result.verdict).not.toBe('DONE')
    expect(result).toMatchObject({ verdict: 'UNSEALED', detail: 'sentinel-stale' })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })

  it('body quote plus a real last-line endorsement still reads DONE (引用不干扰末行判定)', () => {
    const result = seal([assistantMsg(QUOTE_PLUS_ENDORSED)])
    expect(result).toMatchObject({ verdict: 'DONE', detail: 'sentinel-ok' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('last-line SAVE_STATUS=N_A reads N_A', () => {
    const result = seal([userMsg('确认零产出'), assistantMsg(ENDORSED_NA)])
    expect(result).toMatchObject({ id: 'session-a', verdict: 'N_A', detail: 'no-artifacts-by-design' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('last-line SAVE_STATUS=PENDING(2) reads UNSEALED sentinel-pending (三值判定保持)', () => {
    const result = seal([assistantMsg(PENDING)])
    expect(result).toMatchObject({ verdict: 'UNSEALED', detail: 'sentinel-pending' })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })

  it('save trace on the last line without a sentinel reads UNSEALED save-tail (SAVE_TRACE 回落保持)', () => {
    const result = seal([assistantMsg(SAVE_TAIL)])
    expect(result).toMatchObject({ verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })

  it('plain reply with no signals still reads NEUTRAL (中性组不受末行闸影响)', () => {
    const result = seal([userMsg('hello'), assistantMsg(CLEAN_REPLY)])
    expect(result).toMatchObject({ id: 'session-a', verdict: 'NEUTRAL', detail: 'no-save-trace' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })
})
