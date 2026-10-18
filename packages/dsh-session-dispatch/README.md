# dsh-session-dispatch

English | [中文](README.zh.md)

Pure-REST session dispatch for DSH Web: `POST /api/session-dispatch` creates a
Session pinned to a named Workspace through the Host's own session service and
queues its first prompt, answering `{ ok: true, sessionId }`. Host-only — the
package declares no `dsh.client` face, so nothing appears in the browser
roster.

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

Responses: `200 { ok, sessionId }`, `400` invalid body or rejected Host
command, `403` non-loopback, `404` unknown workspace, `405` wrong method.

### `GET /api/session-dispatch/health`

Liveness probe for restart verification: `200 { ok: true, service:
"dsh-session-dispatch" }`.

## Layout

- `src/index.ts` — plugin entry: injects `webServer`, `sessionController`,
  `workspaceRegistry`; registers both routes.
- `src/host/routes.ts` — body validation and the two route factories.
- `src/host/loopback.ts`, `src/host/http.ts`, `src/mount-once.ts` — generated
  copies of the repository-shared host modules (edit `shared/host/*` and run
  `node scripts/sync-shared.mjs`).

## License

Apache-2.0
