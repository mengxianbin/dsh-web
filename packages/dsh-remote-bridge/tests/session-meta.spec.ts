import { describe, expect, it } from 'vitest'
import { SessionMeta, TITLE_CACHE_LIMIT, TITLE_CACHE_TTL_MS, type LiveSessionFace } from '../src/core/session-meta.ts'
import { titlesDouble } from './support/harness.ts'

describe('process-local session metadata', () => {
  it('operator asking for one title twice inside the cache window reads the title service once', () => {
    // Given a host whose live session is titled
    const titles = titlesDouble({ 's-1': 'Plan the trip' })
    const meta = new SessionMeta(() => titles.faces, () => 1_000, () => {})
    // When the operator asks for that title twice
    const first = meta.title('s-1')
    const second = meta.title('s-1')
    // Then both answers carry the title and the service was read once
    expect([first, second]).toEqual(['Plan the trip', 'Plan the trip'])
    expect(titles.reads).toEqual(['s-1'])
  })

  it('operator asking again after the cache window sees the renamed title', () => {
    // Given a cached title and a clock the test drives
    const table = { 's-1': 'First name' }
    const titles = titlesDouble(table)
    let now = 1_000
    const meta = new SessionMeta(() => titles.faces, () => now, () => {})
    expect(meta.title('s-1')).toBe('First name')
    // When the session is renamed and the cache window has passed
    table['s-1'] = 'Renamed'
    expect(meta.title('s-1')).toBe('First name')
    now += TITLE_CACHE_TTL_MS
    // Then the stale entry expires and the new title is read
    expect(meta.title('s-1')).toBe('Renamed')
    expect(titles.reads).toEqual(['s-1', 's-1'])
  })

  it('operator reading the cache-only title never reaches the title service', () => {
    // Given a host that has resolved nothing yet
    const titles = titlesDouble({ 's-1': 'Plan the trip' })
    const meta = new SessionMeta(() => titles.faces, () => 1_000, () => {})
    // When the operator peeks and then resolves
    const cold = meta.cachedTitle('s-1')
    const resolved = meta.title('s-1')
    const warm = meta.cachedTitle('s-1')
    // Then the peek answers nothing until a lookup has happened, and the lookup is the only read
    expect(cold).toBeUndefined()
    expect(resolved).toBe('Plan the trip')
    expect(warm).toBe('Plan the trip')
    expect(titles.reads).toEqual(['s-1'])
  })

  it('operator peeking at a title whose cache window has passed gets nothing', () => {
    // Given a resolved title on a clock the test drives
    const titles = titlesDouble({ 's-1': 'Plan the trip' })
    let now = 1_000
    const meta = new SessionMeta(() => titles.faces, () => now, () => {})
    expect(meta.title('s-1')).toBe('Plan the trip')
    // When the window has passed
    now += TITLE_CACHE_TTL_MS
    // Then the entry is no longer served as a cache hit
    expect(meta.cachedTitle('s-1')).toBeUndefined()
  })

  it('operator asking for a session this host does not hold live gets no title', () => {
    // Given a title table whose id is not a live session here
    const titles = titlesDouble({ 's-1': 'Plan the trip' }, [])
    const meta = new SessionMeta(() => titles.faces, () => 1_000, () => {})
    // When the operator asks for it
    const title = meta.title('s-1')
    // Then the answer is the empty title and the service was never asked
    expect(title).toBe('')
    expect(titles.reads).toEqual([])
  })

  it('operator asking for a live session whose title has not landed gets no title', () => {
    // Given a live session with no title yet
    const titles = titlesDouble({}, ['s-1'])
    const meta = new SessionMeta(() => titles.faces, () => 1_000, () => {})
    // When the operator asks for its title
    const title = meta.title('s-1')
    // Then the empty title is cached as this session's answer for now
    expect(title).toBe('')
    expect(meta.cachedTitle('s-1')).toBe('')
    expect(titles.reads).toEqual(['s-1'])
  })

  it('operator asking for titles on a host with no session services mounted gets empty titles', () => {
    // Given a host whose session store and title service are both absent
    const meta = new SessionMeta(() => ({}), () => 1_000, () => {})
    // When the operator asks for two titles
    const answers = [meta.title('s-1'), meta.title('s-2')]
    // Then both answer the empty title instead of failing
    expect(answers).toEqual(['', ''])
    expect(meta.archiveSet()).toBeUndefined()
  })

  it('operator asking for a title whose read throws gets the empty title and a logged reason', () => {
    // Given a title service that fails on one session only
    const logs: string[] = []
    const faces = {
      sessions: { get: (id: string) => ({ id }) },
      titles: {
        get: (session: LiveSessionFace) => {
          if (session.id === 's-bad') throw new Error('the title service is unavailable')
          return { title: 'Fine' }
        },
      },
    }
    const meta = new SessionMeta(() => faces, () => 1_000, message => { logs.push(message) })
    // When the operator asks for the failing session and then a healthy one
    const failed = meta.title('s-bad')
    const healthy = meta.title('s-good')
    // Then the failure became an empty title, the next read still answered, and the reason was logged
    expect([failed, healthy]).toEqual(['', 'Fine'])
    expect(logs).toEqual(['the title of session "s-bad" could not be read: the title service is unavailable'])
  })

  it('operator listing rows reads the archive set once and sees who is archived', () => {
    // Given a host whose workspace registry reports two archived sessions
    let reads = 0
    const meta = new SessionMeta(
      () => {
        reads += 1
        return { archive: { archivedSessionIds: ['s-1', 's-3'] } }
      },
      () => 1_000,
      () => {},
    )
    // When the operator reads the archive set for a roster
    const archived = meta.archiveSet()
    // Then membership is what the rows carry, out of one registry read
    expect(archived?.has('s-1')).toBe(true)
    expect(archived?.has('s-2')).toBe(false)
    expect(reads).toBe(1)
  })

  it('operator whose archive registry fails to answer gets no archive flag instead of an error', () => {
    // Given a workspace registry whose archive set throws
    const logs: string[] = []
    const archive = {
      get archivedSessionIds(): readonly string[] {
        throw new Error('the workspace registry is shutting down')
      },
    }
    const meta = new SessionMeta(() => ({ archive }), () => 1_000, message => { logs.push(message) })
    // When the operator reads the archive set
    const archived = meta.archiveSet()
    // Then the flag is simply unavailable and the reason was logged
    expect(archived).toBeUndefined()
    expect(logs).toEqual(['the session archive set could not be read: the workspace registry is shutting down'])
  })

  it('operator asking for more titles than the cache holds still gets every title', () => {
    // Given more distinct sessions than the cache remembers
    const table: Record<string, string> = {}
    for (let index = 0; index <= TITLE_CACHE_LIMIT; index += 1) table[`s-${index}`] = `Title ${index}`
    const titles = titlesDouble(table)
    const meta = new SessionMeta(() => titles.faces, () => 1_000, () => {})
    // When every one of them is resolved
    const answers = Object.keys(table).map(id => meta.title(id))
    // Then all of them answered, the oldest fell out of the cache window's bound, and the newest stayed
    expect(answers).toEqual(Object.values(table))
    expect(meta.cachedTitle('s-0')).toBeUndefined()
    expect(meta.cachedTitle(`s-${TITLE_CACHE_LIMIT}`)).toBe(`Title ${TITLE_CACHE_LIMIT}`)
  })
})
