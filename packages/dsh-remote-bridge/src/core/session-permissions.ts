/**
 * The host's permission presets, projected into the shape `session.permissions`
 * and `session.setPermission` publish.
 *
 * The services are reached through structural faces for the reason
 * `session-meta.ts` states: the live objects carry far more than this package
 * calls, and a face keeps a test double down to what is actually read.
 *
 * Two facts of the real service shape this module:
 *
 * - `current` and `set` take the LIVE `Session` object, never an id, so a
 *   session this host process does not hold — a cold, disk-only roster entry —
 *   has no truthful answer at all. That case is refused by name instead of
 *   being reported as an empty or defaulted mode.
 * - `custom` is DERIVED state, never a switch target: it can be the current
 *   value and must never be offered as an option.
 * @module dsh-remote-bridge/core/session-permissions
 */

import { errorCodeOf, failureText } from './gateway-errors.ts'
import { CODE_INTERNAL, CODE_INVALID_ARGS, CODE_UNKNOWN_METHOD } from './protocol.ts'
import type { LiveSessionFace, SessionStoreFace } from './session-meta.ts'

/** The permission service's name for "no preset matches the two knobs". */
export const CUSTOM_PRESET = 'custom'

/**
 * The code the harness raises for a session it has no live instance of.
 * Verbatim from the harness's own error table, not a bridge-invented one.
 */
export const CODE_SESSION_NOT_FOUND = 'session/not-found'

/** One preset as the permission service advertises it. */
export interface PresetOptionFace {
  /** The switch target's stable value. */
  readonly value: string
  /** The label a client shows. */
  readonly name: string
  readonly description?: string
}

/** The slice of `ctx.permissionPresets` this package reads and writes. */
export interface PermissionPresetsFace {
  catalog(): { readonly options: readonly PresetOptionFace[] } | undefined
  /** The preset matching the session's folded knobs, or `custom`. */
  current(session: LiveSessionFace): string
  /** Switch one live session; unknown names throw. */
  set(session: LiveSessionFace, name: string): void
  /** The client option for a preset or the derived `custom`. */
  optionOf(name: string): PresetOptionFace
}

/** The slice of `ctx.sandboxPolicy` this package reads. */
export interface SandboxPolicyFace {
  /** The deployment default a session inherits without its own override. */
  readonly defaultMode?: string
  /** The session's own last logged mode, or undefined without one. */
  overrideOf(session: LiveSessionFace): string | undefined
}

/** The slice of `ctx.approval` this package reads. */
export interface ApprovalPolicyFace {
  /** The deployment's configured default policy. */
  readonly config?: { readonly policy?: string }
  /** The session's own last logged policy, or undefined without one. */
  overrideOf(session: LiveSessionFace): string | undefined
}

/**
 * The in-process services one permission read may use.
 *
 * Every field is optional on purpose: on a host that does not compose the
 * permission plugin the method answers `unknown-method`, which is the signal a
 * client already uses to disable the control instead of offering a dead switch.
 */
export interface PermissionFaces {
  readonly sessions?: SessionStoreFace | undefined
  readonly presets?: PermissionPresetsFace | undefined
  readonly sandbox?: SandboxPolicyFace | undefined
  readonly approval?: ApprovalPolicyFace | undefined
}

/** One selectable preset, in the protocol's own field names. */
export interface PermissionOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** The session's current permission mode. */
export interface PermissionCurrent {
  readonly id: string
  readonly name: string
  /** The effective sandbox knob; present only while {@link PermissionCurrent.id} is `custom`. */
  readonly sandbox?: string
  /** The effective approval knob; present only while {@link PermissionCurrent.id} is `custom`. */
  readonly approval?: string
}

/** One `session.permissions` answer. */
export interface PermissionsAnswer {
  readonly current: PermissionCurrent
  readonly options: readonly PermissionOption[]
  readonly custom: boolean
}

/** One permission refusal, in the shape the dispatcher answers with. */
export interface PermissionRefusal {
  readonly code: string
  readonly msg: string
}

/** One live session plus the service that can describe and switch it. */
interface LivePresets {
  readonly presets: PermissionPresetsFace
  readonly session: LiveSessionFace
}

/**
 * Read one knob's effective value: the session's own fold, else the deployment
 * default.
 * @returns the value, or undefined when neither could be read.
 */
function knobOf(read: () => string | undefined, fallback: string | undefined): string | undefined {
  try {
    return read() ?? fallback
  } catch {
    // A knob the host cannot read is omitted rather than guessed: a client shows
    // "unknown" for a missing value, which is true, and a fabricated mode is not.
    return fallback
  }
}

/**
 * The bridge's permission reads and writes.
 *
 * One instance is built per host mount and shared by every connection, because a
 * preset table is a fact about the deployment, not about the device that asked.
 */
export class SessionPermissions {
  readonly #faces: () => PermissionFaces
  readonly #log: (message: string) => void

