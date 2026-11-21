/**
 * Tool-surface tests: every declared output schema is inside the enforced JSON
 * Schema subset, every executed value validates against its own schema, and
 * browser_screenshot returns a real image part instead of base64 text.
 */

import { describe, expect, it } from 'vitest'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { BROWSER_TOOL_NAMES, createBrowserTools, type DurableImageRef } from '../../src/host/tools.ts'
import { createFakeBrowser } from '../helpers/fake-browser.ts'

/** The declared canonical-value type, read off the tool contract itself. */
type Json = Parameters<ToolDefinition['output']['render']>[1]

/** A structurally valid result narrowed to the validator's input type. */
function asJson(value: unknown): Json {
  return value as Json
}

/** One execution context carrying an optional calling session. */
function fakeExec(sessionId?: string): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('token'),
    name: 'browser_test',
    arguments: {},
    signal: new AbortController().signal,
    agent: sessionId === undefined ? undefined : { session: { id: sessionId } },
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  } as unknown as ToolRunContext
}

/** The reference the fake attachment store hands back. */
const STORED: DurableImageRef = {
  attachmentId: 'att-1',
  mediaType: 'image/jpeg',
  bytes: 10,
  width: 1280,
  height: 800,
  name: 'browser-view-tab-1.jpg',
}

/** Build the tools over a fake browser plus a recording attachment store. */
function build(options: { saveImage?: boolean } = {}) {
  const browser = createFakeBrowser()
  const saved: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
  const tools = createBrowserTools({
    service: browser.service,
    ...options.saveImage === false ? {} : {
      saveImage: async (input: { data: Uint8Array; mediaType: 'image/jpeg'; name?: string }) => {
        saved.push(input)
        return { ...STORED, bytes: input.data.byteLength }
      },
    },
  })
  const byName = (name: string): ToolDefinition => {
    const found = tools.find(tool => tool.name === name)
    if (found === undefined) throw new Error(`missing tool ${name}`)
    return found
  }
  return { browser, tools, saved, byName }
}

describe('tool catalog', () => {
  it('operator lists the tool surface and exactly the eleven documented tools are registered', () => {
    // Given the tool surface built over the fake browser
    // When the tool names are read
    // Then they equal the documented name list exactly
    const { tools } = build()
    expect(tools.map(tool => tool.name)).toEqual([...BROWSER_TOOL_NAMES])
  })

  it('operator inspects every output schema and each one sits inside the enforced subset', () => {
    // Given every declared tool
    // When each output schema is checked
    // Then none throws, so all of them sit inside the enforced subset
    const { tools } = build()
    for (const tool of tools) {
      expect(() => assertSupportedJsonSchema(tool.output.schema), tool.name).not.toThrow()
    }
  })

  it('operator dispatches browser_navigate and its parameters are the enforced JSON Schema', () => {
    // Given the browser_navigate tool
    // When its parameters and description are read
    // Then the parameters declare url and the description points at browser_snapshot
    const { byName } = build()
    const navigate = byName('browser_navigate')
    expect(JSON.stringify(navigate.parameters)).toContain('"url"')
    expect(navigate.description).toContain('browser_snapshot')
  })

  it('operator reads the tool descriptions and they say a ref expires with its observation', () => {
    // Given the click and snapshot descriptions
    // When they are read
    // Then they say a ref expires with the most recent snapshot and that a re-render or navigation invalidates it
    const { byName } = build()
    expect(byName('browser_click').description).toMatch(/most recent browser_snapshot/)
    expect(byName('browser_click').description).toMatch(/re-rendered|navigated/)
    expect(byName('browser_snapshot').description).toMatch(/browser_click/)
  })

  it('operator reads every description and each is English prose of a usable length', () => {
    // Given every declared tool
    // When each description is read
    // Then it is longer than 80 characters and carries no placeholder marker
    const { tools } = build()
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(80)
      expect(tool.description, tool.name).not.toMatch(/TODO|FIXME/)
    }
  })
})

