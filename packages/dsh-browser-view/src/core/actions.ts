/**
 * The five things an agent does to a page: navigate, click, type, press a key,
 * and scroll.
 *
 * Two rules shape every action here.
 *
 * Coordinates, not synthetic events. `element.click()` from a script skips
 * focus, hover, and the trusted-event path, so a page that checks
 * `isTrusted` or listens on a parent behaves differently from a real click.
 * Every element-level action therefore resolves a box and dispatches real
 * input events at its centre.
 *
 * Every action refreshes the frame. The screencast only emits when the
 * compositor sees a change, so a scroll back to the same place, a click that
 * opens nothing, or a key that is swallowed would leave the panel showing the
 * pre-action state. Each action ends with an explicit capture, which is also
 * what makes "the panel shows what just happened" true for every action
 * instead of only the visual ones.
 *
 * Each action also returns one readable trace line: it is the only thing the
 * panel puts in front of the user, and the model gets it back as the action's
 * own summary.
 *
 * @module @linxin666/dsh-client-ui-browser-view/core/actions
 */

import type { CdpTransport } from './cdp.ts'
import type { TabManager } from './tabs.ts'

/** The collaborators one action needs. */
export interface ActionScope {
  /** Protocol transport shared with the tab manager. */
  transport: CdpTransport
  /** Tab bookkeeping, ref resolution, and frame refresh. */
  tabs: TabManager
}

/** What one action reports back. */
export interface ActionOutcome {
  /** Tab that changed. */
  tabId: string
  /** One-line human description, also used as the panel trace. */
  summary: string
}

/** Which element a click or a type targets. Exactly one form is used. */
export interface ElementTarget {
  /** Depth-first ref from the last `browser_snapshot`. */
  ref?: number
  /** CSS selector, for a caller that already knows the page. */
  selector?: string
  /** Viewport x coordinate, when the caller measured the element itself. */
  x?: number
  /** Viewport y coordinate. */
  y?: number
}

/** What resolving an element found. */
interface ElementProbe {
  ok: boolean
  x?: number
  y?: number
  tag?: string
  name?: string
  reason?: string
}

/** Dispatch one expression in the page and return its plain-JSON value. */
async function evaluateJson(
  transport: CdpTransport,
  sessionId: string,
  expression: string,
): Promise<unknown> {
  const result = await transport.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (result.exceptionDetails !== undefined) {
    throw new Error(`the page rejected the script: ${result.exceptionDetails.text ?? 'unknown error'}`)
  }
  return result.result?.value
}

/**
 * Scroll the element into view and report its centre point.
 * @param transport - the tab's protocol transport.
 * @param sessionId - flat session of the tab.
 * @param selector - CSS selector resolved by the caller.
 * @returns the probe outcome.
 */
