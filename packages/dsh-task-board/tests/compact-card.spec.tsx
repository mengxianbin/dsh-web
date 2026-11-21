// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { formatCardTime, TaskCard } from '../src/client/board/TaskCard.tsx'
import type { ExecutionRecord, TaskRecord } from '../src/core/tasks.ts'
import { t } from '../src/client/locales.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
})

function mount(element: Parameters<Root['render']>[0]): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(element))
  return container
}

function settled(result: ExecutionRecord['result'], overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return { id: 'e1', sessionId: 'session-1', startedAt: 1_000, endedAt: 2_000, result, error: undefined, ...overrides }
}

const titleOf = (card: Element) => card.querySelector('[data-dsh-part="card-title"]')?.textContent

const baseTask: TaskRecord = { id: 'card', title: 'Card', description: '', prompt: '', status: 'todo', createdAt: 0, updatedAt: 0, executions: [] }

describe('Given readable task cards across board views', () => {
  it.each(['backlog', 'todo', 'running', 'done', 'failed', 'archived'] as const)(
    'user sees a %s card contains Markdown, then it exposes a clean summary and opens details',
    (status) => {
      // Given a task with Markdown content in any board column.
      const source = '### Steps\n- [x] Check `output`\n\nBody `text`'
      const task: TaskRecord = {
        id: 'readable', title: '## Fix **rendering**', description: source,
        prompt: 'unchanged', status: status === 'archived' ? 'done' : status,
        createdAt: 0, updatedAt: 0, executions: [],
        ...(status === 'archived' ? { archivedAt: 1 } : {}),
      }
      let opened = 0
      // When the user sees its readable card.
      const container = mount(<TaskCard task={task} pending={false} onClick={() => { opened += 1 }} />)
      const card = container.querySelector<HTMLElement>('article[data-dsh-part="card"]')!
      const open = card.querySelector<HTMLButtonElement>('button[data-dsh-part="card-open"]')!
      // Then the summary is readable and the source remains unchanged.
      expect(open.getAttribute('aria-label')).toBe('Fix rendering')
      expect(titleOf(card)).toBe('Fix rendering')
      expect(card.title).not.toContain('##')
      expect(card.textContent).toContain('Body text')
      expect(card.dataset.status).toBe(status)
      expect(card.draggable).toBe(status !== 'archived')
      act(() => open.click())
      expect(opened).toBe(1)
      expect(task.description).toBe(source)
    },
  )
  it('user can identify a task whose title is only Markdown punctuation', () => {
    // Given a nonempty title that parses as a thematic break.
    const task: TaskRecord = { ...baseTask, id: 'rule', title: '---' }
    // When its summary is rendered.
    const container = mount(<TaskCard task={task} pending={false} onClick={() => {}} />)
    // Then the original title remains available instead of an empty card.
    expect(container.querySelector('button[data-dsh-part="card-open"]')?.getAttribute('aria-label')).toBe('---')
    expect(titleOf(container)).toBe('---')
  })
  it('user can inspect a pending card without enabling dragging', () => {
    // Given a card awaiting a Host response.
    const task: TaskRecord = { ...baseTask, id: 'pending', title: 'Pending task' }
    let opened = false
    // When the user opens the pending summary by clicking the card body.
    const container = mount(<TaskCard task={task} pending={true} onClick={() => { opened = true }} />)
    const card = container.querySelector<HTMLElement>('article[data-dsh-part="card"]')!
    act(() => card.click())
    // Then viewing remains available, but dragging remains locked.
    expect(opened).toBe(true)
    expect(card.draggable).toBe(false)
    expect(card.dataset.pending).toBe('true')
  })
})