describe('browser_screenshot', () => {
  it('operator calls browser_screenshot and receives an image block beside its envelope', async () => {
    // Given an attachment store
    // When browser_screenshot runs
    // Then the saved bytes are the decoded JPEG, the value validates, and the blocks are one text plus one image with the stored id, size and name
    const { byName, saved } = build()
    const tool = byName('browser_screenshot')
    const value = await tool.execute({}, fakeExec('session-a')) as { tabId: string; image: DurableImageRef }

    expect(validateJsonSchemaValue(tool.output.schema, asJson(value))).toEqual([])
    expect(saved).toHaveLength(1)
    expect(saved[0]?.mediaType).toBe('image/jpeg')
    expect(saved[0]?.data.byteLength).toBe(Buffer.from('JPEG-BYTES', 'base64').byteLength)

    const blocks = tool.output.render({}, asJson(value)) as ContentBlock[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text).toContain('image/jpeg screenshot, 1280x800 px')
    // The fake store reports the stored byte length, so the block carries the
    // decoded size rather than the base64 length.
    expect(blocks[1]).toEqual({
      type: 'image',
      attachment: {
        attachmentId: 'att-1',
        mediaType: 'image/jpeg',
        bytes: Buffer.from('JPEG-BYTES', 'base64').byteLength,
        width: 1280,
        height: 800,
        name: 'browser-view-tab-1.jpg',
      },
    })
  })

  it('operator calls browser_screenshot without an attachment service and the call refuses', async () => {
    // Given no attachment service
    // When browser_screenshot runs
    // Then it rejects naming the attachment service instead of faking an image
    const { byName } = build({ saveImage: false })
    await expect(byName('browser_screenshot').execute({}, fakeExec('session-a')))
      .rejects.toThrow(/attachment service/)
  })
})

describe('multiple tabs through the tool surface', () => {
  it('operator passes new_tab and browser_tabs then lists both pages', async () => {
    // Given a session that already navigated to one page
    // When browser_navigate runs with new_tab true and browser_tabs reads the catalog
    // Then two tabs are listed, the new one is active and both ids differ
    const { byName } = build()
    const first = await byName('browser_navigate').execute({ url: 'https://a.test/' }, fakeExec('session-a')) as { tabId: string }
    const second = await byName('browser_navigate').execute(
      { url: 'https://b.test/', new_tab: true },
      fakeExec('session-a'),
    ) as { tabId: string }

    const listed = await byName('browser_tabs').execute({}, fakeExec('session-a')) as {
      tabs: Array<{ id: string }>
      activeTabId: string | null
    }

    expect(second.tabId).not.toBe(first.tabId)
    expect(listed.tabs.map(tab => tab.id)).toEqual([first.tabId, second.tabId])
    expect(listed.activeTabId).toBe(second.tabId)
  })

  it('operator names a tab_id and the navigation lands in that tab', async () => {
    // Given two open tabs
    // When browser_navigate names the first tab id
    // Then the result reports that tab and the session follows it
    const { byName } = build()
    const first = await byName('browser_navigate').execute({ url: 'https://a.test/' }, fakeExec('session-a')) as { tabId: string }
    await byName('browser_navigate').execute({ url: 'https://b.test/', new_tab: true }, fakeExec('session-a'))

    const routed = await byName('browser_navigate').execute(
      { url: 'https://c.test/', tab_id: first.tabId },
      fakeExec('session-a'),
    ) as { tabId: string }

    expect(routed.tabId).toBe(first.tabId)
    const listed = await byName('browser_tabs').execute({}, fakeExec('session-a')) as { tabs: Array<{ id: string }> }
    expect(listed.tabs.map(tab => tab.id)).toEqual([first.tabId, 'tab-2'])
  })

  it('operator reads the declared parameters and new_tab is an optional boolean', async () => {
    // Given the registered navigate tool
    // When its model-facing parameter schema is projected
    // Then new_tab is declared as a boolean and is not required
    const { byName } = build()
    const parameters = byName('browser_navigate').parameters as {
      properties: Record<string, { type?: string }>
      required?: string[]
    }
    expect(parameters.properties.new_tab?.type).toBe('boolean')
    expect(parameters.required ?? []).toEqual(['url'])
  })
})

