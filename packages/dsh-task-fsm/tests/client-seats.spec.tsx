// @vitest-environment jsdom
/**
 * Browser-half specs: the two row seats register under this package's own
 * occupant ids, the freeze mark renders ❄️/🔒 with the reason as its title,
 * and the hover lines render the queue tier + four-piece only when a record
 * exists (quiet absence otherwise).
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { FsmHoverLines } from '../src/client/FsmHoverLines.tsx'
import { FsmFreezeMark } from '../src/client/FsmFreezeMark.tsx'
import { resetFsmLookup } from '../src/client/api.ts'

const fetchMock = vi.fn()

function jsonOk(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

function frozenView() {
  return {
    ok: true,
    found: true,
    view: {
      taskRef: 'content/tech/ai/dsh/tasks.md#demo',
      state: 'deferred',
      queue: { tier: 'yellow', reason: 'prereq-unruled', label: '黄', example: '缺前置未裁' },
      session: { id: 'session-1', mode: 'frozen', reason: '等前置：#hibernate-wake-1122 未终态' },
      subreasons: { what: '等前置：前置任务未终态/未裁定', why: '黄档：缺前置未裁', who: '人', next: '前置终态到达即解冻续跑' },
      pendingAck: false,
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  resetFsmLookup()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('seat registration (apply)', () => {
  it('seats both row occupants under this package’s ids', () => {
    const registrations: { name: string; id?: string }[] = []
    const ctx = {
      effect: (fn: () => unknown) => { fn(); return () => {} },
      locale: {
        register: () => () => {},
        bind: () => (key: string) => key,
      },
      slots: {
        inject: (name: string, factory: () => unknown) => {
          factory()
          registrations.push({ name })
          return () => {}
        },
        register: (options: { name: string; id?: string }) => {
          registrations.push({ name: options.name, id: options.id })
          return () => {}
        },
      },
    }
    apply(ctx as never)
    const names = registrations.map((r) => r.name)
    expect(names).toContain('sidebar.session.row.leading')
    expect(names).toContain('sidebar.session.row.hover')
    expect(registrations.some((r) => r.id === 'task-fsm-freeze-mark')).toBe(true)
    expect(registrations.some((r) => r.id === 'task-fsm-hover-lines')).toBe(true)
  })
})

describe('FsmFreezeMark', () => {
  it('renders ❄️ with the freeze reason as title (hover 显示冻结原因)', async () => {
    fetchMock.mockResolvedValue(jsonOk(frozenView()))
    render(<FsmFreezeMark sessionId="session-1" />)
    await flush()
    const mark = screen.getByRole('img')
    expect(mark.textContent).toBe('❄️')
    expect(mark.getAttribute('title')).toContain('等前置：#hibernate-wake-1122 未终态')
  })

  it('renders 🔒 for a locked session', async () => {
    const body = frozenView()
    body.view.session = { id: 'session-1', mode: 'locked', reason: '长等待锁定' }
    fetchMock.mockResolvedValue(jsonOk(body))
    render(<FsmFreezeMark sessionId="session-1" />)
    await flush()
    expect(screen.getByRole('img').textContent).toBe('🔒')
  })

  it('renders nothing without an FSM record (quiet absence)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: false, found: false }) } as Response)
    const { container } = render(<FsmFreezeMark sessionId="session-x" />)
    await flush()
    expect(container.textContent).toBe('')
  })
})

describe('FsmHoverLines', () => {
  it('renders the yellow tier + freeze reason + the four-piece', async () => {
    fetchMock.mockResolvedValue(jsonOk(frozenView()))
    render(<FsmHoverLines sessionId="session-1" />)
    await flush()
    expect(screen.getByText('队列黄档')).toBeDefined()
    expect(screen.getByText(/冻结原因/)).toBeDefined()
    for (const label of ['等什么', '为什么', '谁', '下一步']) {
      expect(screen.getByText(label), label).toBeDefined()
    }
    expect(screen.getByText('等前置：前置任务未终态/未裁定')).toBeDefined()
  })

  it('renders nothing for a plain active task (no tier, not frozen)', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      ok: true,
      found: true,
      view: {
        taskRef: 't', state: 'active',
        queue: { tier: 'none', reason: 'idle', label: '不入', example: '进行中' },
        subreasons: { what: 'a', why: 'b', who: 'worker', next: 'c' },
        pendingAck: false,
      },
    }))
    const { container } = render(<FsmHoverLines sessionId="session-2" />)
    await flush()
    expect(container.textContent).toBe('')
  })

  it('renders nothing when the endpoint is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    const { container } = render(<FsmHoverLines sessionId="session-3" />)
    await flush()
    expect(container.textContent).toBe('')
  })
})
