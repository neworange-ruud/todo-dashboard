import { TID, testid } from '@/lib/testids'
import type { SyncState } from '@/lib/types'
import SyncMarker from './SyncMarker'
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
   * The instant this render was drawn, threaded to the marker so its relative label
   * hydrates to the same words the server wrote. Passed in rather than read here: a
   * component that reads the clock while rendering has no stable answer to give.
   */
  nowMs: number
  /** Interval between automatic refreshes, in ms. 0 turns polling off. */
  pollMs?: number
  /** Test seam: called instead of refreshing the route. */
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
export default function Bar({
  dateLabel,
  sync,
  nowMs,
  pollMs,
  onRefresh,
  isToday = true,
  nav,
}: BarProps) {
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

        <SyncMarker
          lastSyncedAt={sync.lastSyncedAt}
          nowMs={nowMs}
          {...(pollMs === undefined ? {} : { pollMs })}
          {...(onRefresh ? { onRefresh } : {})}
        />
      </div>
    </header>
  )
}
