'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { TID, testid } from '@/lib/testids'
import type { CalendarEvent, DisplayMode, TimelineLayout, TimelineRow } from '@/lib/types'
import styles from './zones.module.css'

export interface TimelineProps {
  layout: TimelineLayout
  /** Server-rendered "now". Held as state and ticked on the client so it stays honest. */
  now: Date
  mode: DisplayMode
  /**
   * Set when the calendar is unreachable. The cached day keeps rendering behind the
   * notice (PRD §9).
   */
  unavailable?: { source: string; since?: string }
}

/** The countdown re-renders every 30s. It never animates (PRD §11). */
const TICK_MS = 30_000
/**
 * Desktop scale, mirrored from `lib/domain/timeline.PX_PER_MINUTE` for the same reason
 * the clock below is mirrored from `lib/time`: that module reaches `lib/config`, which
 * is `server-only`. It is used for one thing — gliding the now-line between renders.
 */
const PX_PER_MINUTE = 0.9
/**
 * The now-line glides at most this far before the next server render repositions it.
 * Without the clamp a page left open would walk the rule down through the meeting
 * below it, which is a lie rather than a flourish (PRD §11).
 */
const NOW_DRIFT_MAX_PX = 34
/** Below this the countdown takes the critical hue (PRD §5). */
const URGENT_MINUTES = 5

/**
 * Wall-clock formatting, local to this Client Component.
 *
 * `lib/time.ts` is the canonical formatter, but it reads `TIMEZONE` from
 * `lib/config.ts`, which carries `import 'server-only'` — pulling that into a client
 * bundle is a build error. The timezone is a fixed constant (PRD §17.4), so the only
 * thing that can drift between the two is the constant itself. If `TIMEZONE` ever
 * moves out of `lib/config.ts`, delete this and import `formatTime`.
 */
const TIMEZONE = 'Europe/Amsterdam'
const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function clock(iso: string): string {
  // Some ICU builds render local midnight as "24:00".
  return CLOCK.format(new Date(iso)).replace(/^24:/, '00:')
}

/**
 * Subtitle for a meeting card. Degrades to nothing for a personal block: `Tandarts`
 * has no attendees and is not a meeting, so "0 attendees" would be a lie (PRD §17.9).
 */
function subtitle(event: CalendarEvent): string | null {
  const parts: string[] = []
  if (event.attendees.length === 1) parts.push('1 ATTENDEE')
  else if (event.attendees.length > 1) parts.push(`${event.attendees.length} ATTENDEES`)
  if (event.location) parts.push(event.location)
  return parts.length > 0 ? parts.join(' · ') : null
}

function countdownLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} MIN LEFT`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}H LEFT` : `${hours}H ${rest}M LEFT`
}

/** See the matching note in `TopFive.tsx`: one line, 2px stripe, content stays (PRD §9). */
function UnavailableLine({ source, since }: { source: string; since?: string }) {
  return (
    <p className={`${styles.unavailable} stripe`} data-testid="zone-unavailable" role="status">
      <span className={styles.unavailableText}>
        {source} unreachable
        {since ? ` · showing data from ${since}` : ''}
      </span>
      <a className={styles.unavailableRetry} href="">
        Retry
      </a>
    </p>
  )
}

/**
 * Zone 3a — the timeline (PRD §5, §17.9).
 *
 * Occupied time is proportional and empty time is not; both decisions were already
 * made by `lib/domain/timeline.ts`, which is why every row arrives with its own
 * `heightPx` and this component never recomputes a layout. It draws what it is given.
 *
 * All-day events render in a header band above the timeline and never as rows —
 * a colleague's holiday cannot be drawn proportionally and is not your commitment.
 *
 * Auto-scroll keeps "now" in frame on mount and on each sync, but a scroll the reader
 * performed themselves ends that for good: `followingRef` latches false and only the
 * `Now` button sets it back. The countdown ticks every 30s and nothing pulses.
 *
 * **Board mode shows now onward only** (§17.13). `lib/domain/timeline` already drops
 * finished events when it is asked for `nowOnward`, and this component re-applies the
 * rule at render time so that a layout built a few minutes ago cannot leave a meeting
 * that has since ended sitting at the top of a wall monitor. Removed, never dimmed.
 *
 * **The now-line is the only thing on this page that moves on its own.** It carries a
 * sub-minute `translateY` derived from the ticking clock and a 1s linear transition, so
 * each tick glides it rather than jumping it (§11). The countdown beside it re-renders
 * without animating, and nothing else here transitions at all.
 */
