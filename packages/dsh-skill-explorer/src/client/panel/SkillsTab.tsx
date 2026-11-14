/**
 * Skills tab: the grouped skill list with the search / facet / workspace
 * toolbar, collapsible source groups, and the per-row enable switch, edit,
 * duplicate and delete actions.
 *
 * The host route family is the only data source; a failed refresh keeps the
 * previous payload visible with an inline error. Which facets are applied and
 * which source groups are open are view preferences, not payload state: they
 * are persisted in localStorage (panel-prefs.ts), because the layout unmounts
 * this page whenever another panel takes the center column.
 */
import { useEffect, useRef, useState } from 'react'
import { SkillApi, type GroupPayload, type ListPayload, type SkillEntry } from '../api.ts'
import { zh } from '../locales.ts'
import { tt } from '../panel-helpers.ts'
import {
  isGroupExpanded,
  loadListPrefs,
  saveListPrefs,
  toggleGroupCollapsed,
  type ListViewPrefs,
  type StorageLike,
} from '../panel-prefs.ts'
import { selectGroups, type SkillListFilter, type SkillMark, type SkillStatus } from '../skill-filter.ts'
import type { SkillDraft } from './controller.ts'
import css from './panel.module.css'

/** The mark facets, in the order the filter bar lists them. */
const MARK_FACETS: readonly SkillMark[] = ['provider-file', 'no-file', 'linked']

/** The enabled/disabled facets, in the order the filter bar lists them. */
const STATUS_FACETS: readonly SkillStatus[] = ['all', 'enabled', 'disabled']

/** Localized provider label with fallback to the raw provider id. */
function providerLabel(provider: string): string {
  const key = `provider.${provider}` as keyof typeof zh
  return key in zh ? tt(key) : provider
}

/** Localized source-group title, falling back to the host's own copy. */
function groupTitle(group: GroupPayload): string {
  const key = `group.${group.key}` as keyof typeof zh
  return key in zh ? tt(key) : group.title
}

/** Localized source-group hint, falling back to the host's own copy. */
function groupHintOf(group: GroupPayload): string {
  const key = `groupHint.${group.key}` as keyof typeof zh
  return key in zh ? tt(key) : group.hint
}

/** The browser's localStorage, or undefined when this context refuses it. */
function listStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // A sandboxed frame throws on the accessor itself; the tab still works,
    // it just does not remember the view between visits.
    return undefined
  }
}

/** Whether any facet narrows the list (the source/status/mark facets only). */
function hasActiveFacets(prefs: ListViewPrefs): boolean {
  return prefs.levels.length > 0 || prefs.status !== 'all' || prefs.marks.length > 0
}

/** How many facet selections are active, for the toolbar badge. */
function activeFacetCount(prefs: ListViewPrefs): number {
  return prefs.levels.length + (prefs.status === 'all' ? 0 : 1) + prefs.marks.length
}

/** The name a duplicate starts from; the user can change it before creating. */
function duplicateSkillName(name: string): string {
  return `${name}-copy`
}

/**
 * Whether this row carries an enable switch.
 *
 * A row with a writable path switches by rewriting its own SKILL.md
 * frontmatter. A plugin-provided file (issue #1854) has no such path, so its
 * switch is recorded in the panel's own store; a truly fileless registration
 * has nothing to switch and still shows none.
 * @param skill - the row's entry.
 * @returns whether the row offers the switch.
 */
function canToggle(skill: SkillEntry): boolean {
  return skill.path !== undefined || skill.fileState === 'provider-file'
}

/**
 * The local-file badge for a row that the write routes cannot serve.
 *
 * A skill with a plugin-supplied file and a skill with no file at all are
 * different facts (issue #1842): the first is "Provided by plugin", only the
 * second is "No local file". Both are pathless, so neither offers file
 * controls.
 * @param skill - the row's entry.
 * @returns the badge copy and its tooltip.
 */
function localFileBadge(skill: SkillEntry): { label: string; tooltip: string } {
  return skill.fileState === 'provider-file'
    ? { label: tt('list.providerFile'), tooltip: tt('list.providerFileTooltip') }
    : { label: tt('list.noFile'), tooltip: tt('list.noFileTooltip') }
}

/** The explanation shown under a row the write routes cannot serve. */
function localFileHint(skill: SkillEntry): string {
  return skill.fileState === 'provider-file' ? tt('list.providerFileHint') : tt('list.noFileHint')
}

/** Marks shown next to a skill (model/user invocable). */
function invokableMarks(skill: SkillEntry): string {
  const marks: string[] = []
  if (skill.modelInvocable) marks.push(tt('list.mark.model'))
  if (skill.userInvocable) marks.push(tt('list.mark.user'))
  return marks.join(' / ')
}

