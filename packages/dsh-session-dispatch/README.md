# dsh-session-dispatch

English | [中文](README.zh.md)

Pure-REST session dispatch for DSH Web: `POST /api/session-dispatch` creates a
Session pinned to a named Workspace through the Host's own session service and
queues its first prompt, answering `{ ok: true, sessionId }`. A dispatch may
carry an opaque `taskRef` to record a durable task-to-session binding in the
quick ledger (`$DSH_HOME/dispatch-bindings.json`); while that taskRef still
has a live session the same dispatch is refused with `409`, and
`GET /api/session-dispatch/bindings` serves the ledger with live aliveness.
`POST /api/session-send` queues one prompt onto an existing Session
(queue-only delivery; the wire shape has no delivery-mode field). Host-only —
the package declares no `dsh.client` face, so nothing appears in
the browser roster.

## Why

Programmatic dispatch historically drove the web UI through a dedicated CDP
Chrome instance (hover a workspace row, DOM-click "new session", inject the
task book into the composer, click send). That channel pays a browser spawn on
every dispatch and breaks whenever the layout shifts. This plugin replaces it
with one loopback-fenced POST: no browser, no cookie minting, no UI coupling.

## Install

Local link install (this package is not published to npm):

```powershell
dsh plugin --profile <name> add link:<repo>/packages/dsh-session-dispatch
```

The single bundle row (`session-dispatch`) mounts the Host routes. Restart the
Host (or rely on live patch reload) to activate.

## API

Every route is loopback-only (RFC 5735 127/8, `::1`, IPv4-mapped, plus
same-origin markers); remote sockets answer `403`.

### `POST /api/session-dispatch`

Body (JSON, at most 1 MiB):

| field | type | required | meaning |
|-------|------|----------|---------|
| `workspaceId` | string | yes | Workspace the new Session joins (pins the working directory) |
| `prompt` | string | yes | First user message, queued like a composer send |
| `title` | string | no | Session title, applied via the rename command |
| `mode` | string | no | Agent preset id passed to session create |
| `permission` | string | no | One of `read-only`, `workspace-write`, `danger-full-access`; pinned with `/permission` before the prompt |
| `taskRef` | string | no | Opaque caller-chosen task reference (recommended shape `<board path>#<item anchor>`); records a binding and gates re-dispatch |

Responses: `200 { ok, sessionId }`, `400` invalid body or rejected Host
command, `403` non-loopback, `404` unknown workspace, `405` wrong method,
`409 { ok, taskRef, sessionId }` when the taskRef still has a live session
(dead bindings — archived or removed sessions — do not gate). Dispatch
without `taskRef` behaves exactly as before. A failed binding write answers
`200` with `bindingRecorded: false`: the session is live, so the dispatch
itself did not fail.

### `POST /api/session-send`

Queue one prompt onto an existing Session — the REST mirror of typing into a
live session's composer (cross-session delivery: one session's output becomes
another session's input). Body (JSON, at most 1 MiB):

| field | type | required | meaning |
|-------|------|----------|---------|
| `sessionId` | string | yes | Target existing Session (created earlier, still alive) |
| `prompt` | string | yes | Message queued behind the current turn, exactly like a composer send |

Delivery is queue-only by construction: the wire shape has no delivery-mode
field, so no caller input can steer; a busy Session consumes the message as a
fresh turn after the current one, an idle Session starts a turn at once.
Responses: `200 { ok, sessionId }`, `400` invalid body or `session/*` Host
rejection (missing, archived, or disposed session), `403` non-loopback, `405`
wrong method. Pointer discipline for long bodies: commit the text to git
first and send only the path plus a one-line instruction — the 900,000
character cap is a ceiling, not the intended shape.

### `GET /api/session-dispatch/health`

Liveness probe for restart verification: `200 { ok: true, service:
"dsh-session-dispatch" }`.

### `GET /api/session-dispatch/bindings`

The quick ledger: `200 { ok: true, bindings: [...] }`, one entry per recorded
binding (`taskRef`, `sessionId`, `workspaceId`, `title`, `createdAt`) plus a
real-time `alive` boolean (the session is in some workspace's `sessionIds`
and not in `archivedSessionIds`). The ledger is a runtime occupancy sensor,
not a task account of record — the git board stays the only authority.

## Layout

- `src/index.ts` — plugin entry: injects `webServer`, `sessionController`,
  `workspaceRegistry`; registers the dispatch, health, bindings, and
  session-send routes.
- `src/host/routes.ts` — body validation, the `taskRef`/binding contracts,
  and the route factories (dispatch, health, bindings, session-send).
- `src/host/bindings.ts` — the quick ledger: atomic binding persistence under
  `$DSH_HOME`, live-aliveness lookup, fail-open corrupt-ledger rebuild.
- `src/host/loopback.ts`, `src/host/http.ts`, `src/dsh-home.ts`,
  `src/mount-once.ts` — generated copies of the repository-shared host modules
  (edit `shared/host/*` and run `node scripts/sync-shared.mjs`).

## License

Apache-2.0
