/**
 * Off-loop seal compute (seal-light-host-state-1109 实施护栏 ②): one
 * `worker_threads` script whose whole job is running {@link analyzeSeal}
 * outside the Host's event loop — the synchronous zstd decompress and line
 * scan must never block turn processing, sweeps, or HTTP (readFileSync 同步
 * 解压 = seal-check 慢同款病; this file is that work's isolation cell).
 *
 * Protocol (structured clone both ways): parent posts
 * `{ id: string, dir?: string, recheck?: boolean }`, this worker answers
 * `{ result: SealCheckResult }` per message — one request per spawned worker
 * in production, but the handler stays message-driven so a future pool needs
 * no rewrite. `recheck` (stall-rootcause-1123) carries the click-time flag so
 * the worker's git probe re-derives instead of trusting a memoized red.
 * @module @linxin666/dsh-session-archive/host/seal-compute-worker
 */

import { parentPort } from 'node:worker_threads'
import { analyzeSeal } from './seal.ts'
import type { SealCheckResult } from '../core/types.ts'

/** One request frame from the spawning parent. */
interface SealComputeRequest {
  readonly id?: unknown
  readonly dir?: unknown
  readonly recheck?: unknown
}

const port = parentPort

if (port !== null) {
  port.on('message', (raw: unknown) => {
    const request = (raw ?? {}) as SealComputeRequest
    if (typeof request.id !== 'string') return
    const dir = typeof request.dir === 'string' ? request.dir : undefined
    const options = request.recheck === true ? { recheck: true } as const : undefined
    let result: SealCheckResult
    try {
      result = analyzeSeal(request.id, dir, options)
    } catch (error) {
      // analyzeSeal degrades every read failure itself; an unexpected throw
      // still answers so the parent never waits on a silent worker — the
      // client-visible form is the same UNKNOWN the endpoint would serve.
      result = { id: request.id, verdict: 'UNKNOWN', detail: 'decode-fail' }
      void error
    }
    port.postMessage({ result })
  })
}
