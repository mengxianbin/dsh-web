/**
 * The row's model-facing gate: the squad tools register only while the plugin is
 * enabled, and the announcement section exists only while announceToAgent is on.
 * The section names only the tools the rendering scope can really see, so a
 * restriction or a preset composition that withholds them also withholds the
 * guidance that would tell the model to call them.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENTS_TOOL_GUIDANCE, AGENTS_TOOL_NAMES } from '../src/host/agent-tools.ts'
import { AGENTS_TOOL_SECTION_NAME, Config, apply } from '../src/index.ts'
import type { Config as AgentsConfig } from '../src/index.ts'
import { PLUGIN_TOOL_SECTION_ORDERS } from '../src/tool-surface.ts'

/** The write protocol a volatile config reference shares across cosmokit copies. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** One registered system-prompt section, as the fake registry records it. */
interface Section {
  name: string
  order: number
  text: (context: { scope?: unknown }) => string
}

interface Activation {
  /** Tool names currently registered, in registration order. */
  readonly registered: string[]
  /** Sections currently registered. */
  readonly sections: Section[]
  /** Commit a volatile field and dispatch the update the Loader emits. */
  commit(field: 'announceToAgent', value: boolean): void
  /** Unload the row, as cordis does when the fiber is disposed. */
  dispose(): void
}

interface ActivationOptions {
  /** Whether this deployment serves a tool registry at all. */
  serveRegistry?: boolean
  /** The scoped lookup the section asks before it names a tool. */
  lookup?: (name: string, scope?: unknown) => unknown
}

const homes: string[] = []
const activations: Activation[] = []

/**
 * Activate the real row against a capture-only context, recording the tool
 * registrations and the prompt sections it makes.
 */
