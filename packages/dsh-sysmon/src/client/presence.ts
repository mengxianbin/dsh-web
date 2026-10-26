/**
 * Cross-seat presence signal for the sysmon chip's two registrations.
 *
 * The chip occupies two mutually exclusive seats: the session-header actions
 * row (mounted only while an open, non-blank Session renders that row) and the
 * conversation header's leading cell (the always-rendered fallback that covers
 * the no-session and blank-session states the actions row cannot reach). Both
 * seats come from this one module instance, so a module-level mount count lets
 * exactly one copy be painted: the primary reports its mount from a layout
 * effect, the fallback subscribes and yields while any primary copy exists.
 *
 * Layout-phase reporting matters: a primary mounting in the same commit as a
 * fallback render must win before paint, or two copies flash for a frame.
 * @module dsh-sysmon/client/presence
 */

/** One subscriber notified after every mount/unmount transition. */
type Listener = () => void

const listeners = new Set<Listener>()

/** Mounted primary-seat copies; a count (not a flag) survives StrictMode re-runs. */
let primaryMounts = 0

/**
 * Record one mounted primary-seat copy.
 * @returns disposer for the layout-effect cleanup that records the unmount.
 */
export function beginPrimary(): () => void {
  primaryMounts += 1
  for (const listener of [...listeners]) listener()
  return () => {
    primaryMounts = Math.max(0, primaryMounts - 1)
    for (const listener of [...listeners]) listener()
  }
}

/** Whether a primary-seat copy is currently mounted. */
export function primaryMounted(): boolean {
  return primaryMounts > 0
}

/**
 * Subscribe to primary-seat presence transitions.
 * @param listener - called after every mount and every unmount.
 * @returns the unsubscribe function.
 */
export function subscribePrimary(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
