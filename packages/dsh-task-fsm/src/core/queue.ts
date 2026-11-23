/**
 * Queue tier derivation (C 轴) — design §4.1 红 / 黄 / 不入三分. The queue is
 * a DERIVED field (§2.2): this function recomputes it from the record's
 * state + cause + counters + pendingAck, so the stored value can never drift
 * from the judgment table. Red purity is the point of §4.3 (gap-H 病灶):
 * 主动中止 / 可修机检红 / 配额排队 never enter the red or yellow tiers.
 * @module @linxin666/dsh-task-fsm/core/queue
 */

import type { QueueTier, TaskRecord } from './schema.ts'

/** Why a record sits in a tier — hover 子原因 input (§4.2). */
export interface QueueVerdict {
  tier: QueueTier
  /** Machine cause id that decided the tier (design §4.1 row anchor). */
  reason: string
  /** Design-row label of the tier (红 / 黄 / 不入). */
  label: '红' | '黄' | '不入' | '—'
  /** 例 (§4.1) — the concrete design example this verdict matches. */
  example: string
}

/** Causes that mean the human must rule (黄档 §4.1). */
const YELLOW_CAUSES = new Set(['prereq-unruled', 'awaiting-ack'])
/** Causes that mean 熔断 / 真异常 (红档 §4.1). */
const RED_CAUSES = new Set(['autofix-blowout', 'redisp-blowout', 'irreversible', 'true-anomaly'])

/**
 * Derive the queue tier for one record (§4.1 三分, in judgment order:
 * red wins ties — a blocked-red task that also awaits a receipt stays red).
 * @param record - the task record.
 * @returns the verdict (tier + reason + design-row label).
 */
export function deriveQueue(record: TaskRecord): QueueVerdict {
  if (record.state === 'done' || record.state === 'cancelled') {
    // 终态：待查收子注是唯一入队理由（根终态黄, §5）；其余终态不入。
    if (record.state === 'done' && record.pendingAck === true) {
      return { tier: 'yellow', reason: 'awaiting-ack', label: '黄', example: '根 worker 终态等人查收（E18）' }
    }
    return { tier: 'none', reason: 'terminal', label: '不入', example: '终态已定（E15 主动中止 / 已查收）' }
  }
  if (record.state === 'blocked') {
    const cause = record.cause ?? ''
    if (RED_CAUSES.has(cause)) {
      return { tier: 'red', reason: cause, label: '红', example: redExample(cause) }
    }
    if (cause === 'criterion-dispute') {
      return { tier: 'yellow', reason: cause, label: '黄', example: '判据争议（三例外②，判据本体只归用户）' }
    }
    if (cause === 'chain-dead') {
      // 断链可修（E14 机械重派走 revive 管线）→ 「可修机检红」族不入；
      // 重派到 N 次熔断时 cause 翻 redisp-blowout 才进红。
      return { tier: 'none', reason: cause, label: '不入', example: '断链机械重派中（可修，不占红黄位）' }
    }
    // 阻塞但原因未入判据表 = 真异常兜底进红（fail-closed：宁红勿漏）。
    return { tier: 'red', reason: cause || 'blocked-unknown', label: '红', example: '阻塞原因未知（fail-closed 入红）' }
  }
  if (record.state === 'deferred') {
    const cause = record.cause ?? 'prereq-unruled'
    if (YELLOW_CAUSES.has(cause)) {
      return { tier: 'yellow', reason: cause, label: '黄', example: '缺前置未裁（前置任务未裁定卡下游）' }
    }
    return { tier: 'yellow', reason: cause, label: '黄', example: '等前置未终态（[/] ⏸）' }
  }
  // backlog / active：等外部（配额排队走冻结行）、轮换节拍、可修机检红（E9 修轮中）一律不入。
  const cause = record.cause ?? ''
  if (cause === 'quota-wait') {
    return { tier: 'none', reason: cause, label: '不入', example: '配额排队（走冻结行不占红黄位）' }
  }
  if (record.attempts.autofix > 0 && record.state === 'active') {
    return { tier: 'none', reason: 'autofix-running', label: '不入', example: '可修机检红（E9 自动修轮中）' }
  }
  return { tier: 'none', reason: cause || 'idle', label: '不入', example: '进行中/待办无入队理由（轮换节拍同此档）' }
}

function redExample(cause: string): string {
  switch (cause) {
    case 'autofix-blowout': return '修 N 轮熔断（E10）'
    case 'redisp-blowout': return '重派 N 次熔断'
    case 'irreversible': return '不可逆损害留人（三例外③）'
    default: return '机检真红'
  }
}

/** Convenience: the tier alone. */
export function queueTier(record: TaskRecord): QueueTier {
  return deriveQueue(record).tier
}
