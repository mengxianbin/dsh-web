/**
 * The command channel's projection: the host's slash-command registry and one
 * session's skill catalog folded into the single flat directory a phone lists.
 *
 * Nothing here is stateful. Every answer is read from the host on the call that
 * answers it — no cache, no event, no snapshot — so a command a plugin
 * registered a moment ago and a skill the session's own preset withdrew are
 * both reflected in the next answer, and a phone never renders a directory that
 * this bridge remembered on its behalf.
 *
 * The `line` of an item is the whole text a client completes into its draft,
 * separator space included, because both host surfaces resolve a bare gesture
 * only when whitespace or the end of the text follows the name: the command
 * registry splits a line into name and input at that separator, and a skill
 * gesture is `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/` in
 * `@deepseek-ai/dsh-tool-skill`. A skill line is therefore text a client writes
 * and the host reads out of the submitted prompt, never a command line: a skill
 * is not registered with the command registry, so `commands/execute` answers
 * `undefined` for it — which is exactly what a caller of `session.command` is
 * told with `matched: false`.
 * @module dsh-remote-bridge/core/commands
 */

/** One row of the directory: a slash command or a skill, as the phone renders it. */
export interface CommandItem {
  /** The host's own name for the row, without a leading slash. */
  readonly name: string
  /** The host's own one-line summary, verbatim. */
  readonly description: string
  /** Which host catalog the row came from; the two never mix order. */
  readonly kind: 'command' | 'skill'
  /** The complete draft text that invokes this row. */
  readonly line: string
}

/** The draft text one host name completes to: the gesture plus its separator. */
function lineOf(name: string): string {
  return `/${name} `
}

/**
 * The name and description of one host row, or undefined when the row carries
 * neither a name nor a summary a client could render.
 *
 * The host's strict codec already guarantees the shape, so this only keeps a
 * row this bridge could not render out of a phone's directory: a row with no
 * name would cross as `/undefined`, which is worse than a shorter list.
 * @param row - one element of a host catalog answer.
 */
function namedRow(row: unknown): { readonly name: string; readonly description: string } | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const { name, description } = row as { name?: unknown; description?: unknown }
  if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
  return { name, description }
}

/**
 * Fold the host's two catalogs into one directory: every command first, in the
 * order the host listed them, then every skill, in the order the host listed
 * them. Neither list is re-sorted, de-duplicated or cut into pages — a name
 * both catalogs carry stays two rows, because the two rows do different things.
 * @param commands - the `commands/list` answer, as it arrived.
 * @param skills - the `skills/list` answer's `skills` array, as it arrived.
 * @returns the rows a client renders, in the one order this protocol promises.
 */
export function commandItems(commands: readonly unknown[], skills: readonly unknown[]): readonly CommandItem[] {
  const items: CommandItem[] = []
  for (const [kind, rows] of [['command', commands], ['skill', skills]] as const) {
    for (const row of rows) {
      const named = namedRow(row)
      if (named === undefined) continue
      items.push({ name: named.name, description: named.description, kind, line: lineOf(named.name) })
    }
  }
  return items
}

/**
 * Whether a gateway failure means this host serves no endpoint behind the
 * channel at all, rather than refusing this one call.
 *
 * The gateway reports an endpoint nothing exports as `invocation-unavailable`
 * and a withdrawn strict definition as `definition-unavailable`; both leave the
 * call with nowhere to go, which is the one case this bridge answers with its
 * own `commands-unavailable`. A service that is merely still activating keeps
 * its own code: that window is retried before it arrives here, and a retried
 * failure is a broken deployment rather than an absent channel.
 *
 * Both spellings of each code are recognized, exactly as `gateway-errors.ts`
 * recognizes them for the activation window.
 * @param code - the failure's own code, as it crossed to the refusal.
 */
export function commandsUnavailable(code: string): boolean {
  return ['invocation-unavailable', 'definition-unavailable'].some(bare => code === bare || code === `gateway/${bare}`)
}
