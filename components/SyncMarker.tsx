'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { refreshSources } from '@/app/actions'
import { CLOCK_TICK_MS, POLL_MS, STALE_AFTER_MS } from '@/lib/constants'
import { TID, testid } from '@/lib/testids'
import { formatRelative } from '@/lib/time'
import styles from './zones.module.css'

export interface SyncMarkerProps {
  /** ISO timestamp of the last successful source write, or null. */
  lastSyncedAt: string | null
  /**
   * The instant the server drew this render. Seeds the clock so the first client render
   * produces the same words the server did, and re-seeds it on every poll.
   */
  nowMs: number
  /** Interval between automatic refreshes. 0 turns polling off. */
  pollMs?: number
  /** Test seam: called instead of touching the router or the server action. */
  onRefresh?: () => void
}

/**
 * Reads one instant and answers both questions from it, so the label and the hue can
 * never disagree.
 */
function readSync(
  lastSyncedAt: string | null,
  nowMs: number,
): { marker: string; isStale: boolean } {
  if (!lastSyncedAt) return { marker: 'Never synced', isStale: true }
  const syncedAt = new Date(lastSyncedAt).getTime()
  return {
    marker: `Synced ${formatRelative(syncedAt, new Date(nowMs))}`,
    isStale: nowMs - syncedAt > STALE_AFTER_MS,
  }
}

/**
 * The last-synced marker, and the thing that keeps the page true (PRD §9, §15.3).
 *
 * Two jobs, because they are one job. The marker *is* the refresh control, so the
 * component that says how old the data is has to be the component that can do something
 * about it:
 *
 *   - **It polls.** A dashboard rendered once and left alone is the only way this product
 *     can actively mislead: a meeting that finished at 16:00 stays on the timeline, a task
 *     closed in Linear stays in the top five, and the bar keeps insisting it synced just
 *     now. `router.refresh()` re-runs the Server Component and cross-fades the result into
 *     place — no remount, so the open cascade does not replay and the drill-in stays open
 *     (§17.13). The poll respects the source TTLs; it does not clear them.
 *   - **It ticks.** Between polls the relative label is recomputed every 30 seconds, so
 *     "Synced just now" becomes "Synced 2m ago" on its own rather than waiting for a
 *     render it has no reason to need.
 *   - **Pressing it means now.** A manual refresh drops the `linear:` and `graph:` caches
 *     first (see `app/actions.ts`), because a control that re-rendered the same 40-second-old
 *     response while claiming to have synced would be exactly the lie §9 forbids.
 *
 * A hidden tab does not poll. The wall monitor is never hidden, and a laptop left open on
 * another desktop for an hour should not have spent that hour calling Graph — but it
 * refreshes the moment it comes back into view, so what you see on returning is current.
 */
export default function SyncMarker({
  lastSyncedAt,
  nowMs,
  pollMs = POLL_MS,
  onRefresh,
}: SyncMarkerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // The server decides the first frame; the client keeps it current. Seeding from the
  // prop rather than from `Date.now()` is what keeps hydration quiet, and a new `nowMs`
  // from a poll is adopted during render so the label never shows one stale frame.
  const [seed, setSeed] = useState(nowMs)
  const [clockMs, setClockMs] = useState(nowMs)
  if (seed !== nowMs) {
    setSeed(nowMs)
    setClockMs(nowMs)
  }

  useEffect(() => {
    const id = setInterval(() => setClockMs(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])

  const refresh = useCallback(() => {
    if (onRefresh) return onRefresh()
    startTransition(async () => {
      await refreshSources()
    })
  }, [onRefresh])

  // The poll is a plain re-render: no cache eviction, so the TTLs still decide how often
  // a source is actually called. Kept behind a ref, updated after each render, so a new
  // `onRefresh` or a new router does not tear down and restart the timer — a poll every
  // minute that resets itself on every render is a poll that never fires.
  const pollRef = useRef<() => void>(() => {})
  useEffect(() => {
    pollRef.current = () => {
      if (onRefresh) return onRefresh()
      startTransition(() => router.refresh())
    }
  })

  useEffect(() => {
    if (pollMs <= 0 || typeof document === 'undefined') return

    let last = Date.now()
    const run = () => {
      last = Date.now()
      pollRef.current()
    }

    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      run()
    }, pollMs)

    // Coming back to a tab that has been hidden: catch up at once rather than showing
    // whatever was on screen when it was hidden until the next tick.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - last < pollMs) return
      run()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pollMs])

  const { marker, isStale } = readSync(lastSyncedAt, clockMs)

  return (
    <button
      type="button"
      className={styles.syncButton}
      data-stale={isStale ? 'true' : 'false'}
      data-refreshing={pending ? 'true' : 'false'}
      onClick={refresh}
      aria-label={`${marker}. Refresh now.`}
      {...testid(TID.refreshButton)}
    >
      <span className={styles.syncGlyph} aria-hidden="true">
        ↻
      </span>
      <span className="num" {...testid(TID.syncMarker)}>
        {marker}
      </span>
    </button>
  )
}