describe('browser_close', () => {
  it('operator closes the tab it opened and another session keeps its page', async () => {
    // Given two sessions each driving a tab of their own
    // When the first session closes its tab
    // Then exactly that tab is reported closed and the other session still has its page
    const { byName } = build()
    const mine = await byName('browser_navigate').execute({ url: 'https://a.test/' }, fakeExec('session-a')) as { tabId: string }
    const theirs = await byName('browser_navigate').execute({ url: 'https://b.test/' }, fakeExec('session-b')) as { tabId: string }

    const closed = await byName('browser_close').execute({}, fakeExec('session-a')) as { closed: string[] }

    expect(closed.closed).toEqual([mine.tabId])
    const left = await byName('browser_tabs').execute({}, fakeExec('session-b')) as { tabs: Array<{ id: string }> }
    expect(left.tabs.map(tab => tab.id)).toEqual([theirs.tabId])
  })

  it('operator names a tab another session opened and the close is refused with the reason', async () => {
    // Given a tab owned by session B
    // When session A asks to close that exact tab
    // Then the call rejects naming the ownership rule and the tab is still open
    const { byName } = build()
    await byName('browser_navigate').execute({ url: 'https://a.test/' }, fakeExec('session-a'))
    const theirs = await byName('browser_navigate').execute({ url: 'https://b.test/' }, fakeExec('session-b')) as { tabId: string }

    await expect(byName('browser_close').execute({ tab_id: theirs.tabId }, fakeExec('session-a')))
      .rejects.toThrow(/was not opened by this session/)

    const left = await byName('browser_tabs').execute({}, fakeExec('session-a')) as { tabs: Array<{ id: string }> }
    expect(left.tabs.map(tab => tab.id)).toContain(theirs.tabId)
  })

  it('operator closes from a session that owns no tab and the call closes nothing', async () => {
    // Given a browser running for another session
    // When a session with no tab of its own asks to close
    // Then nothing is reported closed, the call does not throw, and the other page stays
    const { byName } = build()
    const theirs = await byName('browser_navigate').execute({ url: 'https://a.test/' }, fakeExec('session-a')) as { tabId: string }

    const closed = await byName('browser_close').execute({}, fakeExec('session-b')) as { closed: string[] }

    expect(closed.closed).toEqual([])
    const left = await byName('browser_tabs').execute({}, fakeExec('session-a')) as { tabs: Array<{ id: string }> }
    expect(left.tabs.map(tab => tab.id)).toEqual([theirs.tabId])
  })

  it('operator closes before any browser started and the call reports nothing closed', async () => {
    // Given no browser started at all
    // When browser_close runs
    // Then it closes nothing instead of failing to start a browser
    const { byName, browser } = build()
    const closed = await byName('browser_close').execute({}, fakeExec('session-a')) as { closed: string[] }
    expect(closed.closed).toEqual([])
    expect(browser.opens()).toBe(0)
  })

  it('operator names an unknown tab id and the close is refused with the tab id', async () => {
    // Given no tab with that id
    // When browser_close names it
    // Then the call rejects pointing at browser_tabs
    const { byName } = build()
    await byName('browser_navigate').execute({ url: 'https://a.test/' }, fakeExec('session-a'))
    await expect(byName('browser_close').execute({ tab_id: 'tab-nope' }, fakeExec('session-a')))
      .rejects.toThrow(/unknown tab "tab-nope"/)
  })

  it('operator reads the declared result and the closed list validates against its own schema', async () => {
    // Given the registered close tool
    // When a close runs and its value is validated and rendered
    // Then the value satisfies the schema and renders one text block carrying the closed ids
    const { byName } = build()
    const mine = await byName('browser_navigate').execute({ url: 'https://a.test/' }, fakeExec('session-a')) as { tabId: string }
    const tool = byName('browser_close')
    const value = await tool.execute({}, fakeExec('session-a')) as { closed: string[] }

    expect(validateJsonSchemaValue(tool.output.schema, asJson(value))).toEqual([])
    const blocks = tool.output.render({}, asJson(value)) as ContentBlock[]
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { text: string }).text).toContain(mine.tabId)
  })
})

