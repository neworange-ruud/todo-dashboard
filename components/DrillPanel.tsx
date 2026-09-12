'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { useSearchParams } from 'next/navigation'

import { TID, testid } from '@/lib/testids'
// Runtime values come from the client-safe module; the rest are type-only imports,
// which are erased at build time and so never reach the browser bundle.
import { BLOCK_TITLES, blockOrderFor } from '@/lib/drill/blocks'
import type { DrillBlockId, DrillType } from '@/lib/drill/blocks'
import type { DrillAction, DrillPayload } from '@/lib/drill/meeting'
import type { DrillBlock as DrillBlockModel } from '@/lib/types'
import DrillBlock from './DrillBlock'
import styles from './drill.module.css'

/**
 * The drill-in panel (PRD §8) — "where the value is".
 *
 * Four invariants, all of them tested:
 *
 *  1. **One panel, ever.** Drilling from a drill-in pushes onto a stack *inside* this
 *     component and leaves a breadcrumb. Nothing in the product opens a second panel.
 *  2. **Nothing reorders.** Containers are laid out from {@link BLOCK_ORDER}, a static
 *     array — never from the order responses arrive in. A late block fills in where it
 *     always was, so the panel never jumps under the reader's eyes.
 *  3. **Blocks are independent.** Each block is its own request, so each fills on its own
 *     schedule, fails on its own, and retries on its own. There is no whole-panel error.
 *  4. **Four ways out, always.** Escape, backdrop, swipe down, and the close control.
 *
 * The panel lives at its own address (`?drill=meeting:<id>`), so it survives a refresh and
 * can be sent to yourself. The trail is part of that address —
 * `?drill=meeting:evt-1,issue:RW-214` restores the whole stack. The URL is written with
 * `history.pushState`, which the App Router observes through `useSearchParams`: the panel
 * re-addresses itself without re-running the server page behind it.
 *
 * `useSearchParams` requires a Suspense boundary, which the default export supplies.
 */

// ---------------------------------------------------------------------------
// The fetch seam
// ---------------------------------------------------------------------------

export interface DrillFetchResult {
  title?: string
  subtitle?: string | null
  action?: DrillAction
  block: DrillBlockModel<unknown>
}

/** One block of one drill-in. Injected in tests; production goes to the route handler. */
export type DrillFetcher = (
  type: DrillType,
  id: string,
  blockId: DrillBlockId,
  signal?: AbortSignal,
  dateKey?: string | null,
) => Promise<DrillFetchResult>

