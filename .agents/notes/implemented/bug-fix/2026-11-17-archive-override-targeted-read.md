# Agent Note: archive-override write-back drops the full sessions-root scan

Status: implemented

## Problem

`POST /archive-override` (the native dialog's ledger write-back, contract C4)
paid `dirIndex.get()` on every call — a full walk of the sessions root with
`dirSize` recursion over every project dir and segment. On the production
root (2127 session dirs) that walk measures ~1.3 s warm and ~14.5 s cold
(measured 2026-11-17, forensics in m-note
`content/tech/ai/dsh/archive-inline-fix-1116.md`). The walk was dead weight
on the path that actually uses it: the native channel always travels with the
seal it just computed, `mode: "note"` never judges one, and only a
seal-less `force` ever needs a transcript dir — yet every call re-walked the
tree. The client aborts the write-back at `SEAL_GATE_TIMEOUT_MS = 5000`, so
the response was routinely discarded (3 of 4 observed calls ended `-`) while
the server finished anyway: the ledger flush precedes the response, so no
data was lost, but the panel showed a failing write-back on every archive.

## Decision

`ArchiveService.archiveOverride` resolves transcript dirs only when it must
compute a seal itself — `mode === "force"` with no caller-provided `seal` —
and then through `resolveSessionDirs`, the same named-id probe `sealCheck`
uses (top-level project readdirs, no `dirSize`, containment-checked; proven
equal to the full index restricted to those ids by
`tests/seal-targeted-read.spec.ts`). Seal-provided `force` and `note` never
touch the sessions tree. The seal verdicts themselves are unchanged:
`analyzeSeal` still receives the same dir the full index would have yielded
(`index.byId.get(id)` and `resolveSessionDirs(...).get(id)` are equal by the
proof above), and the caller-supplied seal is still written verbatim.

## Testing

Four cases in `tests/archive-override.spec.ts` pin the new read pattern
behind the existing `dirIndex.scans` counter: seal-provided `force` answers
with the passed seal at zero scans; seal-less `force` still derives `stale`
and `UNSEALED:save-tail-no-sentinel` at zero scans; `note` writes its marker
at zero scans; and a control case drives a real inventory pass afterwards to
show the counter still reaches exactly one — zero above means "skipped", not
"broken". The pre-existing C3/C4/C5 contract cases run unchanged.

## Alternatives considered

- **Keep the scan, shorten the TTL**: the 2 s window already covers the
  panel's burst; it does nothing for the first (cold) walk, which is the one
  that blows the 5 s abort.
- **Await the scan off the event loop**: removes the loop stall but keeps
  ~1.3 s warm latency on every write-back — the abort survives, the panel
  still waits seconds.
- **Route the write-back through the turn-end seal-state worker**: that seam
  already computes seals off-loop, but the write-back's seal arrives from the
  client, so the worker would be idle work on this path.

## Consequences

Write-back latency drops from seconds to milliseconds and the client abort
disappears with it. The full index keeps exactly one consumer — the
inventory build, which needs every dir's size anyway. Seal-less `force`
trades a possibly-warmed full index for a per-call targeted probe; that is
cheap (one readdir per project dir, stat/realpath only for matched ids) and
the path is rare, since the native dialog always sends its seal and the REST
archive gate computes seals through its own `analyzeSeal` call rather than
here.
