import { formatDuration, formatTime, minutesSinceMidnight, toDateKey } from '../time'
import {
  NOMINAL_WORKDAY_MINUTES,
  containedBy,
  covers,
  dayShape,
  type DayShape,
  type Interval,
} from './shape'
import type { CalendarEvent, GapTone, TimelineLayout, TimelineRow } from '../types'

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
  /**
   * The day being drawn. Only needed when it might not be the day `now` falls on — a date
   * override (PRD §17.14) or an empty day, where the events cannot supply it themselves.
   */
  dateKey?: string
}

interface Placed {
  event: CalendarEvent
  startMinutes: number
  endMinutes: number
}

const EMPTY: TimelineLayout = {
  allDay: [],
  rows: [],
  bookedMinutes: 0,
  freeMinutes: 0,
  availableMinutes: NOMINAL_WORKDAY_MINUTES,
}

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

/**
 * The label an empty band carries.
 *
 * `4H FREE` is the default and the only one the timeline used to know. A band lying wholly
 * inside the protected morning says `4H KEPT CLEAR` instead — the time is empty either way,
 * but "free" invites a booking and this time was deliberately not for booking. A band
 * inside non-work hours says so plainly rather than advertising itself as capacity.
 */
function gapLabel(minutes: number, tone: GapTone): string {
  const span = formatDuration(minutes)
  if (tone === 'clear') return `${span} KEPT CLEAR`
  if (tone === 'offwork') return `${span} OUTSIDE HOURS`
  return `${span} FREE`
}

function gapRow(startMinutes: number, endMinutes: number, tone: GapTone = 'free'): TimelineRow {
  return {
    kind: 'gap',
    startMinutes,
    endMinutes,
    label: gapLabel(endMinutes - startMinutes, tone),
    heightPx: GAP_BAND_PX,
    tone,
  }
}

/** Which frame, if any, an empty stretch falls inside. Non-work wins a tie; it says more. */
function toneFor(start: number, end: number, shape: DayShape): GapTone {
  if (containedBy(start, end, shape.offwork)) return 'offwork'
  if (containedBy(start, end, shape.focus)) return 'clear'
  return 'free'
}

/**
 * Cuts `[from, to)` at every frame edge it crosses.
 *
 * Returns the pieces in order; a stretch inside one frame, or inside none, comes back
 * whole. Cheap because a day carries at most a handful of frames.
 */
function splitOnFrames(from: number, to: number, shape: DayShape): Interval[] {
  const edges = new Set<number>([from, to])
  for (const block of [...shape.focus, ...shape.offwork]) {
    if (block.start > from && block.start < to) edges.add(block.start)
    if (block.end > from && block.end < to) edges.add(block.end)
  }
  const points = [...edges].sort((a, b) => a - b)
  const out: Interval[] = []
  for (let i = 0; i < points.length - 1; i++) out.push({ start: points[i], end: points[i + 1] })
  return out
}

/**
 * The window the day is drawn inside.
 *
 * Real events set it, padded either side as they always have. **Protected time extends
 * it**: a morning kept clear is part of the working day whether or not anything landed in
 * it, and clipping the band to the meetings inside it would turn four deliberate hours
 * into three disconnected slivers.
 *
 * Non-work time never extends it. The day stops where work stops — unless something real
 * is scheduled inside the non-work block, in which case that event extends the window on
 * its own merits and draws marked as out of hours. That is the asymmetry the user asked
 * for: the *Niet beschikbaar* block itself is not shown, but what someone put inside it is.
 */
function frameRange(
  placed: Placed[],
  shape: DayShape,
  fromMinute: number,
): { start: number; end: number } | null {
  const bounds: Interval[] = placed.map((p) => ({
    start: Math.max(0, p.startMinutes - DAY_PADDING_MINUTES),
    end: Math.min(MINUTES_PER_DAY, p.endMinutes + DAY_PADDING_MINUTES),
  }))

  for (const block of shape.focus) {
    // On the wall monitor a protected block that is already over is not worth a band.
    if (fromMinute >= 0 && block.end <= fromMinute) continue
    bounds.push(block)
  }

  if (bounds.length === 0) return null
  return {
    start: bounds.reduce((min, b) => Math.min(min, b.start), MINUTES_PER_DAY),
    end: bounds.reduce((max, b) => Math.max(max, b.end), 0),
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

  // The day being drawn. Taken from the caller when it is known, because a date override
  // can ask for a day with nothing on it, and an empty day has no event to infer it from.
  const dayKey =
    opts.dateKey ??
    (live.find((e) => !e.isAllDay)
      ? toDateKey(new Date(live.find((e) => !e.isAllDay)!.start))
      : toDateKey(now))

  // Framing blocks leave the rows here: they are the shape of the day, not entries in it.
  const shape = dayShape(live, dayKey)
  const empty: TimelineLayout = { ...EMPTY, allDay, availableMinutes: shape.availableMinutes }

  let placed = shape.events.filter((e) => !e.isAllDay).map(place)
  placed.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes)

  // A day holding nothing but its own frame still has a frame worth drawing — a protected
  // morning reads as four hours kept clear, which is not the same thing as an empty day.
  if (placed.length === 0 && shape.focus.length === 0) return empty

  // `now` only participates when it falls on the day being drawn.
  const nowApplies = toDateKey(now) === dayKey
  const nowMinutes = nowApplies ? minutesSinceMidnight(now) : -1

  // Board mode removes what is already over rather than dimming it.
  if (opts.nowOnward && nowApplies) {
    placed = placed.filter((p) => p.endMinutes > nowMinutes)
    if (placed.length === 0 && !shape.focus.some((f) => f.end > nowMinutes)) return empty
  }

  const frame = frameRange(placed, shape, opts.nowOnward === true && nowApplies ? nowMinutes : -1)
  if (!frame) return empty

  let rangeStart = frame.start
  const rangeEnd = frame.end

  // Nothing before now is drawn on the wall monitor, padding included.
  if (opts.nowOnward && nowApplies && nowMinutes > rangeStart) {
    rangeStart = Math.min(nowMinutes, placed[0]?.startMinutes ?? nowMinutes)
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
    // A stretch spanning a frame boundary is split, so neither half is mislabelled: the
    // hour before 13:00 is kept clear, the hour after it is outside working hours, and one
    // band claiming to be both would be wrong about half of itself.
    for (const piece of splitOnFrames(from, to, shape)) {
      rows.push(gapRow(piece.start, piece.end, toneFor(piece.start, piece.end, shape)))
    }
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
      // Real, and showing — but it starts in time the calendar says is not working time.
      ...(covers(p.startMinutes, shape.offwork) ? { outsideHours: true } : {}),
    })

    cursor = Math.max(cursor, p.endMinutes)
  }

  emitGap(cursor, rangeEnd)
  emitNowAtOrBefore(rangeEnd)

  const bookedMinutes = busyMinutes(placed)
  const freeMinutes = Math.max(0, rangeEnd - rangeStart - bookedMinutes)

  return { allDay, rows, bookedMinutes, freeMinutes, availableMinutes: shape.availableMinutes }
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