async function probeElement(transport: CdpTransport, sessionId: string, selector: string): Promise<ElementProbe> {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return { ok: false, reason: 'no element matches the selector' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().slice(0, 60);
    return {
      ok: rect.width > 0 && rect.height > 0,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      tag: el.tagName.toLowerCase(),
      name: label,
      reason: rect.width > 0 && rect.height > 0 ? undefined : 'the element has no visible box',
    };
  })()`
  const raw = await evaluateJson(transport, sessionId, expression)
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'the page could not describe the element' }
  return raw as ElementProbe
}

/** Render `tag "name"` for a trace line, or just the tag. */
function describeProbe(probe: ElementProbe): string {
  const tag = probe.tag ?? 'element'
  const name = probe.name ?? ''
  return name === '' ? tag : `${tag} "${name}"`
}

/**
 * Resolve one element target to a viewport point.
 * @param scope - transport and tab manager.
 * @param tabId - target tab.
 * @param target - ref, selector, or explicit coordinates.
 * @returns the point plus the description used in the trace.
 */
async function resolvePoint(
  scope: ActionScope,
  tabId: string,
  target: ElementTarget,
): Promise<{ x: number; y: number; description: string }> {
  if (target.ref !== undefined) {
    const selector = scope.tabs.selectorForRef(tabId, target.ref)
    const probe = await probeElement(scope.transport, scope.tabs.sessionOf(tabId), selector)
    if (probe.ok !== true || probe.x === undefined || probe.y === undefined) {
      throw new Error(`ref ${target.ref} no longer resolves in the page (${probe.reason ?? 'unknown reason'}); call browser_snapshot again`)
    }
    return { x: probe.x, y: probe.y, description: `ref ${target.ref} (${describeProbe(probe)})` }
  }
  if (target.selector !== undefined && target.selector !== '') {
    const probe = await probeElement(scope.transport, scope.tabs.sessionOf(tabId), target.selector)
    if (probe.ok !== true || probe.x === undefined || probe.y === undefined) {
      throw new Error(`selector "${target.selector}" did not resolve (${probe.reason ?? 'unknown reason'})`)
    }
    return { x: probe.x, y: probe.y, description: `${target.selector} (${describeProbe(probe)})` }
  }
  if (target.x !== undefined && target.y !== undefined) {
    return { x: target.x, y: target.y, description: `viewport ${target.x},${target.y}` }
  }
  throw new Error('click needs one of: ref (from browser_snapshot), selector, or both x and y')
}

/** Dispatch one trusted click at a viewport point. */
async function clickAt(transport: CdpTransport, sessionId: string, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }
  await transport.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, sessionId)
  await transport.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId)
  await transport.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, sessionId)
}

/**
 * Navigate the tab and refresh the panel frame.
 * @param scope - transport and tab manager.
 * @param tabId - target tab.
 * @param url - absolute, `data:`, or `about:` url.
 * @returns the action outcome.
 */
export async function navigateTo(scope: ActionScope, tabId: string, url: string): Promise<ActionOutcome> {
  const tab = await scope.tabs.navigate(tabId, url)
  await scope.tabs.refreshFrame(tabId)
  return { tabId, summary: `Navigated to ${tab.url === '' ? url : tab.url}` }
}

/**
 * Click an element or a coordinate.
 * @param scope - transport and tab manager.
 * @param tabId - target tab.
 * @param target - ref, selector, or coordinates.
 * @returns the action outcome.
 */
export async function clickElement(scope: ActionScope, tabId: string, target: ElementTarget): Promise<ActionOutcome> {
  const point = await resolvePoint(scope, tabId, target)
  await clickAt(scope.transport, scope.tabs.sessionOf(tabId), point.x, point.y)
  await scope.tabs.refreshFrame(tabId)
  return { tabId, summary: `Clicked ${point.description}` }
}

/**
 * Type text into the focused element, or into one element first.
 * @param scope - transport and tab manager.
 * @param tabId - target tab.
 * @param text - text to insert.
 * @param target - optional element to focus before typing.
 * @returns the action outcome.
 */
export async function typeText(
  scope: ActionScope,
  tabId: string,
  text: string,
  target: ElementTarget = {},
): Promise<ActionOutcome> {
  const sessionId = scope.tabs.sessionOf(tabId)
  let where = 'the focused element'
  if (target.ref !== undefined || (target.selector !== undefined && target.selector !== '')) {
    const point = await resolvePoint(scope, tabId, target)
    await clickAt(scope.transport, sessionId, point.x, point.y)
    where = point.description
  }
  await scope.transport.send('Input.insertText', { text }, sessionId)
  await scope.tabs.refreshFrame(tabId)
  const count = [...text].length
  return { tabId, summary: `Typed ${count} character${count === 1 ? '' : 's'} into ${where}` }
}

/** One key definition for `Input.dispatchKeyEvent`. */
interface KeyDefinition {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
}

/** Keys worth naming; anything else is typed as a literal character. */
const KEYS: Readonly<Record<string, KeyDefinition>> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
}

/**
 * Resolve a key name to its dispatch definition.
 * @param key - `Enter`, `Tab`, ... or a single character.
 * @returns the definition.
 */
export function keyDefinition(key: string): KeyDefinition {
  const named = KEYS[key]
  if (named !== undefined) return named
  if ([...key].length === 1) {
    // A bare character needs no virtual key code path: the `char` event with
    // `text` is what a real keystroke produces for a printable character.
    return { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key }
  }
  throw new Error(`unsupported key "${key}"; use a single character or one of ${Object.keys(KEYS).join(', ')}`)
}

/**
 * Press one key on whatever has focus.
 * @param scope - transport and tab manager.
 * @param tabId - target tab.
 * @param key - key name or single character.
 * @returns the action outcome.
 */
export async function pressKey(scope: ActionScope, tabId: string, key: string): Promise<ActionOutcome> {
  const definition = keyDefinition(key)
  const sessionId = scope.tabs.sessionOf(tabId)
  await scope.transport.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
    ...definition.text === undefined ? {} : { text: definition.text },
  }, sessionId)
  if (definition.text !== undefined) {
    await scope.transport.send('Input.dispatchKeyEvent', {
      type: 'char',
      key: definition.key,
      code: definition.code,
      text: definition.text,
      unmodifiedText: definition.text,
    }, sessionId)
  }
  await scope.transport.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
  }, sessionId)
  await scope.tabs.refreshFrame(tabId)
  return { tabId, summary: `Pressed ${key}` }
}

/**
 * Scroll the page with a synthetic wheel event at a viewport point.
 * @param scope - transport and tab manager.
 * @param tabId - target tab.
 * @param delta - horizontal and vertical scroll distance in CSS pixels.
 * @returns the action outcome.
 */
export async function scrollBy(
  scope: ActionScope,
  tabId: string,
  delta: { deltaX?: number; deltaY?: number; x?: number; y?: number },
): Promise<ActionOutcome> {
  const deltaX = Math.round(delta.deltaX ?? 0)
  const deltaY = Math.round(delta.deltaY ?? 0)
  if (deltaX === 0 && deltaY === 0) {
    throw new Error('scroll needs a non-zero deltaY (or deltaX)')
  }
  const x = Math.round(delta.x ?? 640)
  const y = Math.round(delta.y ?? 400)
  await scope.transport.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX,
    deltaY,
  }, scope.tabs.sessionOf(tabId))
  await scope.tabs.refreshFrame(tabId)
  const directions: string[] = []
  if (deltaY !== 0) directions.push(`${deltaY > 0 ? 'down' : 'up'} ${Math.abs(deltaY)} px`)
  if (deltaX !== 0) directions.push(`${deltaX > 0 ? 'right' : 'left'} ${Math.abs(deltaX)} px`)
  return { tabId, summary: `Scrolled ${directions.join(' and ')}` }
}
