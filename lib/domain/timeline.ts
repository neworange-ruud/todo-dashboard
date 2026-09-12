import { formatDuration, formatTime, minutesSinceMidnight, toDateKey } from '../time'
import type { CalendarEvent, TimelineLayout, TimelineRow } from '../types'

/**
 * Timeline layout (PRD §5, §17.9).
 *
 * The whole point: **occupied time is proportional, empty time is not.** A three-hour
 * workshop draws as a wall; two empty hours collapse into one 34px band labelled
 * `2H FREE`. That is what keeps an honest load reading from making an empty Thursday
 * four screens tall.
 *
 * The day is framed by its own contents — first event −30 min to last event +30 min —
 * never a fixed 09:00–18:00 window.
 */

/** Desktop: 1 minute = 0.9px. */
export const PX_PER_MINUTE = 0.9
/** Mobile: proportion preserved, scale halved (PRD §5). */
export const PX_PER_MINUTE_COMPACT = 0.45
/** No event ever draws smaller than this — a 5-minute block must stay a legible target. */
export const MIN_EVENT_PX = 32
/** Every gap band is the same height, whatever it spans. That is the compression. */
export const GAP_BAND_PX = 34
/** On mobile, gaps shorter than this become spacing rather than a labelled band. */
export const COMPACT_GAP_ABSORB_MINUTES = 30
/** Breathing room either side of the day's contents. */
export const DAY_PADDING_MINUTES = 30

const MINUTES_PER_DAY = 1440

export interface TimelineOptions {
  /** Mobile profile: halved scale, sub-30-minute gaps absorbed into spacing. */
  compact?: boolean
  /** Wall-monitor profile: finished events are **removed**, not dimmed (PRD §5). */
  nowOnward?: boolean
}

interface Placed {
  event: CalendarEvent
  startMinutes: number
  endMinutes: number
}

const EMPTY: TimelineLayout = { allDay: [], rows: [], bookedMinutes: 0, freeMinutes: 0 }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function place(event: CalendarEvent): Placed {
  const start = new Date(event.start)
  const end = new Date(event.end)
  const startMinutes = minutesSinceMidnight(start)
  let endMinutes = minutesSinceMidnight(end)
  // Midnight-terminated or overnight events read as 00:00; the day's last minute is 1440.
  if (endMinutes <= startMinutes) endMinutes = MINUTES_PER_DAY
  return { event, startMinutes, endMinutes }
}

/** Union of the intervals, so two conflicting meetings do not bill the same hour twice. */
export function busyMinutes(intervals: Array<{ startMinutes: number; endMinutes: number }>): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a.startMinutes - b.startMinutes)
  let total = 0
  let from = sorted[0].startMinutes
  let to = sorted[0].endMinutes
  for (const cur of sorted.slice(1)) {
    if (cur.startMinutes > to) {
      total += to - from
      from = cur.startMinutes
      to = cur.endMinutes
    } else if (cur.endMinutes > to) {
      to = cur.endMinutes
    }
  }
  return total + (to - from)
}

function eventHeight(durationMinutes: number, compact: boolean): number {
  const scale = compact ? PX_PER_MINUTE_COMPACT : PX_PER_MINUTE
  return Math.max(MIN_EVENT_PX, Math.round(durationMinutes * scale))
}

function gapRow(startMinutes: number, endMinutes: number): TimelineRow {
  return {
    kind: 'gap',
    startMinutes,
    endMinutes,
    label: `${formatDuration(endMinutes - startMinutes)} FREE`,
    heightPx: GAP_BAND_PX,
  }
}

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