describe('structured results', () => {
  it('operator lists tabs before any browser starts and the catalog is empty', async () => {
    // Given no browser started
    // When browser_tabs runs
    // Then the value is an empty catalog and renders one text block with a null active tab
    const { byName } = build()
    const tool = byName('browser_tabs')
    const value = await tool.execute({}, fakeExec()) as { tabs: unknown[]; activeTabId: string | null }
    expect(value).toEqual({ tabs: [], activeTabId: null })
    expect(validateJsonSchemaValue(tool.output.schema, asJson(value))).toEqual([])
    const blocks = tool.output.render({}, asJson(value)) as ContentBlock[]
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { text: string }).text).toContain('"activeTabId": null')
  })

  it('operator lists tabs once a tab exists and the result still validates', async () => {
    // Given one tab
    // When browser_tabs runs
    // Then it reports that tab as active and the value validates
    const { byName, browser } = build()
    await browser.service.ensureTab('session-a')
    const tool = byName('browser_tabs')
    const value = await tool.execute({}, fakeExec('session-a')) as { tabs: Array<{ id: string }>; activeTabId: string }
    expect(value.tabs).toHaveLength(1)
    expect(value.activeTabId).toBe('tab-1')
    expect(validateJsonSchemaValue(tool.output.schema, asJson(value))).toEqual([])
  })

  it('operator navigates and the result reports the settled page', async () => {
    // Given the browser_navigate tool
    // When it runs against a url
    // Then the value names the tab and url, the summary contains the url and the value validates
    const { byName } = build()
    const tool = byName('browser_navigate')
    const value = await tool.execute({ url: 'https://a.test/' }, fakeExec('session-a')) as Record<string, unknown>
    expect(value.tabId).toBe('tab-1')
    expect(value.url).toBe('https://a.test/')
    expect(String(value.summary)).toContain('https://a.test/')
    expect(validateJsonSchemaValue(tool.output.schema, asJson(value))).toEqual([])
  })

  it('operator snapshots and numbered nodes validate against the schema', async () => {
    // Given the browser_snapshot tool
    // When it runs
    // Then truncation is false, the refs run 0 to 2 and the value validates
    const { byName } = build()
    const tool = byName('browser_snapshot')
    const value = await tool.execute({}, fakeExec('session-a')) as { nodes: Array<{ ref: number }>; truncated: boolean }
    expect(value.truncated).toBe(false)
    expect(value.nodes.map(node => node.ref)).toEqual([0, 1, 2])
    expect(validateJsonSchemaValue(tool.output.schema, asJson(value))).toEqual([])
  })

  it('operator clicks a ref from the same observation and the page receives three mouse events', async () => {
    // Given a snapshot from the same session
    // When browser_click uses one of its refs
    // Then the summary says clicked ref 1, the value validates and three mouse events reached the page
    const { byName, browser } = build()
    await byName('browser_snapshot').execute({}, fakeExec('session-a'))
    const tool = byName('browser_click')
    const value = await tool.execute({ ref: 1 }, fakeExec('session-a')) as { summary: string }
    expect(value.summary).toContain('Clicked ref 1')
    expect(validateJsonSchemaValue(tool.output.schema, asJson(value))).toEqual([])
    expect(browser.transport.callsOf('Input.dispatchMouseEvent')).toHaveLength(3)
  })

  it('operator types and presses and both results report what they touched', async () => {
    // Given browser_type and browser_press
    // When each runs
    // Then typing reports five characters and pressing reports the key, and both values validate
    const { byName } = build()
    const typed = await byName('browser_type').execute({ text: 'hello', selector: 'input' }, fakeExec('session-a')) as Record<string, unknown>
    expect(typed.characters).toBe(5)
    expect(String(typed.summary)).toContain('Typed 5 characters')
    expect(validateJsonSchemaValue(byName('browser_type').output.schema, asJson(typed))).toEqual([])

    const pressed = await byName('browser_press').execute({ key: 'Enter' }, fakeExec('session-a')) as Record<string, unknown>
    expect(pressed.summary).toBe('Pressed Enter')
    expect(validateJsonSchemaValue(byName('browser_press').output.schema, asJson(pressed))).toEqual([])
  })

  it('operator presses an unsupported key and the call refuses', async () => {
    // Given the browser_press tool
    // When it is asked for an unsupported key
    // Then it rejects naming the unsupported key
    const { byName } = build()
    await expect(byName('browser_press').execute({ key: 'F13' }, fakeExec('session-a')))
      .rejects.toThrow(/unsupported key/)
  })

  it('operator scrolls and the result reports the distance it moved', async () => {
    // Given the browser_scroll tool
    // When it scrolls 400 px down
    // Then the summary reports the distance and the value validates
    const { byName } = build()
    const value = await byName('browser_scroll').execute({ delta_y: 400 }, fakeExec('session-a')) as Record<string, unknown>
    expect(value.summary).toBe('Scrolled down 400 px')
    expect(validateJsonSchemaValue(byName('browser_scroll').output.schema, asJson(value))).toEqual([])
  })

  it('operator reads console and network and both entry shapes validate', async () => {
    // Given a tab with one console call and one answered request
    // When both tools run
    // Then console reports one entry and network reports status 200, and both values validate
    const { byName, browser } = build()
    await browser.service.ensureTab('session-a')
    browser.transport.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hi' }] }, 'session-1')
    browser.transport.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://a.test/x', method: 'GET' },
    }, 'session-1')
    browser.transport.emit('Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'text/html' } }, 'session-1')

    const consoleTool = byName('browser_console')
    const consoleValue = await consoleTool.execute({}, fakeExec('session-a')) as { entries: unknown[] }
    expect(consoleValue.entries).toHaveLength(1)
    expect(validateJsonSchemaValue(consoleTool.output.schema, asJson(consoleValue))).toEqual([])

    const networkTool = byName('browser_network')
    const networkValue = await networkTool.execute({}, fakeExec('session-a')) as { entries: Array<{ status: number }> }
    expect(networkValue.entries[0]?.status).toBe(200)
    expect(validateJsonSchemaValue(networkTool.output.schema, asJson(networkValue))).toEqual([])
  })
})