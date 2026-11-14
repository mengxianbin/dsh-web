/**
 * DOM snapshot for the agent: one depth-first walk of the document, rendered as
 * a flat node list whose array index IS the node's `ref`.
 *
 * Why a flat list with an ordinal ref: the model cannot hold a live node
 * handle, so the only thing that survives a round trip is a number. Depth-first
 * order makes the list readable as an outline (indentation is `depth`), and it
 * is reproducible for the same document, so the same page yields the same refs.
 *
 * Reuse: the walk also returns the CSS selector it computed for every node, and
 * {@link TabManager} keeps that map alongside the last snapshot. `browser_click`
 * resolves a ref through that map, which is why a ref is only valid against the
 * observation it came from — after a re-render the selector may match nothing or
 * a different node, and the tool says so instead of clicking blindly.
 *
 * The walk runs inside the page (one `Runtime.evaluate`), not over the DOM
 * protocol: `DOM.getDocument` returns the whole tree in one message regardless
 * of the limit this module promises, and a 200k-node document would be shipped
 * across the socket before any host-side cap could apply.
 *
 * @module @linxin666/dsh-client-ui-browser-view/core/snapshot
 */

import type { CdpTransport } from './cdp.ts'
import { SNAPSHOT_NODE_LIMIT, type BrowserSnapshot, type BrowserSnapshotNode } from './protocol.ts'

/** One node as the in-page walk reports it, before the host assigns a ref. */
export interface RawSnapshotNode {
  /** Lowercase tag name. */
  tag: string
  /** Element id, when set. */
  id?: string
  /** Element class list, when non-empty. */
  classes?: string[]
  /** Explicit or implicit accessible role. */
  role?: string
  /** Accessible name, when one could be derived. */
  name?: string
  /** Visible text for leaf nodes, already truncated in the page. */
  text?: string
  /** Bounding box in CSS pixels, window-relative. */
  box?: { x: number; y: number; width: number; height: number }
  /** Depth in the walked tree. */
  depth: number
  /** CSS selector that resolves back to this element. */
  selector: string
}

/** What the in-page walk returns. */
export interface RawSnapshotPayload {
  /** Document url at walk time. */
  url?: string
  /** Document title at walk time. */
  title?: string
  /** Depth-first nodes, already cut at the limit. */
  nodes?: RawSnapshotNode[]
  /** Whether the walk stopped at the limit. */
  truncated?: boolean
}

/** One assembled snapshot plus the ref map the click tool reuses. */
export interface SnapshotResult {
  /** The value `browser_snapshot` returns. */
  snapshot: BrowserSnapshot
  /** Depth-first ref to CSS selector, valid only for this observation. */
  refs: Map<number, string>
}

/**
 * Build the `BrowserSnapshot` from raw page nodes.
 *
 * Refs are the array index, so the caller must pass nodes in depth-first order
 * (the walk guarantees it) and must not re-sort them.
 * @param input - tab identity, raw nodes, and the node limit.
 * @returns the snapshot plus its ref map.
 */
export function assembleSnapshot(input: {
  tabId: string
  url: string
  title: string
  raw: readonly RawSnapshotNode[]
  limit?: number
}): SnapshotResult {
  const limit = input.limit ?? SNAPSHOT_NODE_LIMIT
  const refs = new Map<number, string>()
  const nodes: BrowserSnapshotNode[] = []
  let truncated = input.raw.length > limit
  for (const raw of input.raw) {
    if (nodes.length >= limit) {
      truncated = true
      break
    }
    const ref = nodes.length
    const node: BrowserSnapshotNode = { ref, tag: raw.tag, depth: raw.depth }
    if (raw.id !== undefined && raw.id !== '') node.id = raw.id
    if (raw.classes !== undefined && raw.classes.length > 0) node.classes = [...raw.classes]
    if (raw.role !== undefined && raw.role !== '') node.role = raw.role
    if (raw.name !== undefined && raw.name !== '') node.name = raw.name
    if (raw.text !== undefined && raw.text !== '') node.text = raw.text
    if (raw.box !== undefined) node.box = { ...raw.box }
    nodes.push(node)
    refs.set(ref, raw.selector)
  }
  return {
    snapshot: {
      tabId: input.tabId,
      url: input.url,
      title: input.title,
      nodes,
      truncated,
    },
    refs,
  }
}

