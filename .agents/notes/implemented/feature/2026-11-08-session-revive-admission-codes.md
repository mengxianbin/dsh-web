# Agent Note: dsh-session-revive admits content_filter and MALFORMED_RESPONSE into the revive class

Status: implemented

## Problem

The revival plugin classified only `TRANSPORT` and `TIMEOUT` as revive-class;
`content_filter` and `MALFORMED_RESPONSE` sat in the ruled wall list, so a
session killed by either was suspended at zero cost and never continued. A
corpus re-run (2026-11-08, 1875 transcripts under `~/.dsh/sessions`, 352 error
turns) measured the wall premise — "a revival would hit the same wall" — as
false for both: a human continue completed the next turn in 6/8
`content_filter` sessions (55% event-level, the same band as `TRANSPORT`'s
59%) and in 6/8 `MALFORMED_RESPONSE` errors (75%), while the codes the wall
list does protect (`INVALID_REQUEST` 27%, `AUTH` 29%) stayed low. Worse, the
harness never emits `content_filter` as a failure code at all —
`classifyPiAiError` has no content-filter arm, so the stop arrives as the
catch-all `PI_AI_ERROR` with the cause only in the message
(`Provider finish_reason: content_filter`) — which means the wall list's
`content_filter` entry was a dead literal that could never match, and those
sessions were classified `other`: observed, skipped, never continued.

## Decision

- **Both codes move from `WALL_CODES` to `REVIVE_CODES`** in `src/config.ts`
  (design §4.2 amendment, 拍板⑬). They consume the same 4h x 4 can, breaker,
  waves, stagger, and 1M watermark as network deaths; the wall list keeps
  the codes the corpus still measures as non-recoverable.
- **Message-level refinement before classification**: `refineFailureCode()`
  maps `PI_AI_ERROR` + a message matching `/\bcontent_filter\b/i` to
  `content_filter`, and passes every other code through untouched;
  `src/index.ts` feeds the refined code into `policy.onError`. The scope is
  deliberately the single catch-all bucket — the corpus shows the filter
  landing there in 11/11 observed cases, and real codes (`INVALID_REQUEST`
  etc.) keep their own classification even if their message mentions the
  words. Classification itself stays entirely in the ruled (configurable)
  lists; the refinement only decides which code they see.
- **The admission criteria behind the ruling** (design doc
  `session-auto-revival-design-1102.md` 拍板⑫): a code enters the revive
  list when ① the human default action on such a stop is a plain continue,
  ② continue alone recovers it with corpus evidence, and ③ continuing is
  harmless. Codes whose recovery depends on a precondition changing first
  (QUOTA waits for auto-route to switch, AUTH needs a login) stay out —
  they have their own channels (拍板⑩ route release, human action).

## Testing

Package `pnpm typecheck` green, `pnpm test` 66 passed (65 existing + 1 new
`refineFailureCode` case covering the PI_AI_ERROR bucket, the
repetition_truncation non-match, the undefined message, non-catch-all codes,
and the end-to-end refine→classify-revive path), `pnpm build` green
(`lib/index.js` regenerated 2026-11-08, 49.89 kB). Ruled-default assertions
in `config.spec.ts` and `policy.spec.ts` were updated word-for-word to the
new four-code revive list; the wall fixture in `policy.spec.ts` moved to
`INVALID_REQUEST` since `MALFORMED_RESPONSE` no longer parks a session.

## Alternatives considered

- **Add a content_filter arm to the harness classifier**: rejected — the
  package's rule is zero harness changes (design §七 implementation
  boundary), and the message is already on the wire; refining on the
  consumer side keeps the fix in the single package that needs it.
- **Widen the refinement to any code whose message matches**: rejected —
  an `INVALID_REQUEST` carrying the words should keep its 27%-recovery
  wall classification; only the bucket the harness actually folds the stop
  into is refined.
- **Keep `content_filter` in the wall list as a dead literal**: rejected —
  it never matched anything, so keeping it would document an intent the
  code cannot express; the admission ruling moves it where it can act.

## Consequences

- The running Host picks the change up only on the next restart (the link
  install loads `lib/index.js` at activation); restart remains human-owned.
  Until then the old lists stay in force and these sessions keep being
  skipped — the post-restart criterion is a `content_filter` message
  producing a `detect` line with `cls: "revive"` instead of `other`.
- Profile config (m-note `.dsh/profiles-web-cordis-patch.yml`) pins both
  lists explicitly, so it must carry the same move or it would override the
  new defaults back to the old behavior; both land in the same ruling batch.
- `repetition_truncation` (the other `PI_AI_ERROR` occupant, 40% recovery
  on n=5) is deliberately not refined in; if future corpus data clears it,
  it follows the same message-refinement channel.