describe('Given issue-synced cards', () => {
  it('user scanning a synced card sees the issue summary instead of the form boilerplate', () => {
    // Given an issue-form body whose first sections are identical on every card.
    const task: TaskRecord = {
      ...baseTask,
      title: '[Bug]: Price estimate doubles on holidays',
      description: '### 提交前查重\n\n- [x] 我已搜索过 open/closed 的 Issue，确认本 Issue 没有重复。\n\n### 涉及插件\n\n其他\n\n### 摘要\n\nEstimate is twice the real cost.\n\n<img src="https://example.invalid/a.png" />\n\n### 补充信息\n\n_No response_',
    }
    // When the card renders.
    const container = mount(<TaskCard task={task} pending={false} onClick={() => {}} />)
    const card = container.querySelector<HTMLElement>('article')!
    // Then the type prefix becomes a badge and the excerpt is the summary section.
    expect(card.querySelector('[data-dsh-part="card-kind"]')?.textContent).toBe('Bug')
    expect(titleOf(card)).toBe('Price estimate doubles on holidays')
    expect(card.querySelector('[data-dsh-part="card-excerpt"]')?.textContent).toBe('Estimate is twice the real cost.')
    expect(card.textContent).not.toContain('提交前查重')
  })
  it('user sees a done card whose last run failed labelled as set by hand, with a failure stripe', () => {
    // Given a card in Done whose latest execution failed (the issue closed upstream).
    const task: TaskRecord = { ...baseTask, status: 'done', executions: [settled('failed')] }
    // When the card renders.
    const container = mount(<TaskCard task={task} pending={false} onClick={() => {}} />)
    const card = container.querySelector<HTMLElement>('article')!
    const run = card.querySelector<HTMLElement>('[data-dsh-part="card-run"]')!
    // Then the stripe and the run label report the failure and the manual column.
    expect(card.dataset.tone).toBe('failed')
    expect(run.textContent).toContain(t('card.result.failed'))
    expect(run.textContent).toContain(t('card.declared'))
    expect(run.title).toBe(t('card.declaredHint'))
    expect(card.querySelector('button[data-dsh-part="card-open"]')?.getAttribute('aria-label')).toContain(t('card.declared'))
  })
  it('user sees a settled card dated by its settlement, not by the last sync', () => {
    // Given a done card whose record was touched by a sync long after the run settled.
    const endedAt = Date.UTC(2025, 0, 2, 12, 0, 0)
    const task: TaskRecord = { ...baseTask, status: 'done', updatedAt: Date.UTC(2026, 0, 2), executions: [settled('succeeded', { endedAt })] }
    // When the card renders in the UTC Host zone.
    const container = mount(<TaskCard task={task} pending={false} timeZone="UTC" onClick={() => {}} />)
    // Then the time label names the settlement date.
    expect(container.querySelector('[data-dsh-part="card-time"]')?.textContent).toBe(t('card.time.settled', { time: '2025-01-02' }))
    expect(container.querySelector<HTMLElement>('article')!.dataset.tone).toBe('succeeded')
  })
  it('user opens the latest execution session from the card without opening the detail', () => {
    // Given a card with a settled execution session.
    const task: TaskRecord = { ...baseTask, status: 'done', executions: [settled('succeeded')] }
    const sessions: string[] = []
    let opened = 0
    const container = mount(<TaskCard task={task} pending={false} onClick={() => { opened += 1 }} onOpenSession={id => { sessions.push(id) }} />)
    // When the user clicks the session quick action.
    act(() => container.querySelector<HTMLButtonElement>('[data-dsh-part="card-session"]')!.click())
    // Then the session opens and the detail stays closed.
    expect(sessions).toEqual(['session-1'])
    expect(opened).toBe(0)
  })
  it('user scanning a compact column sees one title line and the time, without excerpt or tags', () => {
    // Given a tagged card with a description in a compact column.
    const task: TaskRecord = { ...baseTask, description: 'long body', tags: [{ name: 'usage' }], executions: [settled('succeeded')] }
    // When it renders compact.
    const container = mount(<TaskCard task={task} pending={false} compact onClick={() => {}} />)
    const card = container.querySelector<HTMLElement>('article')!
    // Then only the title row and the meta row remain, and the tone still shows.
    expect(card.dataset.compact).toBe('true')
    expect(card.querySelector('[data-dsh-part="card-excerpt"]')).toBeNull()
    expect(card.querySelector('[data-dsh-part="tag-badge"]')).toBeNull()
    expect(card.dataset.tone).toBe('succeeded')
  })
})

describe('Given card time labels', () => {
  it('user reading a day-old card sees the calendar date in the Host time zone', () => {
    // Given an instant that is still the 2nd in UTC but already the 3rd in Shanghai.
    const at = Date.UTC(2026, 0, 2, 20, 0, 0)
    const now = at + 3 * 24 * 60 * 60 * 1000
    // When the card formats it for each Host zone.
    const shanghai = formatCardTime(at, 'Asia/Shanghai', now)
    const utc = formatCardTime(at, 'UTC', now)
    // Then the date follows the Host zone rather than the browser.
    expect(shanghai).toBe('2026-01-03')
    expect(utc).toBe('2026-01-02')
  })
})

