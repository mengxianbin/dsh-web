/**
 * Archive execution leg — S2 (fsm-seam-archive-build-1125, 方案 = 调查档 §3.2):
 * the HTTP half of the three event-driven triggers. Trigger① (root lands done
 * → auto E18) runs inline in the transition route; this module owns the two
 * `POST /api/dsh-session-archive/archive {ids, actor}` calls —
 *   触发② 父落 done → 父归 archivePlan().childSessions（父收口即归子，§5）
 *   触发③ ack E19 成功 → 归根会话自己（leaveToHuman = 人查收回执是归档授权闸）
 * actor = 宿主渠道名 `fsm-host`（identity.ts 渠道名分支 = human 级授权；⛔ 不改
 * identity 裁决表本体，AGENTS #12）。绝不传 `force`：seal 红/UNKNOWN 的 id 由
 * 归档服务逐 id `seal-required` 跳过（不连坐、不 force，force 归人）。
 * 失败形态 = fail-open 留痕：超时 10s、非 200/抛错记一次败、连续 3 败该 taskRef
 * 降级只留痕（不再打 POST，防每事件重试打爆）；FSM 转移永不回滚（归档滞后 ≠
 * host 死亡）。成功且逐 id 全绿 = 静默（逐 id 结果在归档服务自己的台账里），
 * 只有 skip/失败才出本腿日志。
 * @module dsh-task-fsm/host/archive-leg
 */

/** The host channel name this leg declares as actor (identity.ts 渠道名分支 → human). */
export const ARCHIVE_ACTOR = 'fsm-host'

/** Minimal fetch face (injectable for tests; production = global fetch). */
export type ArchiveFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>

export interface ArchiveLegOptions {
  /** Test seam; defaults to global fetch. */
  fetchImpl?: ArchiveFetch
  /** Per-call timeout (施工期定, §3.2 决定⑧ 建议 10s). */
  timeoutMs?: number
  /** Consecutive failures per taskRef before degrading to log-only (建议 3). */
  maxConsecutive?: number
}

/** One per-id result row of `POST /archive` (BatchResponse.results). */
interface ArchiveOpResult {
  id?: unknown
  status?: unknown
  reason?: unknown
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
}

export class ArchiveLeg {
  private readonly fetchImpl: ArchiveFetch
  private readonly timeoutMs: number
  private readonly maxConsecutive: number
  private readonly failures = new Map<string, number>()
  /** Single-flight queue: runs serialize (the archive service 409s on overlap), and `idle()` awaits this tail. */
  private tail: Promise<void> = Promise.resolve()

  constructor(options: ArchiveLegOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maxConsecutive = options.maxConsecutive ?? 3
  }

  /**
   * Queue one archive run for a taskRef (fire-and-forget for the routes;
   * tests await `idle()` to observe the POST). Runs serialize behind the
   * previous one — the archive service holds a global lock (BusyError 409 on
   * overlap), so concurrent triggers must not race each other.
   * @param taskRef - the FSM record being closed (failure-counter key).
   * @param ids - session ids straight from archivePlan (mechanical input only).
   * @param origin - loopback origin of this request's own server.
   * @returns the run promise (never rejects).
   */
  archive(taskRef: string, ids: readonly string[], origin: string): Promise<void> {
    const run = this.tail.then(() => this.run(taskRef, ids, origin))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Resolve once every queued run settled (test seam). */
  async idle(): Promise<void> {
    await this.tail
  }

  /** Consecutive-failure reading for one taskRef (test/diagnostic seam). */
  consecutiveFailures(taskRef: string): number {
    return this.failures.get(taskRef) ?? 0
  }

  private async run(taskRef: string, ids: readonly string[], origin: string): Promise<void> {
    if (ids.length === 0) return
    const failed = this.failures.get(taskRef) ?? 0
    if (failed >= this.maxConsecutive) {
      // 降级只留痕（§3.2 决定⑧）：不回滚、不再打 POST，等人工补归。
      console.warn(`[task-fsm-archive] DEGRADED taskRef=${taskRef} 连续 ${failed} 败 → 只留痕（人工补归） ids=${ids.join(',')}`)
      return
    }
    try {
      const response = await this.fetchImpl(`${origin}/api/dsh-session-archive/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ⛔ 不带 force：seal 红/UNKNOWN 由服务逐 id seal-required 跳过（seal 红不 force）。
        body: JSON.stringify({ ids: [...ids], actor: ARCHIVE_ACTOR }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (response.status !== 200) throw new Error(`archive HTTP ${response.status}`)
      const body = await response.json().catch(() => ({})) as { results?: ArchiveOpResult[] }
      this.failures.delete(taskRef)
      const noteworthy = (body.results ?? []).filter((row) => row.status !== 'ok')
      if (noteworthy.length > 0) {
        // 逐 id 留痕：seal-required / identity-denied / not-found 等跳过不静默。
        const rows = noteworthy
          .map((row) => `${String(row.id)}:${String(row.reason ?? row.status)}`)
          .join(' ')
        console.warn(`[task-fsm-archive] SKIP taskRef=${taskRef} actor=${ARCHIVE_ACTOR} ${rows}`)
      }
      // 全绿 = 静默：逐 id 结果已在归档服务台账（journal），本腿不加成功日志。
    } catch (error) {
      const count = (this.failures.get(taskRef) ?? 0) + 1
      this.failures.set(taskRef, count)
      console.warn(`[task-fsm-archive] FAILED taskRef=${taskRef} 第 ${count}/${this.maxConsecutive} 败 ids=${ids.join(',')} error=${detailOf(error)}（不回滚 FSM）`)
    }
  }
}
