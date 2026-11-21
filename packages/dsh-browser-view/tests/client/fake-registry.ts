/**
 * Fake right-sidebar tab-type registry for the browser-half tests.
 *
 * The plugin registers one tab type (tab-type.ts) and the test reads the exact
 * definition the real service would receive, by giving the shell this recording
 * registry instead of patching the module graph.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** Recording tab-type registry. */
export interface FakeTabRegistry {
  /** Shape handed to the plugin as ctx.sidebarRightTabs. */
  readonly service: Record<string, unknown>
  /** Definitions registered so far, in order. */
  readonly definitions: ReadonlyArray<SidebarRightTabDefinition>
  /** How many registered types have been disposed. */
  readonly disposed: () => number
}

/**
 * Build one recording tab-type registry.
 * @param options - `refusesRegistration` reproduces a kind already held in the same band.
 * @returns the fake.
 */
export function createFakeTabRegistry(options: { refusesRegistration?: boolean } = {}): FakeTabRegistry {
  const definitions: SidebarRightTabDefinition[] = []
  let disposed = 0
  const service = {
    register(definition: SidebarRightTabDefinition): () => void {
      if (options.refusesRegistration === true) throw new Error('the kind is already registered')
      definitions.push(definition)
      return () => {
        disposed += 1
      }
    },
  }
  return { service, definitions, disposed: () => disposed }
}
