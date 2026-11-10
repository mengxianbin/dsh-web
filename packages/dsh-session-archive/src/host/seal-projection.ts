/**
 * The `seal` session projection (seal-light-host-state-1109 裁点1A/3A): a pure
 * fold from `plugin:session-archive/seal` records to the verdict the Host
 * carries on `api-session/status` frames and in Session summaries.
 *
 * The unit is registered by {@link createSealStateSync} alongside the
 * turn-end compute — key present exactly while this plugin's archive surface
 * is mounted, `null` until a record lands (插件未装 → key 缺席 → the client
 * paints fail-visible unknown, never a stale green). The fold itself never
 * computes: seal judgement stays at `host/seal.ts`, driven only by recorded
 * facts, so sweep/list reads are O(1) carries (计算永不出现在 sweep/list
 * 请求路径).
 * @module @linxin666/dsh-session-archive/host/seal-projection
 */

import { z } from 'zod'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SealVerdictPayload } from '../core/types.ts'

/** The record type this fold reads. */
export const SEAL_RECORD = 'plugin:session-archive/seal'

/** One recorded verdict; malformed or foreign records never enter the state. */
const payloadSchema = z.object({
  verdict: z.string().min(1),
  detail: z.string().optional(),
  followUpCount: z.number().int().nonnegative().optional(),
}).strict()

/** Fold state = the latest payload, or `null` before the first record. */
const stateSchema = payloadSchema.nullable()

/** Wire payload: the same nullable value the map declares (`seal: payload | null`). */
const viewSchema = payloadSchema.nullable()

/** Type of {@link sessionSealProjection}. */
export type SessionSealProjectionState = z.infer<typeof stateSchema>

/**
 * The definition type with `wire` required: `register`'s client-visible
 * overload takes `Omit<..., 'wire'> & { wire: NonNullable<...> }`, and a
 * plain `ProjectionDefinition` annotates `wire` as optional — the same
 * derivation action-cards uses for its unit.
 */
export type SessionSealProjectionDefinition =
  Omit<ProjectionDefinition<'seal', SessionSealProjectionState>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'seal', SessionSealProjectionState>['wire']> }

/**
 * The projection definition: `null` init, record-driven apply, identity view.
 * The view returns the state reference unchanged so an unrelated event costs
 * zero downstream publication (Object.is suppression).
 */
export const sessionSealProjection: SessionSealProjectionDefinition = {
  key: 'seal',
  stateVersion: 1,
  stateSchema,
  init: () => null,
  apply: (state, event) => {
    const record = pluginRecordOf(event)
    if (record?.type !== SEAL_RECORD) return state
    // A malformed or newer record is skipped; throwing here would fail every
    // later read of this Session (same stance as action-cards' fold).
    const parsed = payloadSchema.safeParse(record.data)
    return parsed.success ? parsed.data : state
  },
  wire: { viewSchema, view: (state) => state },
}

/** The projection value shape, exported for tests and the projection's consumers. */
export type SessionSealProjectionValue = SealVerdictPayload | null
