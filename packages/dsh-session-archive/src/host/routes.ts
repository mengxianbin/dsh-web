/**
 * HTTP routes for dsh-session-archive. Every route is loopback-fenced (the
 * plugin manages destructive local session data; tunnels and LAN clients get
 * 403), mutating routes additionally require POST, and the delete route
 * surfaces the host plan on confirmation mismatch.
 * @module @linxin666/dsh-session-archive/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { BatchRequestBody } from '../core/types.ts'
import { BusyError, PlanMismatchError, type ArchiveService } from './janitor.ts'
import { readBoundedJson, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'
import { canonicalSessionId } from './session-files.ts'

export const ARCHIVE_API_PREFIX = '/api/dsh-session-archive'

/** Batch bodies carry id arrays; 4 MiB covers ~50k ids with margin. */
const BODY_MAX_BYTES = 4_000_000

function fenced(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return false
  }
  return true
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  try {
    return await readBoundedJson(req, BODY_MAX_BYTES)
  } catch {
    // Empty or invalid bodies read as an empty object; id validation rejects.
    return {}
  }
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200) continue
    // Harness installs mix bare uuids with `session-<uuid>`; accept both and
    // canonicalize. Path-unsafe strings are rejected outright — ids end up in
    // file names for the projection-cache scrub.
    if (entry.includes('/') || entry.includes('\\') || entry.includes('..')) continue
    out.push(canonicalSessionId(entry))
  }
  return out
}

function batchBody(body: unknown): BatchRequestBody {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  return {
    ids: idList(record.ids),
    ...(typeof record.currentSessionId === 'string' ? { currentSessionId: record.currentSessionId } : {}),
    ...(typeof record.expectedTotal === 'number' && Number.isFinite(record.expectedTotal) ? { expectedTotal: Math.round(record.expectedTotal) } : {}),
  }
}

/** The raw body as a record for the seal-gate fields (`force`/`reason`) the shared batchBody drops. */
function bodyRecord(body: unknown): Record<string, unknown> {
  return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error)
}

