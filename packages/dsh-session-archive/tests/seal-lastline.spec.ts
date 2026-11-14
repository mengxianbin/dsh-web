// @vitest-environment node
/**
 * The last-turn gate (seal-lastturn-1113, 2026-11-14): `judge()` reads each
 * assistant message's **last non-empty trimmed line** inside the last turn
 * (turn = the events after the transcript's last `user/message`), scanned
 * newest-first — the endorsement-line form of the save SKILL's "sentinel
 * line = the completion report's last line", verbatim-same as the m-note
 * scanner's `judge()` (contract C1). It extends the last-line gate
 * (seal-judge-lastline-1106), which collapsed the whole-message search to
 * one line so prose quotes of `SAVE_STATUS=` in a body never read green
 * (live sample: session-8feabd20, verdict DONE → UNSEALED under that gate).
 *
 * Turn scope buys one behaviour the last-line gate could not: a save that
 * completed earlier in the same turn stays DONE when a trailing message
 * follows (the repeat step the old gate demanded of every save), while a
 * sentinel before the last turn still reads `sentinel-stale` (conservative:
 * cross-turn 续聊 keeps the archive-seal-gate 1028 stale-tier one-line pass).
 * The original positive/negative trio still holds: last-line endorsement →
 * DONE; body quote (not on any last line) → non-DONE; last-line
 * `SAVE_STATUS=N_A` → N_A. Existing save fixtures keep working because every
 * save fixture ends its sentinel on the last line (checked by seal.spec.ts).
 * @module tests/seal-lastline
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSeal, isGreenSeal } from '../src/host/seal.ts'
import { assistantMsg, createFakeHost, userMsg, writeTranscript, type FakeHost } from './fixtures.ts'

function dirOf(host: FakeHost, id: string): string {
  return join(host.home, 'sessions', '--Users-demo--', id.startsWith('session-') ? id.slice('session-'.length) : id)
}

/** One transcript; returns the seal read under the last-turn gate. */
function seal(events: readonly Record<string, unknown>[]): ReturnType<typeof analyzeSeal> {
  const host = createFakeHost()
  writeTranscript(host, 'session-a', events)
  return analyzeSeal('session-a', dirOf(host, 'session-a'))
}

interface EndorsedRepo {
  dir: string
  hash: string
}

let repoCache: EndorsedRepo | undefined

/** A real git repo whose commit sits behind an origin remote-tracking ref (hermetic endorsement fixture, 1107 声明-核验同款). */
function endorsedRepo(): EndorsedRepo {
  if (repoCache !== undefined) return repoCache
  const dir = mkdtempSync(join(tmpdir(), 'seal-lastline-'))
  const run = (args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  run(['init', '-q'])
  run(['config', 'user.email', 'seal@test'])
  run(['config', 'user.name', 'seal'])
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'seed'])
  const hash = run(['rev-parse', 'HEAD']).trim()
  run(['update-ref', 'refs/remotes/origin/main', hash])
  repoCache = { dir, hash }
  return repoCache
}

/** Transcript root event carrying the session cwd — repoCandidates resolves the session's own repo first. */
function sessionRoot(id: string, cwd: string): Record<string, unknown> {
  return { type: 'session', version: 4, id, cwd }
}

const ENDORSED_NA = '本轮确认无产出。\n\n## \u2705 执行完成\nSAVE_STATUS=N_A'
const BODY_QUOTE_DONE = '讨论归档机制：判据是 merge ∧ SAVE_STATUS=DONE（引自 decision-log 2026-11-04T16:27 条），正文引用不构成收口。\n\n\u{1F4CB} 本次对账：+1 新任务 · 0 转进行中 · 0 待你确认完成'
const PENDING = '还有两步没收口。\n\n## \u2705 执行完成\nSAVE_STATUS=PENDING(2)'
const SAVE_TAIL = '## \u2705 执行完成\n保存状态：执行中，稍后继续'
const CLEAN_REPLY = '这是最后一条普通回复，不含任何保存信号。'
const TRAILING = '后台 job 已确认跑完，无其他变更。'
const NEXT_TURN_REPLY = '新一轮的普通回复，没有任何保存信号。'

