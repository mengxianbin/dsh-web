/**
 * Run lookup, run-status vocabulary and run timestamps for the agents page.
 *
 * The wire carries a flat run list; the page only ever needs the newest run of
 * one member, every run of one squad, and the newest whole-squad run. This
 * module owns those reductions plus the label and the tone each status reads
 * as - the member card, the live roster and the run history all take them from
 * here, so no surface re-derives a status.
 */
import { t } from './locales.ts'
import type { RunRecord } from '../protocol.ts'

/**
 * Visual tone of one status. The glyph and the tone class both read it, and
 * neither is the only carrier: every status also renders its own text label, so
 * colour is never the sole signal.
 */
export type StatusTone = 'pending' | 'active' | 'success' | 'error'

/** How many of a squad's runs the history lists. The Host keeps 200. */
export const RUN_HISTORY_LIMIT = 20

/**
 * The newest run of one member, or undefined when it never ran.
 * @param runs - every run the Host published.
 * @param teamId - squad the member belongs to.
 * @param memberId - the member.
 */
export function latestRunFor(runs: readonly RunRecord[], teamId: string, memberId: string): RunRecord | undefined {
  let latest: RunRecord | undefined
  for (const run of runs) {
    if (run.teamId !== teamId || run.memberId !== memberId) continue
    if (latest === undefined || run.createdAt >= latest.createdAt) latest = run
  }
  return latest
}

/**
 * Which kind one run is. M1 records carry no `kind`, and by construction every
 * one of them launched a member session.
 * @param run - the run record.
 */
export function runKindOf(run: RunRecord): 'squad' | 'member' {
  return run.kind === 'squad' ? 'squad' : 'member'
}

/**
 * Every run of one squad - squad runs and member runs together - newest first.
 * @param runs - every run the Host published.
 * @param teamId - the squad to list.
 * @param limit - how many rows to keep; the newest win.
 */
export function squadRunsOf(runs: readonly RunRecord[], teamId: string, limit = RUN_HISTORY_LIMIT): RunRecord[] {
  return runs
    .filter(run => run.teamId === teamId)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit)
}

/**
 * The newest whole-squad run of one squad; its session is the Lead the live
 * roster belongs to.
 * @param runs - every run the Host published.
 * @param teamId - the squad to look at.
 */
export function newestSquadRun(runs: readonly RunRecord[], teamId: string): RunRecord | undefined {
  let newest: RunRecord | undefined
  for (const run of runs) {
    if (run.teamId !== teamId || runKindOf(run) !== 'squad') continue
    if (newest === undefined || run.createdAt > newest.createdAt) newest = run
  }
  return newest
}

/** The localized state of one run. */
export function runStatusLabel(run: RunRecord): string {
  if (run.status === 'settled') return t('member.status.settled')
  if (run.status === 'failed') return t('member.status.failed')
  return t('member.status.running')
}

/**
 * The tone of one run's status, for the glyph and the status colour slot.
 * @param run - the run record.
 */
export function runStatusTone(run: RunRecord): StatusTone {
  if (run.status === 'settled') return 'success'
  if (run.status === 'failed') return 'error'
  return 'active'
}

/**
 * The machine-readable instant of one run, for a `<time dateTime>`: the stable
 * value a test can assert without depending on the reader's time zone.
 * @param run - the run record.
 */
export function runTimeIso(run: RunRecord): string {
  return new Date(run.createdAt).toISOString()
}

/**
 * The reader's own date and time for one run. Falls back to the ISO instant for
 * a runtime that cannot format it, so a row never renders an empty cell.
 * @param run - the run record.
 */
export function runTimeLabel(run: RunRecord): string {
  const lang = typeof document === 'undefined' ? '' : document.documentElement.lang
  try {
    return new Intl.DateTimeFormat(lang === '' ? undefined : lang, { dateStyle: 'short', timeStyle: 'short' }).format(run.createdAt)
  } catch {
    return runTimeIso(run)
  }
}
