import { STALE_AFTER_MS } from '@/lib/config'
import { TID, testid } from '@/lib/testids'
import { formatRelative } from '@/lib/time'
import type { SyncState } from '@/lib/types'
import ThemeToggle from './ThemeToggle'
import styles from './zones.module.css'

export interface BarNav {
  /** Addresses for the day before, the day after, and the live day. */
  previous: string
  next: string
  today: string
}

export interface BarProps {
  /** Pre-formatted date for the day being shown, e.g. "Friday 11 September". */
  dateLabel: string
  sync: SyncState
  /**
   * Optional handler for the sync marker. Only ever supplied by a client parent;
   * without it the marker is still a real button, it just has nothing to do yet.
   */
  onRefresh?: () => void
  /** False when a date override is showing another day (PRD §17.14). */
  isToday?: boolean
  /** Date navigation. Absent in contexts that have no router, such as a unit test. */
  nav?: BarNav
}

/**
 * Zone 0 — the persistent bar (PRD §3, §9).
 *
 * Wordmark, a hairline, the date, and on the right the last-synced marker, which
 * *is* the refresh control: `↻ Synced 2m ago` in mono 11px. 40px tall and quiet;
 * it is the one element on the page that never changes shape.
 *
 * Staleness is purely time-based, exactly as §9 specifies: beyond 15 minutes the
 * marker shifts to the warning hue and **nothing else changes**. Source health is
 * deliberately not folded in here — a single unreachable source is reported as an
 * inline line inside the zone it affects, so that the bar keeps meaning one thing.
 */
/**
 * Reads the clock once and answers both questions from the same instant, so the label
 * and the hue can never disagree. On the server this is request time; there is no
 * hydration to mismatch, because the bar is rendered on the server.
 */
function readSync(lastSyncedAt: string | null): { marker: string; isStale: boolean } {
  if (!lastSyncedAt) return { marker: 'Never synced', isStale: true }
  const now = new Date()
  const syncedAt = new Date(lastSyncedAt)
  return {
    marker: `Synced ${formatRelative(syncedAt, now)}`,
    isStale: now.getTime() - syncedAt.getTime() > STALE_AFTER_MS,
  }
}

export default function Bar({
  dateLabel,
  sync,
  onRefresh,
  isToday = true,
  nav,
}: BarProps) {
  const { marker, isStale } = readSync(sync.lastSyncedAt)

  return (
    <header
      className={styles.bar}
      data-preview={isToday ? 'false' : 'true'}
      {...testid(TID.bar)}
    >
      <div className={styles.barIdentity}>
        <span className={styles.wordmark}>TASK DESK</span>
        <span className={styles.barSeparator} aria-hidden="true" />

        {nav && (
          <a
            className={styles.dateStep}
            href={nav.previous}
            aria-label="Previous day"
            {...testid(TID.datePrev)}
          >
            ‹
          </a>
        )}

        <span className={`${styles.barDate} num`} {...testid(TID.dateLabel)}>
          {dateLabel}
        </span>

        {nav && (
          <a
            className={styles.dateStep}
            href={nav.next}
            aria-label="Next day"
            {...testid(TID.dateNext)}
          >
            ›
          </a>
        )}

        {/*
          Not today, and saying so. A preview that looked identical to the live day is the
          one failure mode this feature can produce, and PRD §9 is unambiguous about the
          product never lying about its own state — so the marker is a word, in the warning
          hue, next to the date it qualifies, and it doubles as the way back.
        */}
        {!isToday && (
          <a
            className={styles.previewMark}
            href={nav?.today ?? '/'}
            {...testid(TID.previewMark)}
          >
            PREVIEW · BACK TO TODAY
          </a>
        )}
      </div>

      <div className={styles.barControls}>
        <ThemeToggle />

        <button
          type="button"
          className={styles.syncButton}
          data-stale={isStale ? 'true' : 'false'}
          onClick={onRefresh}
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
      </div>
    </header>
  )
}
