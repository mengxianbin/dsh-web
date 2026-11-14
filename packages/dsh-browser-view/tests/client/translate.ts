/**
 * Test-side translate function.
 *
 * The slot machinery normally synthesizes `t` from the installed dictionaries;
 * a unit test mounts the component directly, so it binds a dictionary itself.
 */
/** A dictionary of the browser-view namespace. */
export type TestDictionary = Record<string, string>

/**
 * Bind a dictionary to a translate function.
 * @param dictionary - copy source (zh is the key-set source of truth).
 * @returns the `t` seat the component expects.
 */
export function translate(dictionary: TestDictionary): (key: string, params?: Record<string, unknown>) => string {
  return (key: string, params?: Record<string, unknown>): string => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match: string, name: string): string => {
      const value = params[name]
      return value === undefined ? match : String(value)
    })
  }
}
