/**
 * The branch picker popover: searchable local branch list with the current
 * branch checked, the dirtiness line, switch feedback (success/error), and
 * the footer flows (create branch / Git graph).
 * @module dsh-git-graph/client/chips/BranchPopover
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconBranchOutlineRegular, IconCheckOutlineMedium, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { BranchesView, SwitchResult } from '../../core/types.ts'
import type { GitGraphKey } from '../locales.ts'
import { errorMessage } from './error-copy.ts'
import { cx, Backdrop } from './Chip.tsx'
import css from './context.module.css'

/** Props of the branch picker popover. */
export interface BranchPopoverProps {
  view: BranchesView
  /** Workspace-level switch verb; resolves to a stable git error on rejection. */
  onSwitch: (branch: string) => Promise<SwitchResult>
  /** Fired after a successful switch (the owner refetches its status). */
  onSwitched: () => void
  /** Open the create-branch dialog. */
  onCreate: () => void
  /** Open the Git graph panel. */
  onGraph: () => void
  /** Open the create-worktree (new isolated session) dialog. */
  onCreateWorktree: () => void
  /** Open the worktree manager. */
  onManageWorktrees: () => void
  /** Close the popover (backdrop / after a successful switch). */
  onClose: () => void
  t: Translate<GitGraphKey>
  /** Open downward from the official hero row (the default opens upward from the dock row). */
  hero?: boolean
}

/** How long the success notice stays before the popover closes itself. */
const SUCCESS_DISMISS_MS = 900

/** Air kept between the popover and the window's edges. */
const VIEWPORT_MARGIN_PX = 8

/** Air between the chip and the popover, matching the two anchor rules in the stylesheet. */
const ANCHOR_GAP_PX = 8

/** CSS pixel length, or 0 for the `auto` a shrunken list reports. */
function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The box's outer height. */
function borderBoxHeight(element: Element): number {
  const styles = getComputedStyle(element)
  return element.getBoundingClientRect().height + px(styles.borderTopWidth) + px(styles.borderBottomWidth)
}

/** The popover's scrollable content: the branch list (the side test reads it by this marker). */
function listElements(popover: HTMLElement): HTMLElement[] {
  return Array.from(popover.querySelectorAll<HTMLElement>('[data-gitgraph-branch-list]'))
}

type PopoverDirection = 'up' | 'down'

/** The room on one side of the anchor, in CSS pixels. */
function roomOnSide(side: PopoverDirection, anchor: { top: number, bottom: number }, viewportHeight: number): number {
  return side === 'down'
    ? viewportHeight - VIEWPORT_MARGIN_PX - anchor.bottom - ANCHOR_GAP_PX
    : anchor.top - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX
}

/**
 * Pick the side the popover opens on: the side with the room an ideal
 * (uncapped) card needs, else the side with the more room.
 *
 * Every seat has its own side — the dock row opens upward, the hero row opens
 * downward like the official workspace picker beside it — but the room is
 * measured, not assumed: a skin can put the hero row at the bottom of the page
 * (Claude Code's studio home does), where the room below is the footer, so a
 * card that only ever opened downward ran off the window and the composer's own
 * scroll container clipped it. Measuring the ideal height measures the list at
 * its natural size even while the card's `max-height` cap is in effect, so a
 * capped card does not make the room look larger than it is.
 *
 * @param anchor - the box the card is anchored to.
 * @param idealHeight - the popover's uncapped height.
 * @param viewportHeight - the window's height.
 * @param preferred - the side to keep while it has the room.
 */
export function resolvePopoverDirection(
  anchor: { top: number, bottom: number },
  idealHeight: number,
  viewportHeight: number,
  preferred: PopoverDirection,
): PopoverDirection {
  const preferredRoom = roomOnSide(preferred, anchor, viewportHeight)
  if (preferredRoom >= idealHeight) return preferred
  const other: PopoverDirection = preferred === 'down' ? 'up' : 'down'
  return roomOnSide(other, anchor, viewportHeight) > preferredRoom ? other : preferred
}

/**
 * The popover's height with its natural list: the chrome plus the list at its
 * content height, which the card's `max-height` cap has otherwise already
 * shrunk (a scrolled list reports its own box, not its content).
 *
 * The chrome is the card's own outer height minus the list's laid-out outer
 * height, so padding, gaps and every sibling (search box, notice, footer) come
 * along without walking them, and only the list's content has to be read from
 * the list itself.
 */
export function idealPopoverHeight(popover: HTMLElement): number {
  const lists = listElements(popover)
  if (lists.length === 0) return popover.getBoundingClientRect().height
  const chrome = Math.max(0, borderBoxHeight(popover) - lists.reduce((sum, list) => sum + borderBoxHeight(list), 0))
  let listsHeight = 0
  for (const list of lists) {
    const styles = getComputedStyle(list)
    listsHeight += Math.max(px(styles.minHeight), list.scrollHeight)
      + px(styles.paddingTop) + px(styles.paddingBottom) + px(styles.borderTopWidth) + px(styles.borderBottomWidth)
  }
  return chrome + listsHeight
}

/**
 * The branch picker popover.
 * @param props - see {@link BranchPopoverProps}.
 */
