/**
 * Hover sub-reason four-piece (design §4.2): 等什么 / 为什么 / 谁 / 下一步.
 * Data source = task-fsm-state.json (`queue` + `reason` + history 末转移),
 * zero new storage. Pure derivation — the browser half renders verbatim.
 * @module @linxin666/dsh-task-fsm/core/subreason
 */

import type { TaskRecord } from './schema.ts'
import { deriveQueue } from './queue.ts'
import { EVENT_LABELS } from './table.ts'

/** The four answers a red/yellow hover must carry (§4.2). */
export interface SubReasons {
  /** 等什么 — what the queue slot is waiting on. */
  what: string
  /** 为什么 — why it landed here (design row + last transition). */
  why: string
  /** 谁 — who owns the next move (人 / worker / host). */
  who: '人' | 'worker' | 'host' | '—'
  /** 下一步 — the next mechanical step. */
  next: string
}

const WHAT_BY_CAUSE: Readonly<Record<string, string>> = {
  'prereq-unruled': '等前置：前置任务未终态/未裁定',
  'awaiting-ack': '等查收：根终态最终总结果待人回执',
  'autofix-blowout': '等人裁：自动修轮已达 N 次熔断',
  'redisp-blowout': '等人裁：机械重派已达 N 次熔断',
  'criterion-dispute': '等人裁：验收判据本体争议（T2）',
  irreversible: '等人裁：不可逆损害处置',
  'chain-dead': '等重派：会话断链（心跳死）',
  'quota-wait': '等配额：配额闸放行',
  'scope-cancelled': '等清行：scope 已撤销',
  'plan-missing': '等补案：任务书缺 worktree 预案',
  'human-abort': '已中止：人显式指令',
}

const NEXT_BY_STATE: Readonly<Record<string, string>> = {
  backlog: '等派发（E1 过 G1–G3 闸）',
  active: '继续步进（E4）',
  deferred: '前置终态到达（E6）或配额空即解冻续跑',
  blocked: '黄灯：出裁定（E21）；红灯：停手等人裁',
  done: '人查收回执（E19）后走归档分层',
  cancelled: '无（终态）',
}

/**
 * Derive the four hover answers for one record.
 * @param record - the task record.
 * @returns 等什么 / 为什么 / 谁 / 下一步.
 */
export function deriveSubReasons(record: TaskRecord): SubReasons {
  const verdict = deriveQueue(record)
  const last = record.history.length > 0 ? record.history[record.history.length - 1] : undefined
  const lastLabel = last ? `${EVENT_LABELS[last.event]}（${last.event}）→ ${last.to}` : '无转移记录'

  const what = WHAT_BY_CAUSE[record.cause ?? '']
    ?? (record.session?.mode === 'frozen' || record.session?.mode === 'locked'
      ? record.session.reason || '冻结中（原因未记）'
      : verdict.example)

  const why = record.state === 'blocked' || record.state === 'deferred'
    ? `${verdict.label}档：${verdict.example}；末转移 = ${lastLabel}`
    : `末转移 = ${lastLabel}`

  const who: SubReasons['who'] = verdict.tier === 'red' || verdict.tier === 'yellow'
    ? '人'
    : record.state === 'active' || record.state === 'backlog'
      ? 'worker'
      : record.state === 'deferred' || record.state === 'blocked'
        ? 'host'
        : '—'

  const next = NEXT_BY_STATE[record.state] ?? '—'
  return { what, why, who, next }
}
