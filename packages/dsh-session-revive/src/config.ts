import z from 'schemastery'

/**
 * Plugin config shape. Schemastery validates shape only (absent keys pass
 * through); every default and clamp lives in {@link resolveConfig} so the
 * ruled values have exactly one home.
 */
export interface Config {
  /** Master switch for detection and logging (default true). */
  enabled?: boolean
  /** `shadow` logs decisions only; `live` also nudges (default shadow). */
  mode?: 'shadow' | 'live'
  /** Minimum spacing between planned revivals in ms (default and floor 10s). */
  staggerMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  mode: z.union([z.const('shadow'), z.const('live')]),
  staggerMs: z.number(),
})

/** Fully resolved runtime config. */
export interface ResolvedConfig {
  enabled: boolean
  mode: 'shadow' | 'live'
  staggerMs: number
}

// ── Ruled parameters (design session-auto-revival-design-1102 §四; 实施不改值 —
// changing any of these requires re-running the statistics scan and a new ruling).
/** Rolling revival quota window: 4h per session chain (分罐不分池). */
export const QUOTA_WINDOW_MS = 4 * 60 * 60 * 1000
/** Revivals allowed per chain inside {@link QUOTA_WINDOW_MS}. */
export const QUOTA_MAX = 4
/** Revive -> die again within this window trips the session breaker. */
export const BREAKER_WINDOW_MS = 10 * 60 * 1000
/** Same-cause errors inside this window form one wave. */
export const WAVE_WINDOW_MS = 15 * 60 * 1000
/** No new same-cause error for this long releases the held sessions. */
export const WAVE_COOLDOWN_MS = 5 * 60 * 1000
/** Configurable stagger floor: below this a config value clamps up with a warn. */
export const STAGGER_MIN_MS = 10_000
/** Default revival stagger (design §四: 间隔可配，初值 10s). */
export const STAGGER_DEFAULT_MS = 10_000
/** Context watermark: at or above this many tokens a session parks, never nudges. */
export const CONTEXT_LIMIT_TOKENS = 150_000

/** Codes whose sessions are revived (design §4.2: 只计可复活类). */
export const REVIVE_CODES: ReadonlySet<string> = new Set(['TRANSPORT', 'TIMEOUT'])

/**
 * Stop causes folded into the revival flow by the 2026-11-07 triage ruling
 * (design session-auto-revival-design-1102 §7.2): `max-tokens` is a `turn/end`
 * reason whose turn produced output up to the ceiling — the provider answered,
 * only the response was truncated; `durability-flush` is the goal-round-driver
 * warn line when a checkpoint flush fails and the driver disarms. Both are
 * synthetic (not `LlmFailure.code`s), kept out of the ruled {@link REVIVE_CODES}
 * literal so the §4.2 accounting stays as ruled; they enter through
 * {@link classifyFailure} and consume the same 4h x 4 can, breaker, and wave as
 * network deaths. `MAX_TOKENS` (compaction, uppercase) must stay non-revive —
 * the sets are case-sensitive on purpose.
 */
export const STOP_CAUSES: ReadonlySet<string> = new Set(['max-tokens', 'durability-flush'])

/**
 * Warn-line signature emitted by goal-round-driver when a durability flush
 * fails; capture group 1 is the agent id, which equals the session id
 * (AgentRegistry.enter throws unless `agent.id === agent.session.id`).
 */
export const DURABILITY_WARN_RE = /durability checkpoint failed for agent "([^"]+)"/

/**
 * Turn-end markers that park as evidence only (design §7.1: session
 * resume/fork never auto-continues — they are lifecycle closers, not
 * failures). A set check rather than literal comparisons: the published
 * `dsh-session` types lag the harness repo and do not declare `forked` yet,
 * while the runtime event stream already carries it.
 */
export const PARKED_TURN_END_REASONS: ReadonlySet<string> = new Set(['interrupted', 'forked'])

/**
 * Wall codes (design §4.2 撞墙类): zero quota consumption, no revival, the
 * session suspends until `resetsAt`. The first seven entries are the design
 * literal list; the following two blocks map its `AUTH` and `模型配置`
 * categories onto the concrete codes the harness emits.
 */
export const WALL_CODES: ReadonlySet<string> = new Set([
  // design §4.2 literal list
  'QUOTA',
  'AUTH',
  'INVALID_REQUEST',
  'MALFORMED_RESPONSE',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'content_filter',
  // design `模型配置` category -> harness model-configuration codes
  'MODEL_UNSUPPORTED',
  'INVALID_CONFIG',
  'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_INFO',
  'INVALID_MODEL_MAX_TOKENS',
  'INVALID_MODEL_REASONING',
  // design `AUTH` category -> credential walls that carry their own codes
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
])

/** Failure classes of one `turn/end` error. */
export type FailureClass = 'revive' | 'wall' | 'other'

/**
 * Classify an `LlmFailure.code` (or a synthetic stop cause): revive-class
 * enters the revival flow, wall-class records a zero-consumption suspension,
 * everything else is observed and logged but never revived (design §4.2
 * enumeration; stop causes added by design §7.2 — same chain, new causes).
 */
export function classifyFailure(code: string): FailureClass {
  if (REVIVE_CODES.has(code) || STOP_CAUSES.has(code)) return 'revive'
  if (WALL_CODES.has(code)) return 'wall'
  return 'other'
}

/** Nudge text a live revival queues into the session — the human continue. */
export const NUDGE_TEXT = '继续'

/**
 * Cause-tagged nudge texts (design §7.2(4), 2026-11-07 ruling): stop causes
 * that disarm the goal-round-driver must tell the model to resume the goal
 * first — the nudge turn carries direct-human authority, so `update_goal
 * action=resume` passes `requireDirectHumanInput`. Network causes keep the
 * plain {@link NUDGE_TEXT}: their turns never touch the driver.
 */
export const NUDGE_TEXT_BY_CAUSE: Readonly<Record<string, string>> = {
  'max-tokens':
    '继续——上一轮输出达到 token 上限被截断了，请从中断处接着做完；若这是目标会话且目标已停轮，先 update_goal action=resume 再继续',
  'durability-flush':
    '继续——目标会话的进度检查点写入失败、目标已停轮，先 update_goal action=resume 恢复目标再从中断处继续',
}

/** Pick the nudge text for a revive decision's cause; unknown causes get the default continue. */
export function nudgeTextFor(code: string | undefined): string {
  return (code !== undefined ? NUDGE_TEXT_BY_CAUSE[code] : undefined) ?? NUDGE_TEXT
}

/**
 * Apply defaults and clamps to one config validation pass.
 * `mode` defaults to `shadow`: the plugin only writes structured logs until
 * the turn-on switch is explicitly set to `live`.
 * @param config - schema-validated config shape.
 * @param warnStagger - called when `staggerMs` violates the ruled floor.
 * @returns the resolved runtime config.
 */
export function resolveConfig(
  config: Config,
  warnStagger?: (raw: number, clamped: number) => void,
): ResolvedConfig {
  let staggerMs = config.staggerMs ?? STAGGER_DEFAULT_MS
  if (!Number.isFinite(staggerMs) || staggerMs < STAGGER_MIN_MS) {
    warnStagger?.(staggerMs, STAGGER_MIN_MS)
    staggerMs = STAGGER_MIN_MS
  }
  return {
    enabled: config.enabled ?? true,
    mode: config.mode ?? 'shadow',
    staggerMs,
  }
}
