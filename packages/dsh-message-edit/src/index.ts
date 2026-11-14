/** Host entry for the pure-browser message-edit plugin. */
import type { Context } from '@deepseek-ai/cordis'

/** Apply the host half, which intentionally has no behavior. */
export function apply(_ctx: Context): void {
  // Session forking and prompting already belong to the official controller.
}