/** One skill row: name, badges, enable switch, edit, duplicate and delete actions. */
function SkillRow({ skill, api, onChanged, onEdit, onDuplicate }: {
  skill: SkillEntry
  api: SkillApi
  onChanged: () => void
  onEdit: (skill: SkillEntry) => void
  onDuplicate: (draft: SkillDraft) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // Sync ref guard: React state updates are async, so a double click before
  // the re-render would fire the same request twice with the stale target.
  const busyRef = useRef(false)

  const toggle = async (): Promise<void> => {
    if (busyRef.current || !canToggle(skill)) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    try {
      // Two identities, one switch: a row with a file certifies the path the
      // write routes re-scan, a plugin-provided row certifies the
      // (provider, name) pair the host records in the panel's own store.
      if (skill.path !== undefined) await api.setEnabled(skill.name, skill.path, !skill.modelInvocable)
      else await api.setProviderEnabled(skill.name, skill.provider, !skill.modelInvocable)
      onChanged()
    } catch (err) {
      setError(tt('list.toggleFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    const path = skill.path
    if (path === undefined) return
    if (!window.confirm(tt('list.deleteConfirm', { name: skill.name }))) return
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    try {
      await api.remove(skill.name, path)
      onChanged()
    } catch (err) {
      setError(tt('list.deleteFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /**
   * Copy this skill's fields into the create form as a starting point. The
   * read route resolves the row's own path through a fresh scan, so the draft
   * can only ever come from a skill the panel is showing.
   */
  const duplicate = async (): Promise<void> => {
    const path = skill.path
    if (path === undefined || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    try {
      const source = await api.read(skill.name, path)
      onDuplicate({
        from: skill.name,
        name: duplicateSkillName(skill.name),
        description: source.description,
        ...(source.whenToUse === undefined ? {} : { whenToUse: source.whenToUse }),
        content: source.content,
      })
    } catch (err) {
      setError(tt('list.duplicateFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const isIsolated = skill.isActiveWorkspace === false
  // Computed once per render: a row with a writable path needs neither.
  const fileBadge = skill.path === undefined ? localFileBadge(skill) : undefined
  // Linked skills are read-only here (their file belongs to whatever they
  // point at), so they offer neither edit nor delete; duplication only reads,
  // so it stays available wherever a path exists.
  const canCopy = skill.path !== undefined

  return (
    <article className={`${css.skillRow}${isIsolated ? ` ${css.skillIsolated}` : ''}`} data-dsh-part="skill-row">
      <header className={css.skillHeader}>
        <span className={css.skillName}>{skill.name}</span>
        {skill.workspaceName !== undefined && (
          <span className={`${css.badge} ${css.badgeWorkspace}`}>{skill.workspaceName}</span>
        )}
        {isIsolated && (
          <span className={`${css.badge} ${css.badgeIsolated}`} title={tt('workspace.isolatedHint', { workspace: skill.workspaceName ?? '' })}>
            {tt('workspace.isolated')}
          </span>
        )}
        {skill.provider !== undefined && (
          <span className={css.badge} title={tt('provider.tooltip', { provider: providerLabel(skill.provider) })}>
            {providerLabel(skill.provider)}
          </span>
        )}
        {skill.linked === true && <span className={css.badge}>{tt('list.linked')}</span>}
        {fileBadge !== undefined && (
          <span className={css.badge} title={fileBadge.tooltip}>{fileBadge.label}</span>
        )}
        {(skill.modelInvocable || skill.userInvocable) && (
          <span className={`${css.badge} ${css.badgeInvokable}`} title={tt('list.invokableTooltip')}>
            {tt('list.invokable', { marks: invokableMarks(skill) })}
          </span>
        )}
        {canToggle(skill) && (
          <button
            type="button"
            className={css.switch}
            role="switch"
            aria-checked={skill.modelInvocable}
            aria-label={skill.modelInvocable ? tt('list.enabled') : tt('list.disabled')}
            title={skill.modelInvocable ? tt('list.enabled') : tt('list.disabled')}
            disabled={busy}
            onClick={() => { void toggle() }}
          >
            <span className={css.switchTrack}><span className={css.switchThumb} /></span>
          </button>
        )}
        {canCopy && (
          <button type="button" className={css.linkButton} disabled={busy} onClick={() => { void duplicate() }}>
            {tt('list.duplicate')}
          </button>
        )}
        {skill.path !== undefined && skill.linked !== true && (
          <button type="button" className={css.linkButton} disabled={busy} onClick={() => { onEdit(skill) }}>
            {tt('list.edit')}
          </button>
        )}
        {skill.path !== undefined && skill.linked !== true && (
          <button type="button" className={`${css.linkButton} ${css.deleteButton}`} data-danger="" disabled={busy} onClick={() => { void remove() }}>
            {tt('list.delete')}
          </button>
        )}
      </header>
      <p className={css.skillDesc}>{skill.description}</p>
      {skill.whenToUse !== undefined && skill.whenToUse !== '' && (
        <p className={css.skillWhen}>{tt('list.when', { when: skill.whenToUse })}</p>
      )}
      {skill.path !== undefined && <div className={css.skillPath}>{skill.path}</div>}
      {skill.path === undefined && <p className={css.skillWhen}>{localFileHint(skill)}</p>}
      {error !== undefined && <p className={css.banner} data-kind="error">{error}</p>}
    </article>
  )
}

/** The skills tab body. */
export function SkillsTab({ api, onEdit, onImport, onDuplicate }: {
  api: SkillApi
  onEdit: (skill: SkillEntry) => void
  onImport: () => void
  onDuplicate: (draft: SkillDraft) => void
}): React.JSX.Element {
  const [payload, setPayload] = useState<ListPayload | undefined>(undefined)
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('all')
  const [query, setQuery] = useState('')
  // The persisted view preferences load once; a storage that refuses them
  // simply yields the defaults, and the effect below is a no-op write.
  const [prefs, setPrefs] = useState<ListViewPrefs>(() => loadListPrefs(listStorage()))
  // Restored facets must be visible, or the list looks inexplicably short.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => hasActiveFacets(loadListPrefs(listStorage())))
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  // Sequence guard: a slow earlier load must not overwrite a newer one.
  const loadSeq = useRef(0)

  const load = async (): Promise<void> => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const next = await api.list()
      if (seq !== loadSeq.current) return
      setPayload(next)
      setError(undefined)
    } catch (err) {
      if (seq !== loadSeq.current) return
      setError(tt('list.loadFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      // A newer load owns the flag while it runs.
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  useEffect(() => { void load() }, [api])

  // One write per change: the whole document is tiny, and rewriting it keeps
  // the stored shape identical to the in-memory shape (no merge step to drift).
  useEffect(() => { saveListPrefs(listStorage(), prefs) }, [prefs])

  // Self-heal a stored source facet whose group is gone (a custom root removed,
  // a plugin uninstalled): keeping it would empty the list with a facet the
  // filter bar cannot even show, because it only offers the groups that exist.
  useEffect(() => {
    if (payload === undefined) return
    const present = new Set(payload.groups.map(group => group.key))
    if (prefs.levels.every(level => present.has(level))) return
    setPrefs(current => ({ ...current, levels: current.levels.filter(level => present.has(level)) }))
  }, [payload, prefs.levels])

  const toggleLevel = (key: string): void => {
    setPrefs(current => ({
      ...current,
      levels: current.levels.includes(key)
        ? current.levels.filter(level => level !== key)
        : [...current.levels, key],
    }))
  }

  const toggleMark = (mark: SkillMark): void => {
    setPrefs(current => ({
      ...current,
      marks: current.marks.includes(mark)
        ? current.marks.filter(entry => entry !== mark)
        : [...current.marks, mark],
    }))
  }

  const clearFacets = (): void => {
    setPrefs(current => ({ ...current, levels: [], status: 'all', marks: [] }))
  }

  const toggleGroup = (key: string): void => {
    setPrefs(current => ({ ...current, collapsed: toggleGroupCollapsed(key, current.collapsed) }))
  }

  // The refresh control is hidden while a load runs: a second request cannot
  // shorten the first, and the loading state already covers the wait.
  const refreshButton = loading
    ? undefined
    : (
      <button type="button" className={css.ghostButton} onClick={() => { void load() }}>
        {tt('refresh')}
      </button>
    )

  // Last-good policy: a failed refresh keeps the previous payload visible and
  // reports the error inline; the error state replaces the list only when
  // there is nothing to fall back to.
  if (payload === undefined) {
    return (
      <div className={css.fillBody}>
        {loading
          ? <p className={css.empty}>{tt('list.loading')}</p>
          : (
            <>
              <p className={css.empty}>{error}</p>
              <div className={css.toolbar}>{refreshButton}</div>
            </>
          )}
      </div>
    )
  }

  const filter: SkillListFilter = {
    workspace: selectedWorkspace,
    query,
    levels: prefs.levels,
    status: prefs.status,
    marks: prefs.marks,
  }
  const visibleGroups = selectGroups(payload.groups, filter)
  const visibleCount = visibleGroups.reduce((total, group) => total + group.skills.length, 0)
  const facetsActive = hasActiveFacets(prefs)
  const narrowed = query.trim() !== '' || selectedWorkspace !== 'all' || facetsActive
  const emptyText = query.trim() !== ''
    ? tt('filter.empty', { query: query.trim() })
    : narrowed ? tt('filter.emptyWorkspace') : tt('list.empty')

  return (
    <div className={css.fillBody}>
      <div className={css.toolbar} data-dsh-part="filter-bar">
        <input
          className={css.search}
          type="search"
          value={query}
          spellCheck={false}
          aria-label={tt('filter.searchLabel')}
          placeholder={tt('filter.searchPlaceholder')}
          onChange={(event) => { setQuery(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') setQuery('') }}
        />
        {payload.workspaces !== undefined && payload.workspaces.length > 1 && (
          <select
            className={css.select}
            value={selectedWorkspace}
            aria-label={tt('filter.workspaceLabel')}
            onChange={(event) => { setSelectedWorkspace(event.target.value) }}
          >
            <option value="all">{tt('filter.workspaceAll')}</option>
            {payload.workspaces.map(ws => (
              <option key={ws.root} value={ws.root}>
                {ws.active ? tt('filter.workspaceCurrent', { name: ws.name }) : ws.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className={css.ghostButton}
          aria-expanded={filtersOpen}
          data-active={facetsActive ? '' : undefined}
          onClick={() => { setFiltersOpen(open => !open) }}
        >
          {tt('filter.toggle')}{facetsActive ? ` (${activeFacetCount(prefs)})` : ''}
        </button>
        <button type="button" className={css.ghostButton} onClick={onImport}>{tt('import.open')}</button>
        <div className={css.toolbarSpacer} />
        {refreshButton}
      </div>
      {filtersOpen && (
        <div className={css.facetBar} data-dsh-part="facet-bar">
          <div className={css.facetRow}>
            <span className={css.facetLabel}>{tt('filter.sourceLabel')}</span>
            {payload.groups.map(group => (
              <button
                key={group.key}
                type="button"
                className={css.facetChip}
                aria-pressed={prefs.levels.includes(group.key)}
                data-active={prefs.levels.includes(group.key) ? '' : undefined}
                onClick={() => { toggleLevel(group.key) }}
              >
                {groupTitle(group)}
                <span className={css.facetCount}>{group.skills.length}</span>
              </button>
            ))}
          </div>
          <div className={css.facetRow}>
            <span className={css.facetLabel}>{tt('filter.statusLabel')}</span>
            {STATUS_FACETS.map(status => (
              <button
                key={status}
                type="button"
                className={css.facetChip}
                aria-pressed={prefs.status === status}
                data-active={prefs.status === status ? '' : undefined}
                onClick={() => { setPrefs(current => ({ ...current, status })) }}
              >
                {tt(`filter.status.${status}`)}
              </button>
            ))}
          </div>
          <div className={css.facetRow}>
            <span className={css.facetLabel}>{tt('filter.markLabel')}</span>
            {MARK_FACETS.map(mark => (
              <button
                key={mark}
                type="button"
                className={css.facetChip}
                aria-pressed={prefs.marks.includes(mark)}
                data-active={prefs.marks.includes(mark) ? '' : undefined}
                onClick={() => { toggleMark(mark) }}
              >
                {tt(`filter.mark.${mark}`)}
              </button>
            ))}
            {facetsActive && (
              <button type="button" className={css.linkButton} onClick={clearFacets}>{tt('filter.clear')}</button>
            )}
          </div>
        </div>
      )}
      {error !== undefined && <p className={css.banner} data-kind="error">{error}</p>}
      {visibleCount === 0
        ? <p className={css.empty}>{emptyText}</p>
        : (
          <div className={css.list}>
            {visibleGroups.map((group) => {
              const expanded = isGroupExpanded(group.key, prefs.collapsed)
              const hint = groupHintOf(group)
              return (
                <section key={group.key} className={css.group} data-collapsed={expanded ? undefined : ''}>
                  <button
                    type="button"
                    className={css.groupToggle}
                    aria-expanded={expanded}
                    data-dsh-part="group-toggle"
                    onClick={() => { toggleGroup(group.key) }}
                  >
                    <span className={css.groupCaret} aria-hidden="true" />
                    <span className={css.groupTitleText}>{groupTitle(group)}</span>
                    <span className={css.count}>{tt('list.count', { count: String(group.skills.length) })}</span>
                  </button>
                  {expanded && hint !== '' && <p className={css.groupHint}>{hint}</p>}
                  {expanded && group.skills.map(skill => (
                    <SkillRow
                      key={skill.name}
                      skill={skill}
                      api={api}
                      onChanged={() => { void load() }}
                      onEdit={onEdit}
                      onDuplicate={onDuplicate}
                    />
                  ))}
                </section>
              )
            })}
          </div>
        )}
    </div>
  )
}