const defaultFetcher: DrillFetcher = async (type, id, blockId, signal, dateKey) => {
  const search = new URLSearchParams({ block: blockId })
  // A meeting is resolved by scanning a day's calendar, so a panel opened from a preview
  // of another date has to say which date it means or the event will not be found.
  if (dateKey) search.set('date', dateKey)
  const res = await fetch(
    `/api/drill/${type}/${encodeURIComponent(id)}?${search.toString()}`,
    { signal, headers: { accept: 'application/json' } },
  )
  if (!res.ok) throw new Error(`Drill request failed (${res.status})`)
  const payload = (await res.json()) as DrillPayload
  const block = payload.blocks?.find((b) => b.id === blockId)
  return {
    title: payload.title,
    subtitle: payload.subtitle,
    action: payload.action,
    block: block ?? {
      id: blockId,
      title: BLOCK_TITLES[blockId],
      status: 'empty',
      elapsedMs: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// The trail, encoded in the URL
// ---------------------------------------------------------------------------

export interface TrailEntry {
  type: DrillType
  id: string
}

const TYPES: readonly string[] = ['meeting', 'issue', 'person', 'account']
const PARAM = 'drill'

/** `meeting:evt-1,issue:RW-214` → the stack. Unreadable segments are dropped, not thrown. */
export function parseTrail(raw: string | null): TrailEntry[] {
  if (!raw) return []
  const out: TrailEntry[] = []
  for (const segment of raw.split(',')) {
    const at = segment.indexOf(':')
    if (at < 1) continue
    const type = segment.slice(0, at)
    if (!TYPES.includes(type)) continue
    let id = segment.slice(at + 1)
    try {
      id = decodeURIComponent(id)
    } catch {
      // A malformed escape is still a usable id; better a raw string than an empty panel.
    }
    if (id) out.push({ type: type as DrillType, id })
  }
  return out
}

export function serialiseTrail(trail: TrailEntry[]): string {
  return trail.map((e) => `${e.type}:${encodeURIComponent(e.id)}`).join(',')
}

function keyOf(entry: TrailEntry): string {
  return `${entry.type}:${entry.id}`
}

/** Default label per type, so the one action is present before any data has arrived. */
function defaultAction(type: DrillType): DrillAction {
  if (type === 'issue') return { label: 'Open in Linear', href: null }
  if (type === 'meeting') return { label: 'Open in Outlook', href: null }
  return { label: 'Open in Brain', href: null }
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface DrillPanelProps {
  /** Test seam. Production uses the route handler. */
  fetcher?: DrillFetcher
  /** The day the dashboard behind the panel is showing, when it is not today. */
  dateKey?: string | null
}

export default function DrillPanel(props: DrillPanelProps) {
  // useSearchParams reads request-time state, so it needs a boundary or the whole route
  // bails out to client rendering at build time.
  return (
    <Suspense fallback={null}>
      <DrillPanelInner {...props} />
    </Suspense>
  )
}

/** How long the exit animation runs — must match `.panelClosing` in drill.module.css. */
const EXIT_MS = 200

function DrillPanelInner({ fetcher = defaultFetcher, dateKey = null }: DrillPanelProps) {
  const searchParams = useSearchParams()
  const raw = searchParams.get(PARAM)
  const urlTrail = useMemo(() => parseTrail(raw), [raw])

  const [trail, setTrail] = useState<TrailEntry[]>(urlTrail)
  const [closing, setClosing] = useState(false)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [seenUrl, setSeenUrl] = useState<string | null>(raw)

  /*
   * The URL is authoritative whenever it changes — a refresh, a pasted link, browser Back.
   * Adjusted during render rather than in an effect: React's documented way to react to a
   * changed input without a second render pass, and it keeps the panel from flashing the
   * previous trail for a frame. The one exception is a URL emptied by our own close, which
   * must not cut the 200ms exit short.
   */
  if (raw !== seenUrl) {
    setSeenUrl(raw)
    if (urlTrail.length > 0) {
      setTrail(urlTrail)
      setClosing(false)
    } else if (!closing) {
      setTrail([])
    }
  }

  const writeUrl = useCallback((next: TrailEntry[], mode: 'push' | 'replace') => {
    if (typeof window === 'undefined') return
    try {
      const url = new URL(window.location.href)
      if (next.length === 0) url.searchParams.delete(PARAM)
      else url.searchParams.set(PARAM, serialiseTrail(next))
      const target = `${url.pathname}${url.search}${url.hash}`
      // Native history keeps the server page behind the panel exactly where it was; the
      // App Router picks the change up through useSearchParams.
      if (mode === 'push') window.history.pushState(null, '', target)
      else window.history.replaceState(null, '', target)
    } catch {
      // An addressable panel is a convenience; a panel that throws on navigation is not.
    }
  }, [])

  const close = useCallback(() => {
    setClosing(true)
    writeUrl([], 'replace')
    window.setTimeout(() => {
      setTrail([])
      setClosing(false)
    }, EXIT_MS)
  }, [writeUrl])

  const push = useCallback(
    (type: DrillType, id: string) => {
      setTrail((prev) => {
        const next = [...prev, { type, id }]
        writeUrl(next, 'push')
        return next
      })
    },
    [writeUrl],
  )

  /** Back steps one level; a crumb jumps straight to its level. */
  const jumpTo = useCallback(
    (index: number) => {
      setTrail((prev) => {
        if (index < 0 || index >= prev.length - 1) return prev
        const next = prev.slice(0, index + 1)
        writeUrl(next, 'push')
        return next
      })
    },
    [writeUrl],
  )

  const open = trail.length > 0
  const current = trail[trail.length - 1]

  // Escape — the first of the four ways out.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  const noteTitle = useCallback((key: string, title: string) => {
    setTitles((prev) => (prev[key] === title ? prev : { ...prev, [key]: title }))
  }, [])

  if (!open || !current) return null

  const currentKey = keyOf(current)
  const currentTitle = titles[currentKey] ?? current.id

  return (
    <>
      <button
        type="button"
        aria-label="Close drill-in"
        className={`${styles.backdrop} ${closing ? styles.backdropClosing : ''}`}
        onClick={close}
      />
      <Panel
        key={currentKey}
        entry={current}
        dateKey={dateKey}
        entryKey={currentKey}
        trail={trail}
        titles={titles}
        title={currentTitle}
        closing={closing}
        fetcher={fetcher}
        onClose={close}
        onDrill={push}
        onJump={jumpTo}
        onTitle={noteTitle}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// The panel itself — one instance, whatever the depth of the trail
// ---------------------------------------------------------------------------

interface PanelProps {
  entry: TrailEntry
  dateKey: string | null
  entryKey: string
  trail: TrailEntry[]
  titles: Record<string, string>
  title: string
  closing: boolean
  fetcher: DrillFetcher
  onClose: () => void
  onDrill: (type: DrillType, id: string) => void
  onJump: (index: number) => void
  onTitle: (key: string, title: string) => void
}

function Panel({
  entry,
  dateKey,
  entryKey,
  trail,
  titles,
  title,
  closing,
  fetcher,
  onClose,
  onDrill,
  onJump,
  onTitle,
}: PanelProps) {
  const { blocks, meta, retry } = useDrillData(entry, fetcher, dateKey)
  const panelRef = useRef<HTMLElement | null>(null)
  const touchStartY = useRef<number | null>(null)

  const heading = meta?.title ?? title
  const action = meta?.action ?? defaultAction(entry.type)

  useEffect(() => {
    if (meta?.title) onTitle(entryKey, meta.title)
  }, [meta?.title, entryKey, onTitle])

  useEffect(() => {
    panelRef.current?.focus()
  }, [entryKey])

  // Swipe down — the fourth way out, and the one the sheet's drag handle advertises.
  const onTouchStart = (event: ReactTouchEvent) => {
    touchStartY.current = event.touches[0]?.clientY ?? null
  }
  const onTouchEnd = (event: ReactTouchEvent) => {
    const start = touchStartY.current
    const end = event.changedTouches[0]?.clientY
    touchStartY.current = null
    if (start !== null && end !== undefined && end - start > 60) onClose()
  }

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      tabIndex={-1}
      className={`${styles.panel} ${closing ? styles.panelClosing : ''}`}
      data-drill-type={entry.type}
      data-drill-id={entry.id}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      {...testid(TID.panel)}
    >
      <div className={styles.handle} aria-hidden>
        <div className={styles.handleBar} />
      </div>

      <header className={styles.header}>
        {trail.length > 1 && (
          <nav className={styles.trail} aria-label="Trail">
            {trail.map((crumb, i) => {
              const key = keyOf(crumb)
              const label = titles[key] ?? crumb.id
              const isCurrent = i === trail.length - 1
              return (
                <span key={`${key}-${i}`} className={styles.trail}>
                  {i > 0 && (
                    <span className={styles.crumbSeparator} aria-hidden>
                      ›
                    </span>
                  )}
                  <button
                    type="button"
                    className={`${styles.crumb} ${isCurrent ? styles.crumbCurrent : ''}`}
                    aria-current={isCurrent ? 'page' : undefined}
                    disabled={isCurrent}
                    onClick={() => onJump(i)}
                    {...testid(TID.panelCrumb)}
                  >
                    {label}
                  </button>
                </span>
              )
            })}
          </nav>
        )}

        <div className={styles.headerTop}>
          <div>
            <h2 className={`${styles.title} voice-written`}>{heading}</h2>
            {meta?.subtitle && <p className={styles.subtitle}>{meta.subtitle}</p>}
          </div>
          <div className={styles.headerActions}>
            {trail.length > 1 && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => onJump(trail.length - 2)}
              >
                Back
              </button>
            )}
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Close"
              onClick={onClose}
              {...testid(TID.panelClose)}
            >
              ✕
            </button>
          </div>
        </div>
      </header>

      {/*
        Laid out from the static order for this drill type, never from the response order
        (PRD §8). A meeting and an issue have different fives; both have a fixed five.
      */}
      <div className={styles.blocks}>
        {blockOrderFor(entry.type).map((id) => (
          <DrillBlock
            key={id}
            block={blocks[id] ?? { id, title: BLOCK_TITLES[id], status: 'loading' }}
            onRetry={() => retry(id)}
            onDrill={(type, targetId) => onDrill(type, targetId)}
            subject={`${entry.type}:${entry.id}`}
          />
        ))}
      </div>

      {/* One button, bottom of the panel, always in the same place. */}
      <footer className={styles.footer}>
        {action.href ? (
          <a
            className={styles.action}
            href={action.href}
            target="_blank"
            rel="noreferrer"
            {...testid(TID.panelAction)}
          >
            {action.label}
          </a>
        ) : (
          <button type="button" className={styles.action} disabled {...testid(TID.panelAction)}>
            {action.label}
          </button>
        )}
      </footer>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Per-block loading
// ---------------------------------------------------------------------------

type BlockMap = Partial<Record<DrillBlockId, DrillBlockModel<unknown>>>

/**
 * The opening state: five titled containers, all of them in flight.
 *
 * They start as `loading` rather than `pending` because that is the truth one tick after
 * mount — every block is requested on the same frame the panel appears.
 */
function loadingBlocks(type: DrillType): BlockMap {
  const map = {} as BlockMap
  for (const id of blockOrderFor(type)) {
    map[id] = { id, title: BLOCK_TITLES[id], status: 'loading' }
  }
  return map
}

interface DrillMeta {
  title?: string
  subtitle?: string | null
  action?: DrillAction
}

/**
 * Five requests, five independent lifetimes.
 *
 * Every block starts in flight at once and lands into its own slot. Because the panel
 * renders from {@link BLOCK_ORDER} rather than from this map's insertion order, an
 * out-of-order arrival changes one container's contents and nothing else's position.
 */
function useDrillData(entry: TrailEntry, fetcher: DrillFetcher, dateKey: string | null) {
  const [blocks, setBlocks] = useState<BlockMap>(() => loadingBlocks(entry.type))
  const [meta, setMeta] = useState<DrillMeta | null>(null)
  const alive = useRef(true)
  const { type, id } = entry

  const load = useCallback(
    (blockId: DrillBlockId) => {
      fetcher(type, id, blockId, undefined, dateKey)
        .then((result) => {
          if (!alive.current) return
          setBlocks((prev) => ({ ...prev, [blockId]: result.block }))
          if (result.title || result.action) {
            setMeta((prev) =>
              prev ?? {
                title: result.title,
                subtitle: result.subtitle ?? null,
                action: result.action,
              },
            )
          }
        })
        .catch(() => {
          if (!alive.current) return
          // A transport failure is this block's failure and nobody else's.
          setBlocks((prev) => ({
            ...prev,
            [blockId]: {
              ...(prev[blockId] ?? { id: blockId, title: BLOCK_TITLES[blockId] }),
              status: 'failed',
              error: 'Could not reach the server',
            },
          }))
        })
    },
    [fetcher, type, id, dateKey],
  )

  /** *Retry* puts one block back in flight and leaves the other four untouched. */
  const retry = useCallback(
    (blockId: DrillBlockId) => {
      setBlocks((prev) => ({
        ...prev,
        [blockId]: {
          ...(prev[blockId] ?? { id: blockId, title: BLOCK_TITLES[blockId] }),
          status: 'loading',
          error: undefined,
        },
      }))
      load(blockId)
    },
    [load],
  )

  // `Panel` is keyed by the trail entry, so a new drill target arrives as a fresh mount
  // with fresh in-flight blocks — nothing to reset here, only requests to start.
  useEffect(() => {
    alive.current = true
    for (const blockId of blockOrderFor(type)) load(blockId)
    return () => {
      alive.current = false
    }
  }, [load, type])

  return { blocks, meta, retry }
}