export function BranchPopover({ view, onSwitch, onSwitched, onCreate, onGraph, onCreateWorktree, onManageWorktrees, onClose, t, hero = false }: BranchPopoverProps) {
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [direction, setDirection] = useState<PopoverDirection>(hero ? 'down' : 'up')
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Tooltip state for long branch names: first hover needs a 500ms dwell,
  // once shown, switching items shows immediately; leaving resets the dwell.
  const [tipReadyName, setTipReadyName] = useState<string | null>(null)
  const [tipActive, setTipActive] = useState(false)
  const [tipDir, setTipDir] = useState<'up' | 'down'>('up')
  const tipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    if (dismissTimer.current !== undefined) clearTimeout(dismissTimer.current)
    if (tipTimer.current !== undefined) clearTimeout(tipTimer.current)
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return view.branches
    return view.branches.filter(branch => branch.name.toLowerCase().includes(needle))
  }, [view.branches, query])

  // The side the card opens on, measured against the window: the hero seat
  // anchors at the bottom of the page, so the room below it is the footer and a
  // card that only ever opens downward runs out of the window there.
  const place = useCallback((): void => {
    const popover = popoverRef.current
    const anchor = popover?.parentElement
    if (popover === null || popover === undefined || anchor === null || anchor === undefined) return
    const next = resolvePopoverDirection(
      anchor.getBoundingClientRect(),
      idealPopoverHeight(popover),
      window.innerHeight,
      hero ? 'down' : 'up',
    )
    setDirection(current => (current === next ? current : next))
  }, [hero])

  useLayoutEffect(() => {
    place()
  }, [place, filtered.length, error, success])

  // A resized window changes which side has the room; the room itself is
  // measured again rather than carried over from the last layout.
  useEffect(() => {
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [place])

  const switchTo = (branch: string): void => {
    if (pending !== null) return
    setPending(branch)
    setError(null)
    setSuccess(null)
    void onSwitch(branch).then((result) => {
      if (result.ok) {
        onSwitched()
        setSuccess(t('toast.switchSuccess', { branchName: result.branch }))
        dismissTimer.current = setTimeout(onClose, SUCCESS_DISMISS_MS)
        return
      }
      setError(errorMessage(result.error, t))
    }).finally(() => { setPending(null) })
  }

  return (
    <>
      <Backdrop onClose={onClose} />
      <div
        ref={popoverRef}
        className={cx(
          css.popover,
          hero && css.popoverHero,
          direction === 'up' ? css.popoverUp : css.popoverDown,
        )}
        role="listbox"
        aria-label={t('branch.search')}
        data-gitgraph-popover
        data-gitgraph-side={direction}
      >
        <div className={css.searchBox}>
          <IconSearchOutlineRegular size={14} />
          <input
            className={css.searchInput}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
            placeholder={t('branch.search')}
            autoFocus
          />
        </div>
        {view.dirtyFiles > 0
          && <div className={css.dirty}>{t('branch.dirty', { count: view.dirtyFiles })}</div>}
        <div
          className={css.list}
          data-gitgraph-branch-list
          onMouseLeave={() => {
            // Leaving the whole list resets the instant-handoff state, so
            // moving between items keeps the bubble immediate while leaving
            // the popover re-arms the dwell threshold.
            if (tipTimer.current !== undefined) {
              clearTimeout(tipTimer.current)
              tipTimer.current = undefined
            }
            setTipActive(false)
            setTipReadyName(null)
          }}
        >
          {filtered.length === 0
            ? <div className={css.empty}>{t('branch.empty')}</div>
            : filtered.map(branch => (
              <button
                type="button"
                key={branch.name}
                className={cx(css.item, branch.current && css.itemActive)}
                onClick={() => { switchTo(branch.name) }}
                role="option"
                aria-selected={branch.current}
                data-tip={branch.name.length > 18 ? branch.name : ''}
                data-tip-ready={branch.name === tipReadyName ? 'true' : ''}
                aria-label={branch.name}
                data-tip-dir={tipDir}
                onMouseEnter={(event) => {
                  if (tipTimer.current !== undefined) clearTimeout(tipTimer.current)
                  // Viewport-aware flip: near the top of the scroll list the
                  // bubble would be clipped above — flip it below instead.
                  const list = event.currentTarget.parentElement
                  if (list !== null) {
                    const itemTop = event.currentTarget.getBoundingClientRect().top
                    const listTop = list.getBoundingClientRect().top
                    setTipDir(itemTop - listTop < 56 ? 'down' : 'up')
                  }
                  if (tipActive) {
                    setTipReadyName(branch.name)
                  } else {
                    tipTimer.current = setTimeout(() => {
                      setTipActive(true)
                      setTipReadyName(branch.name)
                    }, 500)
                  }
                }}
                disabled={pending !== null}
              >
                <IconBranchOutlineRegular size={14} />
                <span className={css.itemText}>
                  <span className={css.itemName} title={branch.name}>{branch.name}</span>
                </span>
                {branch.current && <IconCheckOutlineMedium className={css.check} size={14} />}
              </button>
            ))}
        </div>
        {success !== null && <div className={cx(css.notice, css.noticeOk)}>{success}</div>}
        {error !== null && <div className={css.notice}>{error}</div>}
        <div className={css.footer}>
          <button type="button" className={css.footerItem} onClick={onCreate}>
            <IconBranchOutlineRegular size={14} />
            {t('branch.create')}
          </button>
          <button type="button" className={css.footerItem} onClick={onGraph}>
            <IconBranchOutlineRegular size={14} />
            {t('branch.graph')}
          </button>
          <button type="button" className={css.footerItem} onClick={onCreateWorktree} data-dsh-part="worktree-create">
            <IconBranchOutlineRegular size={14} />
            {t('worktree.create')}
          </button>
          <button type="button" className={css.footerItem} onClick={onManageWorktrees} data-dsh-part="worktree-manage">
            <IconBranchOutlineRegular size={14} />
            {t('worktree.manage')}
          </button>
        </div>
      </div>
    </>
  )
}