export function makeInventoryRoute(service: ArchiveService): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/inventory`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      try {
        const inventory = await service.inventory()
        writeJson(res, 200, inventory, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

export function makePreviewRoute(service: ArchiveService): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/preview`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      if (!id.startsWith('session-')) {
        writeJson(res, 400, { ok: false, error: 'invalid session id' })
        return
      }
      try {
        const preview = await service.preview(id)
        writeJson(res, 200, preview, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 404, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

function batchRoute(service: ArchiveService, path: string, run: (body: BatchRequestBody) => Promise<{ results: unknown; freedBytes: number }>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body: BatchRequestBody
      try {
        body = batchBody(await readBody(req))
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorDetail(error) })
        return
      }
      if (body.ids.length === 0) {
        writeJson(res, 400, { ok: false, error: 'no session ids' })
        return
      }
      if (body.ids.length > 20_000) {
        writeJson(res, 413, { ok: false, error: 'too many session ids' })
        return
      }
      try {
        const response = await run(body)
        writeJson(res, 200, response, { 'cache-control': 'no-store' })
      } catch (error) {
        if (error instanceof BusyError) {
          writeJson(res, 409, { ok: false, error: 'busy: another archive operation is running' })
          return
        }
        if (error instanceof PlanMismatchError) {
          writeJson(res, 409, { error: 'plan-mismatch', plan: error.plan })
          return
        }
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/**
 * `POST /seal-check` (contract C1): the six-value grouping per id, served from
 * the one shared implementation so the native dialog (channel A) and this
 * plugin's own gate (channel B) can never disagree. Same loopback fence as
 * every route; `GET ?ids=a,b` is accepted alongside `POST {ids:[…]}`.
 */
export function makeSealCheckRoute(service: ArchiveService): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/seal-check`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      let ids: string[]
      if (req.method === 'POST') {
        ids = idList(bodyRecord(await readBody(req)).ids)
      } else if (req.method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        ids = idList((url.searchParams.get('ids') ?? '').split(','))
      } else {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (ids.length === 0) {
        writeJson(res, 400, { ok: false, error: 'no session ids' })
        return
      }
      try {
        const results = service.sealCheck(ids)
        writeJson(res, 200, { results }, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/**
 * `POST /archive` behind the seal gate (contract C2). Body gains `force`/
 * `reason`: a non-boolean or absent `force` reads as "no force"; `force:true`
 * without a non-empty reason refuses the WHOLE request with 400 (the REST
 * channel only ever forces with real words — 裁定③). Otherwise the gate runs
 * per id inside the service: green and stale archive, true red and UNKNOWN
 * are refused with `seal-required` + their grouping (no batch contagion).
 */
export function makeArchiveRoute(service: ArchiveService): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/archive`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const raw = await readBody(req)
      const record = bodyRecord(raw)
      const body = batchBody(raw)
      if (body.ids.length === 0) {
        writeJson(res, 400, { ok: false, error: 'no session ids' })
        return
      }
      if (body.ids.length > 20_000) {
        writeJson(res, 413, { ok: false, error: 'too many session ids' })
        return
      }
      const forced = record.force === true
      const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
      if (forced && reason === '') {
        writeJson(res, 400, { ok: false, error: 'force requires a non-empty reason' })
        return
      }
      try {
        const response = await service.archive(body.ids, 'manual', body.currentSessionId, forced ? { force: { reason } } : {})
        writeJson(res, 200, response, { 'cache-control': 'no-store' })
      } catch (error) {
        if (error instanceof BusyError) {
          writeJson(res, 409, { ok: false, error: 'busy: another archive operation is running' })
          return
        }
        if (error instanceof PlanMismatchError) {
          writeJson(res, 409, { error: 'plan-mismatch', plan: error.plan })
          return
        }
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/**
 * `POST /archive-override` (contract C4): the native dialog's ledger
 * write-back after a confirmed forced archive (`mode: "force"`, reason
 * normalizes to `override:no-reason` when blank) or a stale pass-through
 * (`mode: "note"`, pins `seal: "stale"`). It only writes the ledger — it
 * never archives anything, so it cannot bypass the gate.
 */
export function makeArchiveOverrideRoute(service: ArchiveService): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/archive-override`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const record = bodyRecord(await readBody(req))
      const ids = idList(record.ids)
      if (ids.length === 0) {
        writeJson(res, 400, { ok: false, error: 'no session ids' })
        return
      }
      if (ids.length > 20_000) {
        writeJson(res, 413, { ok: false, error: 'too many session ids' })
        return
      }
      if (record.mode !== 'force' && record.mode !== 'note') {
        writeJson(res, 400, { ok: false, error: 'mode must be force or note' })
        return
      }
      try {
        const response = await service.archiveOverride(ids, record.mode, {
          ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
          ...(typeof record.seal === 'string' ? { seal: record.seal } : {}),
        })
        writeJson(res, 200, { ok: true, ...response }, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

export function makeUnarchiveRoute(service: ArchiveService): WebRoute {
  return batchRoute(service, `${ARCHIVE_API_PREFIX}/unarchive`, (body) => service.unarchive(body.ids))
}

export function makeDeleteRoute(service: ArchiveService): WebRoute {
  return batchRoute(service, `${ARCHIVE_API_PREFIX}/delete`, (body) => service.deleteSessions(body.ids, {
    currentSessionId: body.currentSessionId,
    ...(body.expectedTotal !== undefined ? { expectedTotal: body.expectedTotal } : {}),
  }))
}

export function makeAutoPreviewRoute(service: ArchiveService): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/auto/preview`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      try {
        writeJson(res, 200, await service.autoPreview(), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

export function makeAutoRunRoute(service: ArchiveService): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/auto/run`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let kind: 'archive' | 'delete'
      let currentSessionId: string | undefined
      try {
        const body = (await readBody(req)) as Record<string, unknown>
        if (body.kind !== 'archive' && body.kind !== 'delete') throw new Error('kind must be archive or delete')
        kind = body.kind
        if (typeof body.currentSessionId === 'string') currentSessionId = body.currentSessionId
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorDetail(error) })
        return
      }
      try {
        const stats = await service.runAutoCycle(kind, currentSessionId)
        writeJson(res, 200, { ok: true, stats }, { 'cache-control': 'no-store' })
      } catch (error) {
        if (error instanceof BusyError) {
          writeJson(res, 409, { ok: false, error: 'busy: another archive operation is running' })
          return
        }
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

export function makeArchiveRoutes(service: ArchiveService): WebRoute[] {
  return [
    makeInventoryRoute(service),
    makePreviewRoute(service),
    makeArchiveRoute(service),
    makeUnarchiveRoute(service),
    makeDeleteRoute(service),
    makeAutoPreviewRoute(service),
    makeAutoRunRoute(service),
    makeSealCheckRoute(service),
    makeArchiveOverrideRoute(service),
  ]
}