/**
 * 末行背书行 + 活 hash 声明清单（seal-declare-verify-1107 契约：commits= 必须有活 hash
 * 背书，否则 fail-closed no-endorsement）。夹具从 1106 无背书形态升到 1107 声明形态——
 * 末行判定本身（judge 读哪一行）零改动，只给它合规的背书材料。
 */
function endorsedDone(repo: EndorsedRepo): string {
  return `三刀全落（\`a1\` / \`b2\` / \`c3\`），status 干净。\n\n## \u2705 执行完成\nSAVE_STATUS=DONE commits=1/1 pushed=1/1 merged=1/1 pushedMain=1/1 marker=clean hashes=${repo.hash}`
}

/**
 * 正文引用 SAVE_STATUS=DONE + 死 7 位 hash（清单外散文），活背书只在尾行声明清单里——
 * 1107 双语义：末行判定不被正文引用干扰，清单外散文 hash 不核。
 */
function quotePlusEndorsed(repo: EndorsedRepo): string {
  return `正文里提过一句 SAVE_STATUS=DONE 的散文引用（不作数）。\n落点头 \`a1b2c34\` 已记账。\n\n## \u2705 执行完成\nSAVE_STATUS=DONE commits=1/1 marker=clean hashes=${repo.hash}`
}

describe('seal last-turn gate — seal-lastturn-1113 (extends seal-judge-lastline-1106)', () => {
  it("operator's last-line endorsement reads DONE when the save report closes the turn", () => {
    // Given a session rooted in the endorsed repo, one prompt, and the save report as the last message
    const repo = endorsedRepo()
    const result = seal([sessionRoot('session-a', repo.dir), userMsg('收口'), assistantMsg(endorsedDone(repo))])
    // When the gate reads the last turn
    // Then the verdict is DONE and the light stays green
    expect(result).toMatchObject({ id: 'session-a', verdict: 'DONE', detail: 'sentinel-ok' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it("operator's endorsement with trailing blank lines reads DONE when only whitespace follows", () => {
    // Given an endorsement line followed by empty lines inside one message
    const repo = endorsedRepo()
    const result = seal([sessionRoot('session-a', repo.dir), assistantMsg(`${endorsedDone(repo)}\n\n`)])
    // When the gate takes the last non-empty trimmed line
    // Then the verdict is DONE
    expect(result).toMatchObject({ verdict: 'DONE', detail: 'sentinel-ok' })
  })

  it("operator's body quote of SAVE_STATUS=DONE reads non-DONE when no last line carries it", () => {
    // Given a message whose body quotes SAVE_STATUS=DONE but whose last line is bookkeeping prose
    const result = seal([userMsg('收口'), assistantMsg(BODY_QUOTE_DONE)])
    // When the gate looks only at last lines across the turn
    // Then the quote never goes green: the verdict is the stale tier
    expect(result.verdict).not.toBe('DONE')
    expect(result).toMatchObject({ verdict: 'UNSEALED', detail: 'sentinel-stale' })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })

  it("operator's body quote plus a real endorsement reads DONE when the endorsement sits on a last line", () => {
    // Given one message carrying both a prose quote and a real endorsement on its last line
    const repo = endorsedRepo()
    const result = seal([sessionRoot('session-a', repo.dir), assistantMsg(quotePlusEndorsed(repo))])
    // When the gate judges the last line only
    // Then the real endorsement wins and the quote is ignored
    expect(result).toMatchObject({ verdict: 'DONE', detail: 'sentinel-ok' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it("operator's SAVE_STATUS=N_A on the last line reads N_A", () => {
    // Given a zero-output report whose last line declares SAVE_STATUS=N_A
    const result = seal([userMsg('确认零产出'), assistantMsg(ENDORSED_NA)])
    // When the gate parses the three-value sentinel
    // Then the verdict is N_A and the light stays green
    expect(result).toMatchObject({ id: 'session-a', verdict: 'N_A', detail: 'no-artifacts-by-design' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it("operator's SAVE_STATUS=PENDING(2) on the last line reads UNSEALED sentinel-pending", () => {
    // Given a report whose last line declares SAVE_STATUS=PENDING(2)
    const result = seal([assistantMsg(PENDING)])
    // When the gate parses the three-value sentinel
    // Then the verdict is the pending tier, not green
    expect(result).toMatchObject({ verdict: 'UNSEALED', detail: 'sentinel-pending' })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })

  it("operator's save trace on the last line without a sentinel reads UNSEALED save-tail", () => {
    // Given a save that printed progress but died before any sentinel
    const result = seal([assistantMsg(SAVE_TAIL)])
    // When the gate finds the save trace on the last line
    // Then the verdict is the save-tail tier, not green
    expect(result).toMatchObject({ verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })

  it("operator's plain reply reads NEUTRAL when the transcript carries no signals", () => {
    // Given a chat with neither a sentinel nor a save trace nor work traces
    const result = seal([userMsg('hello'), assistantMsg(CLEAN_REPLY)])
    // When the gate falls through to the neutral group
    // Then the verdict is NEUTRAL and the light stays green
    expect(result).toMatchObject({ id: 'session-a', verdict: 'NEUTRAL', detail: 'no-save-trace' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it("operator's completed save stays DONE when a trailing message follows in the same turn", () => {
    // Given one turn whose save report carries the endorsement and a later message in the same turn says nothing
    const repo = endorsedRepo()
    const result = seal([
      sessionRoot('session-a', repo.dir),
      userMsg('收口'),
      assistantMsg(endorsedDone(repo)),
      assistantMsg(TRAILING),
    ])
    // When the gate scans the turn newest-first and falls back to the endorsed message
    // Then the verdict is DONE — the repeat step the last-line gate demanded is no longer needed
    expect(result).toMatchObject({ verdict: 'DONE', detail: 'sentinel-ok' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it("operator's earlier-turn save reads sentinel-stale when a new user message continues the conversation", () => {
    // Given a save that completed in an earlier turn and a fresh prompt with a clean reply after it
    const repo = endorsedRepo()
    const result = seal([
      sessionRoot('session-a', repo.dir),
      userMsg('收口'),
      assistantMsg(endorsedDone(repo)),
      userMsg('再问一句'),
      assistantMsg(NEXT_TURN_REPLY),
    ])
    // When the gate scopes judgement to the last turn
    // Then the old sentinel stays outside it: the conservative stale tier with its follow-up count
    expect(result).toMatchObject({ verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 2 })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })

  it("operator's newest signal decides when two messages in the turn carry different sentinels", () => {
    // Given one turn whose older message ends PENDING(2) and newer message ends with the endorsed DONE
    const repo = endorsedRepo()
    const pendingFirst = seal([
      sessionRoot('session-a', repo.dir),
      userMsg('收口'),
      assistantMsg(PENDING),
      assistantMsg(endorsedDone(repo)),
    ])
    // When the gate scans newest-first
    // Then the newest signal wins: the DONE verdict
    expect(pendingFirst).toMatchObject({ verdict: 'DONE', detail: 'sentinel-ok' })
    // Given the mirror turn: older DONE, newer PENDING(2)
    const doneFirst = seal([
      sessionRoot('session-a', repo.dir),
      userMsg('收口'),
      assistantMsg(endorsedDone(repo)),
      assistantMsg(PENDING),
    ])
    // When the gate scans newest-first again
    // Then the newest signal wins: the pending tier
    expect(doneFirst).toMatchObject({ verdict: 'UNSEALED', detail: 'sentinel-pending' })
  })

  it("operator's older save trace reads UNSEALED save-tail when no sentinel follows in the turn", () => {
    // Given one turn whose save printed progress and a later clean message followed it
    const result = seal([
      sessionRoot('session-a', 'C:\\repo'),
      userMsg('收口'),
      assistantMsg(SAVE_TAIL),
      assistantMsg(TRAILING),
    ])
    // When the gate walks the turn newest-first down to the save-trace line
    // Then the verdict is the save-tail tier — the save ran in this turn and no sentinel ever landed
    expect(result).toMatchObject({ verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })
})