export function buildTimeline(
  events: CalendarEvent[],
  now: Date,
  opts: TimelineOptions = {},
): TimelineLayout {
  const compact = opts.compact === true
  const live = events.filter((e) => !e.isCancelled)

  // All-day events render as a header band above the timeline. They are never rows and
  // never count as booked time — "Katja vakantie" is someone else's holiday (PRD §17.9).
  const allDay = live.filter((e) => e.isAllDay)

  let placed = live.filter((e) => !e.isAllDay).map(place)
  placed.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes)

  if (placed.length === 0) return { ...EMPTY, allDay }

  // `now` only participates when it falls on the day being drawn.
  const dayKey = toDateKey(new Date(placed[0].event.start))
  const nowApplies = toDateKey(now) === dayKey
  const nowMinutes = nowApplies ? minutesSinceMidnight(now) : -1

  // Board mode removes what is already over rather than dimming it.
  if (opts.nowOnward && nowApplies) {
    placed = placed.filter((p) => p.endMinutes > nowMinutes)
    if (placed.length === 0) return { ...EMPTY, allDay }
  }

  let rangeStart = Math.max(0, placed[0].startMinutes - DAY_PADDING_MINUTES)
  const lastEnd = placed.reduce((max, p) => Math.max(max, p.endMinutes), 0)
  const rangeEnd = Math.min(MINUTES_PER_DAY, lastEnd + DAY_PADDING_MINUTES)

  // Nothing before now is drawn on the wall monitor, padding included.
  if (opts.nowOnward && nowApplies && nowMinutes > rangeStart) {
    rangeStart = Math.min(nowMinutes, placed[0].startMinutes)
  }

  const showNow = nowApplies && nowMinutes >= rangeStart && nowMinutes <= rangeEnd
  const nowRow: TimelineRow = {
    kind: 'now',
    atMinutes: nowMinutes,
    label: `NOW ${formatTime(now)}`,
  }

  const rows: TimelineRow[] = []
  let nowEmitted = false

  const emitNowAtOrBefore = (minute: number): void => {
    if (showNow && !nowEmitted && nowMinutes <= minute) {
      rows.push(nowRow)
      nowEmitted = true
    }
  }

  const pushGap = (from: number, to: number): void => {
    const span = to - from
    if (span <= 0) return
    // Mobile absorbs short gaps into spacing rather than spending a labelled band on them.
    if (compact && span < COMPACT_GAP_ABSORB_MINUTES) return
    rows.push(gapRow(from, to))
  }

  /** A gap, split around `now` when now falls inside it, each half absorbed on its own merits. */
  const emitGap = (from: number, to: number): void => {
    if (to <= from) return
    if (showNow && !nowEmitted && nowMinutes > from && nowMinutes < to) {
      pushGap(from, nowMinutes)
      rows.push(nowRow)
      nowEmitted = true
      pushGap(nowMinutes, to)
      return
    }
    emitNowAtOrBefore(from)
    pushGap(from, to)
  }

  let cursor = rangeStart

  for (const p of placed) {
    emitGap(cursor, p.startMinutes)

    const isNow = nowApplies && nowMinutes >= p.startMinutes && nowMinutes < p.endMinutes
    if (isNow && showNow && !nowEmitted) {
      // The rule sits directly above the meeting it is inside; the card carries `isNow`.
      rows.push(nowRow)
      nowEmitted = true
    } else {
      emitNowAtOrBefore(Math.max(cursor, p.startMinutes))
    }

    rows.push({
      kind: 'event',
      event: p.event,
      heightPx: eventHeight(p.endMinutes - p.startMinutes, compact),
      isPast: nowApplies && p.endMinutes <= nowMinutes,
      isNow,
    })

    cursor = Math.max(cursor, p.endMinutes)
  }

  emitGap(cursor, rangeEnd)
  emitNowAtOrBefore(rangeEnd)

  const bookedMinutes = busyMinutes(placed)
  const freeMinutes = Math.max(0, rangeEnd - rangeStart - bookedMinutes)

  return { allDay, rows, bookedMinutes, freeMinutes }
}

/** The frame the timeline drew, for callers that need it (scroll maths, tests). */
export function timelineRange(rows: TimelineRow[]): { startMinutes: number; endMinutes: number } | null {
  let start: number | null = null
  let end: number | null = null
  for (const row of rows) {
    if (row.kind === 'now') continue
    const from = row.kind === 'gap' ? row.startMinutes : minutesSinceMidnight(new Date(row.event.start))
    const to = row.kind === 'gap' ? row.endMinutes : minutesSinceMidnight(new Date(row.event.end))
    start = start === null ? from : Math.min(start, from)
    end = end === null ? to : Math.max(end, to)
  }
  return start === null || end === null ? null : { startMinutes: start, endMinutes: end }
}