/**
 * Build the in-page walk expression.
 *
 * The limit is baked in as a literal because `Runtime.evaluate` has no
 * argument channel for a non-expression value; it is a number this module
 * controls, never user input.
 * @param limit - maximum nodes the walk may report.
 * @returns a self-invoking expression returning {@link RawSnapshotPayload}.
 */
export function buildSnapshotExpression(limit: number = SNAPSHOT_NODE_LIMIT): string {
  return `(() => {
  const LIMIT = ${Math.max(1, Math.floor(limit))};
  const SKIP = { script: 1, style: 1, noscript: 1, template: 1, meta: 1, link: 1, title: 1, base: 1 };
  const ROLES = {
    a: 'link', button: 'button', img: 'img', input: 'textbox', textarea: 'textbox',
    select: 'combobox', option: 'option', nav: 'navigation', main: 'main', header: 'banner',
    footer: 'contentinfo', aside: 'complementary', section: 'region', form: 'form',
    ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', td: 'cell',
    th: 'columnheader', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
    h5: 'heading', h6: 'heading', p: 'paragraph', label: 'label', dialog: 'dialog',
  };
  const nodes = [];
  let truncated = false;
  const clip = (value, max) => {
    const text = String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '...' : text;
  };
  const selectorOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) {
        parts.unshift(node.tagName.toLowerCase() + '#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const nameOf = (el, tag) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return clip(aria, 80);
    if (tag === 'img' && el.getAttribute('alt')) return clip(el.getAttribute('alt'), 80);
    if (el.getAttribute && el.getAttribute('title')) return clip(el.getAttribute('title'), 80);
    if (el.labels && el.labels.length > 0) return clip(el.labels[0].textContent, 80);
    if (el.children.length === 0) return clip(el.textContent, 80);
    return undefined;
  };
  const walk = (el, depth) => {
    if (nodes.length >= LIMIT) { truncated = true; return; }
    const tag = el.tagName.toLowerCase();
    if (SKIP[tag]) return;
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    if (visible) {
      const node = { tag: tag, depth: depth, selector: selectorOf(el) };
      if (el.id) node.id = el.id;
      const classes = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 8);
      if (classes.length > 0) node.classes = classes;
      const role = (el.getAttribute('role') || ROLES[tag] || '').trim();
      if (role) node.role = role;
      const name = nameOf(el, tag);
      if (name) node.name = name;
      if (el.children.length === 0) {
        const text = clip(el.textContent, 160);
        if (text) node.text = text;
      }
      node.box = {
        x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      };
      nodes.push(node);
    }
    if (nodes.length >= LIMIT) { truncated = true; return; }
    for (let index = 0; index < el.children.length; index += 1) walk(el.children[index], depth + 1);
  };
  const root = document.body || document.documentElement;
  if (root) walk(root, 0);
  return { url: location.href, title: document.title, nodes: nodes, truncated: truncated };
})()`
}

/**
 * Walk the tab's document and assemble the snapshot.
 * @param transport - the tab's protocol transport.
 * @param tabId - target tab id.
 * @param sessionId - flat session of the tab.
 * @param options - limit and a title/url fallback.
 * @returns the snapshot plus its ref map.
 */
export async function buildSnapshot(
  transport: CdpTransport,
  tabId: string,
  sessionId: string,
  options: { limit?: number; url?: string; title?: string } = {},
): Promise<SnapshotResult> {
  const limit = options.limit ?? SNAPSHOT_NODE_LIMIT
  const result = await transport.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: buildSnapshotExpression(limit),
    returnByValue: true,
  }, sessionId)
  const value = result.result?.value
  if (typeof value !== 'object' || value === null) {
    throw new Error('the page did not return a readable DOM snapshot')
  }
  const payload = value as RawSnapshotPayload
  const raw = Array.isArray(payload.nodes) ? payload.nodes : []
  const assembled = assembleSnapshot({
    tabId,
    url: typeof payload.url === 'string' ? payload.url : options.url ?? '',
    title: typeof payload.title === 'string' ? payload.title : options.title ?? '',
    raw,
    limit,
  })
  if (payload.truncated === true) assembled.snapshot.truncated = true
  return assembled
}
