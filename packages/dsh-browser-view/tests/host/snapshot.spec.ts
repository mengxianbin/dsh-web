/**
 * Snapshot tests: the depth-first ref contract, the node limit, and the ref map
 * that makes browser_click able to reuse a ref at all.
 */

import { describe, expect, it } from 'vitest'
import { SNAPSHOT_NODE_LIMIT } from '../../src/core/protocol.ts'
import type { RawSnapshotNode } from '../../src/core/snapshot.ts'
import { assembleSnapshot, buildSnapshot, buildSnapshotExpression } from '../../src/core/snapshot.ts'
import { FakeTransport } from '../helpers/fake-cdp.ts'

/** One plausible raw walk, in depth-first order. */
const RAW: RawSnapshotNode[] = [
  { tag: 'body', depth: 0, selector: 'body', box: { x: 0, y: 0, width: 1280, height: 800 } },
  {
    tag: 'h1',
    depth: 1,
    selector: 'body > h1',
    text: 'ok',
    role: 'heading',
    name: 'ok',
    box: { x: 8, y: 8, width: 200, height: 40 },
  },
  { tag: 'form', depth: 1, selector: 'body > form' },
  { tag: 'input', id: 'q', classes: ['field'], depth: 2, selector: 'body > form > input#q', role: 'textbox' },
  { tag: 'button', depth: 2, selector: 'body > form > button', role: 'button', name: 'Search' },
]

describe('assembleSnapshot', () => {
  it('operator snapshots a page and nodes are numbered depth-first with their selectors kept', () => {
    // Given one depth-first walk of five nodes
    // When the snapshot is assembled
    // Then refs run 0 to 4 in tag order, truncation is false and the ref map pairs each ref with its selector
    const { snapshot, refs } = assembleSnapshot({ tabId: 'tab-1', url: 'https://a.test/', title: 'A', raw: RAW })
    expect(snapshot.nodes.map(node => node.ref)).toEqual([0, 1, 2, 3, 4])
    expect(snapshot.nodes.map(node => node.tag)).toEqual(['body', 'h1', 'form', 'input', 'button'])
    expect(snapshot.truncated).toBe(false)
    expect(refs.get(1)).toBe('body > h1')
    expect(refs.get(4)).toBe('body > form > button')
  })

  it('operator snapshots the same walk twice and a ref from the first still resolves', () => {
    // Given the same walk assembled twice
    // When both ref maps are compared
    // Then they are equal, so a click can reuse a ref from the earlier snapshot
    const first = assembleSnapshot({ tabId: 'tab-1', url: '', title: '', raw: RAW })
    const second = assembleSnapshot({ tabId: 'tab-1', url: '', title: '', raw: RAW })
    expect([...second.refs.entries()]).toEqual([...first.refs.entries()])
  })

  it('operator snapshots with a small limit and the walk is cut and reported truncated', () => {
    // Given a walk of five nodes and a limit of three
    // When the snapshot is assembled
    // Then three nodes are kept, truncation is true and three refs are mapped
    const { snapshot, refs } = assembleSnapshot({ tabId: 'tab-1', url: '', title: '', raw: RAW, limit: 3 })
    expect(snapshot.nodes).toHaveLength(3)
    expect(snapshot.truncated).toBe(true)
    expect(refs.size).toBe(3)
  })

  it('operator reads the truncated flag from an exact-limit walk and a shorter one', () => {
    // Given a limit equal to the walk length, then a limit of two
    // When each snapshot is assembled
    // Then the exact limit reports no truncation and the shorter one reports it
    const { snapshot } = assembleSnapshot({ tabId: 'tab-1', url: '', title: '', raw: RAW, limit: RAW.length })
    expect(snapshot.truncated).toBe(false)
    const small = assembleSnapshot({ tabId: 'tab-1', url: '', title: '', raw: RAW, limit: 2 })
    expect(small.snapshot.truncated).toBe(true)
  })

  it('operator snapshots a form and role, name, text and box survive while empty fields are omitted', () => {
    // Given a walk whose heading carries role, name, text and box and whose form carries none of them
    // When the snapshot is assembled
    // Then the heading keeps every field and the form holds only ref, tag and depth
    const { snapshot } = assembleSnapshot({ tabId: 'tab-1', url: '', title: '', raw: RAW })
    const heading = snapshot.nodes[1]
    expect(heading).toEqual({
      ref: 1,
      tag: 'h1',
      depth: 1,
      text: 'ok',
      role: 'heading',
      name: 'ok',
      box: { x: 8, y: 8, width: 200, height: 40 },
    })
    const form = snapshot.nodes[2]
    expect(form).toEqual({ ref: 2, tag: 'form', depth: 1 })
  })

  it('operator snapshots without a limit and the contract constant covers the walk', () => {
    // Given a walk of ten nodes and no explicit limit
    // When the snapshot is assembled
    // Then all ten nodes survive and the contract limit is larger than ten
    const raw: RawSnapshotNode[] = Array.from({ length: 10 }, (_unused, index) => ({
      tag: 'div',
      depth: 0,
      selector: `div:nth-of-type(${index + 1})`,
    }))
    const { snapshot } = assembleSnapshot({ tabId: 'tab-1', url: '', title: '', raw })
    expect(snapshot.nodes).toHaveLength(10)
    expect(SNAPSHOT_NODE_LIMIT).toBeGreaterThan(10)
  })
})

describe('buildSnapshotExpression', () => {
  it('operator builds the page expression and it parses as valid JS while carrying the limit', () => {
    // Given a limit of 25
    // When the page expression is built
    // Then it carries the limit assignment and parses without executing
    const expression = buildSnapshotExpression(25)
    expect(expression).toContain('const LIMIT = 25;')
    // Parsing without executing proves the generated source is valid JS; the
    // body only runs inside a page, which is where the probe script exercises it.
    expect(() => new Function(`return ${expression}`)).not.toThrow()
  })

  it('operator asks for a zero-node limit and the expression clamps it to one', () => {
    // Given a limit of zero
    // When the page expression is built
    // Then the emitted limit is one
    expect(buildSnapshotExpression(0)).toContain('const LIMIT = 1;')
  })
})

describe('buildSnapshot', () => {
  it('operator snapshots over the wire and url, title and truncation come from the page walk', async () => {
    // Given a page that answers the evaluate call with a snapshot payload
    // When the snapshot is built over the fake transport
    // Then url, title and truncation come from the payload, the ref map covers every node and the call names the session
    const transport = new FakeTransport()
    transport.responses.set('Runtime.evaluate', {
      result: {
        value: {
          url: 'data:text/html,<h1>ok</h1>',
          title: 'ok',
          truncated: true,
          nodes: RAW,
        },
      },
    })
    const result = await buildSnapshot(transport, 'tab-1', 'session-1')
    expect(result.snapshot.url).toBe('data:text/html,<h1>ok</h1>')
    expect(result.snapshot.title).toBe('ok')
    expect(result.snapshot.truncated).toBe(true)
    expect(result.refs.size).toBe(RAW.length)
    expect(transport.lastCall('Runtime.evaluate')?.sessionId).toBe('session-1')
  })

  it('operator snapshots a page that answered with nothing usable and the call refuses', async () => {
    // Given a page that answers with a string instead of a snapshot
    // When the snapshot is built
    // Then it rejects asking for a readable DOM snapshot
    const transport = new FakeTransport()
    transport.responses.set('Runtime.evaluate', { result: { value: 'nope' } })
    await expect(buildSnapshot(transport, 'tab-1', 'session-1')).rejects.toThrow(/readable DOM snapshot/)
  })
})