  /**
   * @param faces - resolves the host services now; called per read, never captured once, so a service that mounts later is still picked up.
   * @param log - where an unreadable preset state is reported.
   */
  constructor(faces: () => PermissionFaces, log: (message: string) => void) {
    this.#faces = faces
    this.#log = log
  }

  /**
   * Describe one session's permission modes.
   *
   * `current` is the service's own folded value: the preset the session's two
   * knobs currently match, or `custom` with both knobs' real values. It is never
   * the deployment default dressed up as the current mode.
   * @param sessionId - the session the client is looking at.
   */
  describe(sessionId: string): PermissionsAnswer | PermissionRefusal {
    const live = this.#live(sessionId)
    if ('code' in live) return live
    return this.#answer(live.presets, live.session)
  }

  /**
   * Switch one session to a preset this host offers.
   *
   * The id is validated against the same option list `describe` publishes before
   * the service is touched at all, so an unknown id changes nothing — the switch
   * appends durable events and must never run on a rejected argument.
   * @param sessionId - the session to switch.
   * @param id - one of `describe(sessionId).options`' ids.
   */
  set(sessionId: string, id: string): PermissionsAnswer | PermissionRefusal {
    const live = this.#live(sessionId)
    if ('code' in live) return live
    const before = this.#answer(live.presets, live.session)
    if ('code' in before) return before
    if (!before.options.some(option => option.id === id)) {
      return { code: CODE_INVALID_ARGS, msg: `session.setPermission requires an id this host offers, not "${id}"` }
    }
    try {
      live.presets.set(live.session, id)
    } catch (error) {
      this.#log(`the permission of one session could not be switched: ${failureText(error)}`)
      return { code: errorCodeOf(error, CODE_INTERNAL), msg: failureText(error) }
    }
    return this.#answer(live.presets, live.session)
  }

  /** Resolve the service and the live session one call is about. */
  #live(sessionId: string): LivePresets | PermissionRefusal {
    const faces = this.#faces()
    const presets = faces.presets
    if (presets === undefined || typeof presets.catalog !== 'function' || typeof presets.current !== 'function') {
      return { code: CODE_UNKNOWN_METHOD, msg: 'this host does not compose permissionPresets' }
    }
    const session = faces.sessions?.get(sessionId)
    if (session === undefined) {
      return { code: CODE_SESSION_NOT_FOUND, msg: `session ${sessionId} is not live in this host process` }
    }
    return { presets, session }
  }

  /** Build one answer out of the service's own folded state. */
  #answer(presets: PermissionPresetsFace, session: LiveSessionFace): PermissionsAnswer | PermissionRefusal {
    let current: string
    try {
      current = presets.current(session)
    } catch (error) {
      this.#log(`the permission preset of one session could not be read: ${failureText(error)}`)
      return { code: errorCodeOf(error, CODE_INTERNAL), msg: failureText(error) }
    }
    const custom = current === CUSTOM_PRESET
    const name = this.#labelOf(presets, current)
    const head: PermissionCurrent = custom
      ? { id: current, name, ...this.#knobs(session) }
      : { id: current, name }
    return { current: head, options: this.#options(presets), custom }
  }

  /**
   * The switchable presets, in the service's own order.
   *
   * The catalog already advertises only presets that can be selected right now,
   * so this only drops the derived value: `custom` is a state, not a target.
   */
  #options(presets: PermissionPresetsFace): PermissionOption[] {
    let catalog: ReturnType<PermissionPresetsFace['catalog']>
    try {
      catalog = presets.catalog()
    } catch (error) {
      this.#log(`the permission catalog could not be read: ${failureText(error)}`)
      return []
    }
    const options: PermissionOption[] = []
    for (const option of catalog?.options ?? []) {
      if (option === undefined || typeof option.value !== 'string' || option.value === '' || option.value === CUSTOM_PRESET) continue
      const name = typeof option.name === 'string' && option.name !== '' ? option.name : option.value
      options.push({ id: option.value, name, ...(option.description === undefined ? {} : { description: option.description }) })
    }
    return options
  }

  /** The label for one current value, falling back to the value itself. */
  #labelOf(presets: PermissionPresetsFace, name: string): string {
    try {
      const option = presets.optionOf(name)
      if (typeof option?.name === 'string' && option.name !== '') return option.name
    } catch {
      // A derived value the catalog does not label is still a value the client
      // can show; the raw name is what the protocol's `id` already carries.
    }
    return name
  }

  /** The two knobs' effective values, for a session whose state matches no preset. */
  #knobs(session: LiveSessionFace): { readonly sandbox?: string; readonly approval?: string } {
    const faces = this.#faces()
    const sandbox = knobOf(() => faces.sandbox?.overrideOf(session), faces.sandbox?.defaultMode)
    const approval = knobOf(() => faces.approval?.overrideOf(session), faces.approval?.config?.policy ?? 'ask')
    return { ...(sandbox === undefined ? {} : { sandbox }), ...(approval === undefined ? {} : { approval }) }
  }
}