export default function Timeline({ layout, now, mode, unavailable }: TimelineProps) {
  const nowMs = now.getTime()
  const [clockMs, setClockMs] = useState(nowMs)
  const [following, setFollowing] = useState(true)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const nowRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)
  const programmaticRef = useRef(false)

  // The server decides the first frame; the client keeps it current. Seeding state from
  // the prop rather than from `Date.now()` is what keeps hydration quiet, and a new
  // `now` from a sync is adopted during render rather than in an effect, so the
  // countdown never renders one frame of a stale number.
  const [syncedAt, setSyncedAt] = useState(nowMs)
  if (syncedAt !== nowMs) {
    setSyncedAt(nowMs)
    setClockMs(nowMs)
  }

  useEffect(() => {
    const id = setInterval(() => setClockMs(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const scrollToNow = useCallback(() => {
    const box = scrollRef.current
    const marker = nowRef.current
    if (!box || !marker) return
    programmaticRef.current = true
    box.scrollTop = Math.max(0, marker.offsetTop - box.clientHeight / 2)
    // Our own scroll must not be mistaken for the reader's.
    window.setTimeout(() => {
      programmaticRef.current = false
    }, 120)
  }, [])

  useEffect(() => {
    if (followingRef.current) scrollToNow()
  }, [nowMs, scrollToNow])

  const handleScroll = useCallback(() => {
    if (programmaticRef.current || !followingRef.current) return
    followingRef.current = false
    setFollowing(false)
  }, [])

  const returnToNow = useCallback(() => {
    followingRef.current = true
    setFollowing(true)
    scrollToNow()
  }, [scrollToNow])

  const board = mode === 'board'
  const rows: TimelineRow[] = board
    ? layout.rows.filter((row) => row.kind !== 'event' || !row.isPast)
    : layout.rows

  // How far the clock has moved past the position the server drew the rule at.
  const nowDriftPx = Math.min(
    NOW_DRIFT_MAX_PX,
    Math.max(0, ((clockMs - nowMs) / 60_000) * PX_PER_MINUTE),
  )

  /**
   * Empty and quiet (PRD §9): no meetings at all, so the column becomes a single line
   * of free time in the same vocabulary the compressed gaps already use. No
   * illustration, no encouragement, nothing invented to fill the space — "whitespace
   * is an acceptable and intended outcome".
   */
  const isQuiet = rows.length === 0
  const quietLabel = board && layout.rows.length > 0 ? 'REST OF THE DAY FREE' : 'DAY FREE'

  return (
    <div className={styles.timelineZone} data-quiet={isQuiet ? 'true' : 'false'}>
      {unavailable && <UnavailableLine {...unavailable} />}

      {layout.allDay.length > 0 && (
        <div className={styles.allDayBand} {...testid(TID.allDayBand)}>
          <span className={styles.zoneLabel}>ALL DAY</span>
          {layout.allDay.map((event) => (
            <span key={event.id} className={styles.allDayItem}>
              {event.subject}
            </span>
          ))}
        </div>
      )}

      <div className={styles.zoneHead}>
        <span className={styles.zoneLabel}>TODAY</span>
        <button
          type="button"
          className={styles.nowButton}
          onClick={returnToNow}
          data-following={following ? 'true' : 'false'}
          {...testid(TID.nowButton)}
        >
          Now
        </button>
      </div>

      <div
        id="timeline"
        className={styles.timeline}
        data-mode={mode}
        data-quiet={isQuiet ? 'true' : 'false'}
        onScroll={handleScroll}
        ref={scrollRef}
        {...testid(TID.timeline)}
      >
        {isQuiet && (
          <div className={styles.gapRow} {...testid(TID.timelineGap)}>
            <span className={styles.rowLane} aria-hidden="true" />
            <span className={`${styles.gapLabel} num`}>{quietLabel}</span>
            <span className={styles.gapRule} aria-hidden="true" />
          </div>
        )}

        {rows.map((row, index) => {
          if (row.kind === 'now') {
            return (
              <div
                key={`now-${index}`}
                className={styles.nowRow}
                ref={nowRef}
                style={{ transform: `translateY(${nowDriftPx}px)` }}
                {...testid(TID.nowRule)}
              >
                <span className={styles.rowLane} aria-hidden="true" />
                <span className={`${styles.nowLabel} num`}>{row.label}</span>
                <span className={styles.nowLine} aria-hidden="true" />
              </div>
            )
          }

          if (row.kind === 'gap') {
            return (
              <div
                key={`gap-${index}`}
                className={styles.gapRow}
                style={{ height: row.heightPx }}
                {...testid(TID.timelineGap)}
              >
                <span className={styles.rowLane} aria-hidden="true" />
                <span className={`${styles.gapLabel} num`}>{row.label}</span>
                <span className={styles.gapRule} aria-hidden="true" />
              </div>
            )
          }

          const event = row.event
          const minutesLeft = Math.max(
            0,
            Math.ceil((new Date(event.end).getTime() - clockMs) / 60_000),
          )
          const line = subtitle(event)
          const range = `${clock(event.start)}–${clock(event.end)}`

          return (
            <a
              key={event.id}
              href={`?drill=meeting:${event.id}`}
              className={`${styles.eventRow} timeline-row${row.isNow ? ' stripe' : ''} crossfade`}
              style={{ minHeight: row.heightPx }}
              data-past={row.isPast ? 'true' : 'false'}
              data-now={row.isNow ? 'true' : 'false'}
              aria-label={`${range} ${event.subject}`}
              title={`${range} ${event.subject}`}
              {...testid(TID.timelineEvent)}
            >
              {/* Start time only: the row height already draws the duration to scale. */}
              <span className={`${styles.eventTime} num`}>{clock(event.start)}</span>
              <span className={styles.eventBody}>
                <span className={styles.eventTitle}>{event.subject}</span>
                {/* Past events lose their subtitle; they are context, not work. */}
                {line && !row.isPast && <span className={styles.eventSubtitle}>{line}</span>}
              </span>
              {row.isNow && (
                <span
                  className={`${styles.countdown} num`}
                  data-urgent={minutesLeft <= URGENT_MINUTES ? 'true' : 'false'}
                >
                  {countdownLabel(minutesLeft)}
                </span>
              )}
            </a>
          )
        })}
      </div>
    </div>
  )
}
