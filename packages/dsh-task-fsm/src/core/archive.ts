/**
 * Archive layering + terminal notification (design §5): 子 worker 父归、
 * 根 worker 留人归、根终态入队待查收通知（黄档）。Pure planning functions —
 * the archive verb itself stays with the caller (dsh-session-archive shared
 * service §7.3); this module only decides WHO archives WHAT.
 * @module @linxin666/dsh-task-fsm/core/archive
 */

import type { FsmFile, TaskRecord } from './schema.ts'
import { deriveQueue } from './queue.ts'

/** Layering verdict for one task (§5 表). */
export interface ArchivePlan {
  taskRef: string
  /** 根 worker = no parent (§5: 根不代归). */
  root: boolean
  /** Child taskRefs whose sessions THIS task must archive on its收口 (父归). */
  children: string[]
  /** Child session ids to archive (mechanical input for the archive service). */
  childSessions: string[]
  /** 根: 留人归 — human archives after the receipt (E19). */
  leaveToHuman: boolean
  /** 根终态: E18 入队待查收通知（黄档）. */
  notify: boolean
}

/** Child records of one parent (§5 父归面; prefix = 子图键 §8.1). */
export function childrenOf(file: FsmFile, taskRef: string): TaskRecord[] {
  return Object.values(file.tasks).filter((record) => record.parent === taskRef)
}

/**
 * Compute the archive layering plan for one task (§5).
 * @param file - the fsm state file.
 * @param taskRef - the task being closed.
 * @returns the plan (children to archive / leave-to-human / notify flags).
 */
export function archivePlan(file: FsmFile, taskRef: string): ArchivePlan {
  const record = file.tasks[taskRef]
  if (record === undefined) {
    return { taskRef, root: true, children: [], childSessions: [], leaveToHuman: false, notify: false }
  }
  const children = childrenOf(file, taskRef)
  const root = record.root === true || record.parent === undefined
  const done = record.state === 'done'
  const awaiting = record.pendingAck === true
  return {
    taskRef,
    root,
    children: children.map((child) => child.taskRef),
    childSessions: children
      .map((child) => child.session?.id)
      .filter((id): id is string => typeof id === 'string' && id !== ''),
    // 根 worker: 人唯一要的 = 最终总结果通知 → 人查收回执后走归档（§5）。
    leaveToHuman: root && done,
    // E18 只对根终态（done + 待查收 + 黄档在场）。
    notify: root && done && awaiting && deriveQueue(record).tier === 'yellow',
  }
}

/**
 * Records awaiting the human receipt (E18 → E19, §5 终态通知).
 * @param file - the fsm state file.
 * @returns every `[x] 待查收` record in taskRef order.
 */
export function pendingReceipts(file: FsmFile): TaskRecord[] {
  return Object.values(file.tasks)
    .filter((record) => record.state === 'done' && record.pendingAck === true)
    .sort((a, b) => a.taskRef.localeCompare(b.taskRef))
}
