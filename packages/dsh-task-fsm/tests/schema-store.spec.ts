/**
 * Schema parse specs (§2.6 shape + semantic key/state/event checks) and the
 * store round-trip (atomic save, absent file → empty, corrupt → throw).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyFsmFile, parseFsmFile, type FsmFile } from '../src/core/schema.ts'
import { FsmStore, defaultFsmPath } from '../src/host/store.ts'

function sample(): FsmFile {
  const file = emptyFsmFile()
  file.scopes['content/tech/ai/dsh'] = { intent: '施工', prio: 'yellow', declaredAt: '2026-11-23T12:00:00.000Z' }
  file.tasks['content/tech/ai/dsh/tasks.md#demo'] = {
    version: 1,
    taskRef: 'content/tech/ai/dsh/tasks.md#demo',
    scope: 'content/tech/ai/dsh',
    state: 'active',
    queue: 'none',
    attempts: { redisp: 0, autofix: 0 },
    history: [{ event: 'E1', from: 'backlog', to: 'active', at: '2026-11-23T12:00:00.000Z' }],
  }
  return file
}

describe('parseFsmFile', () => {
  it('accepts a well-formed file (round-trips the sample)', () => {
    const parsed = parseFsmFile(JSON.parse(JSON.stringify(sample())))
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.tasks)).toEqual(['content/tech/ai/dsh/tasks.md#demo'])
    expect(parsed.scopes['content/tech/ai/dsh'].prio).toBe('yellow')
  })

  it('accepts an empty document', () => {
    expect(parseFsmFile({ version: 1, scopes: {}, tasks: {} })).toEqual(emptyFsmFile())
  })

  it('rejects an unknown state', () => {
    const bad = sample()
    // @ts-expect-error deliberately invalid enum value
    bad.tasks['content/tech/ai/dsh/tasks.md#demo'].state = 'running'
    expect(() => parseFsmFile(bad)).toThrow(/unknown state/)
  })

  it('rejects a key/record taskRef mismatch', () => {
    const bad = sample()
    bad.tasks['content/tech/ai/dsh/tasks.md#demo'].taskRef = 'content/tech/ai/dsh/tasks.md#other'
    expect(() => parseFsmFile(bad)).toThrow(/key\/record mismatch/)
  })

  it('rejects an unknown history event', () => {
    const bad = sample()
    bad.tasks['content/tech/ai/dsh/tasks.md#demo'].history.push(
      // @ts-expect-error deliberately invalid event id
      { event: 'E99', from: 'active', to: 'active', at: '2026-11-23T12:00:00.000Z' },
    )
    expect(() => parseFsmFile(bad)).toThrow(/unknown event/)
  })

  it('accepts the session-attach pseudo-event (event-axis-attach-1127 whitelist)', () => {
    const ok = sample()
    ok.tasks['content/tech/ai/dsh/tasks.md#demo'].history.push(
      { event: 'session-attach', from: 'active', to: 'active', at: '2026-11-27T12:00:00.000Z' },
    )
    const parsed = parseFsmFile(JSON.parse(JSON.stringify(ok)))
    expect(parsed.tasks['content/tech/ai/dsh/tasks.md#demo'].history.at(-1)).toMatchObject({
      event: 'session-attach', from: 'active', to: 'active',
    })
  })

  it('closed set holds after the whitelist grew: near-miss event names still reject the whole ledger', () => {
    // 红态回归（防扩集合变松）：白名单 +session-attach 不影响 fail-closed——
    // 任何白名单外名字（含形近变体）仍整账拒。
    for (const invented of ['session-attach-2', 'session_attach', 'attach', 'E22']) {
      const bad = sample()
      bad.tasks['content/tech/ai/dsh/tasks.md#demo'].history.push(
        // @ts-expect-error deliberately invalid event id
        { event: invented, from: 'active', to: 'active', at: '2026-11-27T12:00:00.000Z' },
      )
      expect(() => parseFsmFile(bad), `event=${invented}`).toThrow(/unknown event/)
    }
  })

  it('rejects a non-object document', () => {
    expect(() => parseFsmFile('nope')).toThrow()
    expect(() => parseFsmFile(null)).toThrow()
  })
})

describe('FsmStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function freshStore(): FsmStore {
    const dir = mkdtempSync(join(tmpdir(), 'task-fsm-'))
    dirs.push(dir)
    return new FsmStore(join(dir, 'task-fsm-state.json'))
  }

  it('defaultFsmPath lands flat under the DSH home with the task- prefix', () => {
    expect(defaultFsmPath('C:\\Users\\x\\.dsh')).toBe(join('C:\\Users\\x\\.dsh', 'task-fsm-state.json'))
  })

  it('absent file loads as an empty document', () => {
    expect(freshStore().load()).toEqual(emptyFsmFile())
  })

  it('save → load round-trips (atomic rename path)', () => {
    const store = freshStore()
    store.save(sample())
    const back = store.load()
    expect(back.tasks['content/tech/ai/dsh/tasks.md#demo'].state).toBe('active')
  })

  it('update mutates and persists in one step', () => {
    const store = freshStore()
    const state = store.update((file) => {
      file.scopes.s = { intent: 'i', prio: 'red', declaredAt: '2026-11-23T12:00:00.000Z' }
      return Object.keys(file.scopes).length
    })
    expect(state).toBe(1)
    expect(Object.keys(store.load().scopes)).toEqual(['s'])
  })

  it('corrupt JSON throws instead of silently resetting the authority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-fsm-'))
    dirs.push(dir)
    const path = join(dir, 'task-fsm-state.json')
    writeFileSync(path, '{ not json', 'utf8')
    expect(() => new FsmStore(path).load()).toThrow(/invalid JSON/)
  })

  it('structurally invalid content throws (never silently rebuilt)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-fsm-'))
    dirs.push(dir)
    const path = join(dir, 'task-fsm-state.json')
    writeFileSync(path, JSON.stringify({ version: 1, tasks: { a: { version: 1, taskRef: 'b', state: 'active', queue: 'none', attempts: { redisp: 0, autofix: 0 }, history: [] } } }), 'utf8')
    expect(() => new FsmStore(path).load()).toThrow(/mismatch/)
  })
})
