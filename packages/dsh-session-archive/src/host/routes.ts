/**
 * HTTP routes for dsh-session-archive. Every route is loopback-fenced (the
 * plugin manages destructive local session data; tunnels and LAN clients get
 * 403), mutating routes additionally require POST, and the delete route
 * surfaces the host plan on confirmation mismatch.
 * @module @linxin666/dsh-session-archive/host/routes
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
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
    ...(typeof record.actor === 'string' && record.actor.trim() !== '' ? { actor: record.actor.trim().slice(0, 200) } : {}),
    ...(typeof record.expectedTotal === 'number' && Number.isFinite(record.expectedTotal) ? { expectedTotal: Math.round(record.expectedTotal) } : {}),
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error)
}

/**
 * Write one pre-serialized JSON body with the family default headers. The
 * cached inventory route serves bytes it serialized once at rebuild time;
 * re-stringifying them per request would defeat the cache on the response
 * side (the stringify is a measured cost of a full pass).
 */
function writeRawJson(res: ServerResponse, status: number, payload: string, headers: OutgoingHttpHeaders): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(payload)
}

export function makeInventoryRoute(service: ArchiveService): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/inventory`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      try {
        // Whole-response TTL cache (task #inventory-perf-1030): one rebuild
        // is serialized once and served verbatim inside the window, and a
        // cold burst coalesces into a single rebuild. The wire stays
        // `no-store` — the browser must always ask this server, and the
        // server-side cache is the single freshness authority (the plugin
        // invalidates it after every archive/restore/delete it performs).
        // `x-dsh-inventory-cache` and `age` make the window observable
        // without parsing the body.
        const served = await service.inventoryCached()
        writeRawJson(res, 200, served.payload, {
          'cache-control': 'no-store',
          'x-dsh-inventory-cache': served.hit ? 'hit' : 'miss',
          // Whole seconds, per the HTTP `age` header convention (typed as a
          // string by @types/node, which the wire agrees with).
          age: String(Math.floor(served.ageMs / 1000)),
        })
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

function batchRoute(
  service: ArchiveService,
  path: string,
  run: (body: BatchRequestBody) => Promise<{ results: unknown; freedBytes: number }>,
  options: { requireActor?: boolean } = {},
): WebRoute {
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
      // Who ordered this archive must be stated up front (triclass ruling,
      // 2026-10-29): a missing actor is a caller-fixable 400, mirroring the
      // seal gate's required-field pattern, never a silent human default.
      if (options.requireActor === true && body.actor === undefined) {
        writeJson(res, 400, { ok: false, error: 'actor is required: pass the deciding session id or a channel name (e.g. manual)' })
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

export function makeArchiveRoute(service: ArchiveService): WebRoute {
  // Identity gate + actor audit trail (triclass ruling, 2026-10-29): the
  // body names who ordered the archive (400 without it), and the service
  // refuses — per id, without batch taint — every target that actor's class
  // may not archive (`identity-denied`), then persists `actor` into the
  // ledger entry.
  return batchRoute(
    service,
    `${ARCHIVE_API_PREFIX}/archive`,
    (body) => service.archive(body.ids, 'manual', body.currentSessionId, body.actor),
    { requireActor: true },
  )
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
  ]
}