function activate(config: AgentsConfig, options: ActivationOptions = {}): Activation {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agents-gate-home-'))
  homes.push(home)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const registered: string[] = []
    const sections: Section[] = []
    const disposers: Array<() => void> = []
    let volatileListener: (() => void) | undefined
    const tools = {
      register: (tool: ToolDefinition): (() => void) => {
        registered.push(tool.name)
        return () => {
          const index = registered.indexOf(tool.name)
          if (index >= 0) registered.splice(index, 1)
        }
      },
      ...(options.lookup === undefined ? {} : { get: options.lookup }),
    }
    const ctx = {
      typertGateway: {},
      get: (name: string) => (name === 'tools' && options.serveRegistry !== false ? tools : undefined),
      systemPrompt: {
        section: (section: Section): (() => void) => {
          sections.push(section)
          return () => {
            const index = sections.indexOf(section)
            if (index >= 0) sections.splice(index, 1)
          }
        },
        context: () => () => undefined,
        getSectionOrder: () => 0,
        getContextOrder: () => 0,
      },
      webServer: { register: () => () => undefined },
      effect: (body: () => unknown): (() => void) => {
        const dispose = body()
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
        return () => undefined
      },
      on: (event: string, listener: () => void): (() => void) => {
        if (event === 'loader/volatile-update') volatileListener = listener
        return () => undefined
      },
      logger: { warn: () => undefined },
    }
    apply(ctx as never, config)
    const live: Activation = {
      registered,
      sections,
      commit: (field, value) => {
        const reference = (config as unknown as Record<string, Record<symbol, (next: unknown) => void>>)[field]
        reference[VOLATILE_WRITE](value)
        volatileListener?.()
      },
      dispose: () => {
        for (const dispose of disposers.splice(0)) dispose()
      },
    }
    activations.push(live)
    return live
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

/** The announcement section alone, leaving the member-brief section aside. */
function announcement(live: Activation): Section[] {
  return live.sections.filter(section => section.name === AGENTS_TOOL_SECTION_NAME)
}

beforeEach(() => {
  // Each activation points DSH_HOME at its own scratch directory, so two rows in
  // one test never contend for the ledger lock.
  delete process.env.DSH_HOME
})

afterEach(() => {
  for (const live of activations.splice(0)) live.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('tool registration gate', () => {
  it('operator on an enabled row gets exactly the ten declared squad tools', () => {
    // Given an enabled row whose deployment serves a tool registry, When it mounts
    const live = activate(Config({ enabled: true }))

    // Then the registry holds the declared surface in order, and no announcement
    expect(live.registered).toEqual([...AGENTS_TOOL_NAMES])
    expect(announcement(live)).toHaveLength(0)
  })

  it('operator on a disabled row gets no tool and no prompt section at all', () => {
    // Given a row switched off, When it is activated
    const live = activate(Config({ enabled: false }))

    // Then nothing is registered: not a tool, not even the member-brief section
    expect(live.registered).toEqual([])
    expect(live.sections).toEqual([])
  })

  it('operator mounting from a plain config object gets the same surface as a resolved one', () => {
    // Given a hand-built context handing plain values instead of live references, When the row mounts through it
    const live = activate({ enabled: true, announceToAgent: true })

    // Then the surface is the same the loader would produce
    expect(live.registered).toEqual([...AGENTS_TOOL_NAMES])
    expect(announcement(live)).toHaveLength(1)
  })

  it('operator on a deployment that serves no tool registry still mounts, with no tool and no crash', () => {
    // Given a deployment whose context serves no registry, When the row activates
    const live = activate(Config({ enabled: true, announceToAgent: true }), { serveRegistry: false })

    // Then it registers nothing and the mount survived
    expect(live.registered).toEqual([])
    // An unreadable registry renders the guidance rather than pretending the
    // tools are gone: only a readable lookup may withhold it.
    expect(announcement(live)[0].text({})).toBe(AGENTS_TOOL_GUIDANCE)
  })

  it('operator unloading the row releases every tool and the announcement', () => {
    // Given a mounted row with its announcement on
    const live = activate(Config({ enabled: true, announceToAgent: true }))
    expect(live.registered).toHaveLength(AGENTS_TOOL_NAMES.length)
    expect(announcement(live)).toHaveLength(1)

    // When the fiber is disposed
    live.dispose()

    // Then nothing outlives it
    expect(live.registered).toEqual([])
    expect(announcement(live)).toHaveLength(0)
  })
})

describe('the announcement section', () => {
  it('user switching the announcement on gets one section at the agents band naming the tools', () => {
    // Given an enabled row whose announcement is off
    const live = activate(Config({ enabled: true }))
    expect(announcement(live)).toHaveLength(0)

    // When the operator commits the switch
    live.commit('announceToAgent', true)

    // Then one section appears in the agents band and it names the surface
    const [section] = announcement(live)
    expect(section.name).toBe(AGENTS_TOOL_SECTION_NAME)
    expect(section.order).toBe(PLUGIN_TOOL_SECTION_ORDERS.agents)
    expect(section.text({})).toBe(AGENTS_TOOL_GUIDANCE)
    for (const name of AGENTS_TOOL_NAMES) expect(AGENTS_TOOL_GUIDANCE).toContain(name)
    expect(AGENTS_TOOL_GUIDANCE).toContain('confirm: true')
  })

  it('user switching the announcement back off drops the section again', () => {
    // Given a mounted row whose announcement is on
    const live = activate(Config({ enabled: true, announceToAgent: true }))
    expect(announcement(live)).toHaveLength(1)

    // When the operator turns it off
    live.commit('announceToAgent', false)

    // Then no section remains
    expect(announcement(live)).toHaveLength(0)
  })

  it('operator committing the value it already holds does not rebuild the section', () => {
    // Given a mounted row whose announcement is on
    const live = activate(Config({ enabled: true, announceToAgent: true }))
    const first = announcement(live)[0]

    // When the same value is committed again
    live.commit('announceToAgent', true)

    // Then the registered section is the very same one, so the prompt registry never churned
    expect(announcement(live)).toHaveLength(1)
    expect(announcement(live)[0]).toBe(first)
  })

  it('operator whose scoped lookup cannot see any tool gets an empty section text', () => {
    // Given a registry that answers every lookup with "not visible"
    const live = activate(Config({ enabled: true, announceToAgent: true }), { lookup: () => undefined })

    // When the announcement renders for that scope, Then the guidance for those tools is withdrawn
    expect(announcement(live)[0].text({})).toBe('')
  })

  it('operator whose scoped lookup sees one of the tools keeps the whole guidance', () => {
    // Given a registry that can see exactly one squad tool
    const live = activate(Config({ enabled: true, announceToAgent: true }), {
      lookup: name => (name === 'squads_list' ? { name } : undefined),
    })

    // When the announcement renders for that scope, Then the guidance renders,
    // because part of the surface is really reachable
    expect(announcement(live)[0].text({ scope: {} })).toBe(AGENTS_TOOL_GUIDANCE)
  })
})