describe('Given a card whose state changes', () => {
  const openRun: ExecutionRecord = { id: 'e-open', sessionId: 'session-1', startedAt: 3_000, endedAt: undefined, result: undefined, error: undefined }

  /** Mount one card, read what the test needs, and unmount before the next state. */
  function readCard<T>(element: Parameters<Root['render']>[0], read: (card: HTMLElement) => T): T {
    const container = document.createElement('div')
    document.body.append(container)
    const local = createRoot(container)
    act(() => local.render(element))
    const card = container.querySelector<HTMLElement>('article[data-dsh-part="card"]')!
    const value = read(card)
    act(() => local.unmount())
    container.remove()
    return value
  }

  /** The card in every state the board can show it. */
  const states: Array<{ name: string; task: TaskRecord; pending?: boolean }> = [
    { name: 'idle', task: { ...baseTask, id: 'idle' } },
    { name: 'running', task: { ...baseTask, id: 'running', status: 'running', executions: [openRun] } },
    { name: 'succeeded', task: { ...baseTask, id: 'succeeded', status: 'done', executions: [settled('succeeded')] } },
    { name: 'declared', task: { ...baseTask, id: 'declared', status: 'done', executions: [settled('failed')] } },
    { name: 'archived', task: { ...baseTask, id: 'archived', status: 'done', archivedAt: 9, executions: [settled('succeeded')] } },
    { name: 'pending', task: { ...baseTask, id: 'waiting' }, pending: true },
  ]

  it('user watching a card start, settle or archive sees the same rows, so the card never grows or shrinks', () => {
    // Given a card rendered in every state the board can show
    const rows = states.map(state => readCard(
      <TaskCard task={state.task} pending={state.pending ?? false} onClick={() => {}} />,
      card => [...card.children].map(node => node.tagName).join(','),
    ))

    // When each state paints
    // Then the same rows exist in all of them: the title row, the meta row and
    // the status rail are reserved whether or not they carry a label, a
    // spinner or a result badge
    expect(rows).toHaveLength(states.length)
    expect(new Set(rows)).toEqual(new Set(['BUTTON,SPAN,SPAN,SPAN']))
  })

  it('user sees the status rail keep its two zones while a card idles, runs or archives', () => {
    // Given the same six cards
    const rails = states.map(state => readCard(
      <TaskCard task={state.task} pending={state.pending ?? false} onClick={() => {}} />,
      card => {
        const rail = card.lastElementChild!
        return rail.tagName + ':' + String(rail.children.length)
      },
    ))

    // When a state paints a label, a result or nothing
    // Then the rail's leading and trailing zones both stay in place
    expect(new Set(rails)).toEqual(new Set(['SPAN:2']))
  })

  it('user sees the spinner box in place before a run starts, and only its content change while one runs', () => {
    // Given an idle card, a running card and a settled card
    const trailOf = (task: TaskRecord, pending: boolean) => readCard(
      <TaskCard task={task} pending={pending} onClick={() => {}} />,
      card => {
        const trail = card.lastElementChild!.lastElementChild!
        return { trail: trail.children.length, slot: trail.firstElementChild!.children.length }
      },
    )

    // When the run opens and later settles
    // Then the trailing zone keeps the same reserved slot and only the slot's
    // content is painted into it
    expect(trailOf({ ...baseTask, id: 'idle' }, false)).toEqual({ trail: 1, slot: 0 })
    expect(trailOf({ ...baseTask, id: 'run', status: 'running', executions: [openRun] }, false)).toEqual({ trail: 2, slot: 1 })
    expect(trailOf({ ...baseTask, id: 'settled', status: 'done', executions: [settled('succeeded')] }, false)).toEqual({ trail: 2, slot: 0 })
  })

  it('user scanning a compact column sees the same two rows in every state', () => {
    // Given the same six cards in a compact column
    const rows = states.map(state => readCard(
      <TaskCard task={state.task} pending={state.pending ?? false} compact onClick={() => {}} />,
      card => [...card.children].map(node => node.tagName).join(','),
    ))

    // When each state paints
    // Then compact density is the same two rows with the spinner box reserved
    expect(new Set(rows)).toEqual(new Set(['BUTTON,SPAN,SPAN']))
  })

  it('user seeing a task with no labels gets no empty label row', () => {
    // Given a task whose label list is present but empty
    const task: TaskRecord = { ...baseTask, tags: [] }
    // When the card renders
    const container = mount(<TaskCard task={task} pending={false} onClick={() => {}} />)
    // Then no label badge is emitted and the card keeps its three rows
    expect(container.querySelector('[data-dsh-part="tag-badge"]')).toBeNull()
    expect(container.querySelectorAll('article[data-dsh-part="card"] > span')).toHaveLength(3)
  })

  it('user reading a settled card sees the outcome in a filled badge of its own', () => {
    // Given a done card whose last run succeeded
    const container = mount(<TaskCard task={{ ...baseTask, status: 'done', executions: [settled('succeeded')] }} pending={false} onClick={() => {}} />)
    const run = container.querySelector<HTMLElement>('[data-dsh-part="card-run"]')!

    // When the card reports the outcome
    // Then the badge names the outcome and the run line still carries the count
    expect(run.getAttribute('data-result')).toBe('succeeded')
    const badge = run.firstElementChild!
    expect(badge.getAttribute('data-result')).toBe('succeeded')
    expect(badge.textContent).toBe(t('card.result.succeeded'))
    expect(run.textContent).toContain(t('board.runs'))
  })

  it('user reading an archived card sees the outcome as plain text, not as a board verdict badge', () => {
    // Given an archived card whose last run succeeded
    const container = mount(<TaskCard task={{ ...baseTask, status: 'done', archivedAt: 9, executions: [settled('succeeded')] }} pending={false} onClick={() => {}} />)
    const run = container.querySelector<HTMLElement>('[data-dsh-part="card-run"]')!

    // When the archive renders it
    // Then the outcome stays text, so no board column tone is painted on it
    expect(run.getAttribute('data-result')).toBeNull()
    expect(run.children).toHaveLength(1)
    expect(run.textContent).toContain(t('card.result.succeeded'))
  })
})
