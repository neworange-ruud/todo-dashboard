import { dayRange } from '../time'
import type { CalendarEvent } from '../types'

/**
 * The shape of a working day (PRD §17.9, round 4).
 *
 * Two events on Ruud's calendar are not meetings at all — they are the frame the day is
 * drawn inside, recurring every Wednesday and carrying nobody but their own organiser:
 *
 *   09:00–13:00  *Vrij houden (geen meetings plannen zonder te overleggen)*
 *   13:00–17:30  *Niet beschikbaar*
 *
 * The first is **protected working time**: the work happens, the meetings do not. The
 * second is **outside working hours**. Read as ordinary meetings — which is what every
 * zone did before this module existed — they bill eight and a half hours of load to a day
 * with two half-hour meetings in it, draw as two walls down the timeline, and make every
 * real Wednesday meeting read as a double-booking against the block it sits inside.
 *
 * The rule that matters most is the one about what is *inside* them. A container frames
 * time; it never claims it. Anything else scheduled in either window is genuine and shows
 * exactly as it would on any other day — the 10:00 check-in inside the focus block is a
 * real meeting, and *Oma Ada haalt kids op* at 14:00 inside the non-work block is a real
 * commitment. Only the frame itself is demoted.
 *
 * Classification is by subject and solitude, never by weekday. The meaning belongs to the
 * block, not to Wednesday: if either one is ever moved to a Friday it should carry its
 * meaning with it, and a genuine meeting that happens to be *called* "Niet beschikbaar"
 * has other people in it and stays a meeting.
 */

export type EventKind = 'meeting' | 'focus' | 'offwork'

/**
 * Subject prefixes identifying the two containers, already normalised by
 * {@link normaliseSubject}.
 *
 * Matched as prefixes because the focus block carries its rationale in a parenthetical
 * that is free to be reworded — *"(geen meetings plannen zonder te overleggen)"* is a note
 * to colleagues, not an identifier.
 */
export const FOCUS_SUBJECTS: readonly string[] = ['vrij houden']
export const OFFWORK_SUBJECTS: readonly string[] = ['niet beschikbaar']

/**
 * The most attendees a container may carry.
 *
 * Graph reports these blocks with an empty attendee list, and `foldAttendees` then folds
 * the organiser in, so a solo block arrives holding exactly one person. Two or more means
 * somebody was invited, and being invited is what makes a meeting a meeting. Stated as a
 * count rather than as "only Ruud" deliberately: the single-identity constant lives in
 * server-only config (PRD §17.8), and this module is reachable from the client bundle.
 */
export const MAX_CONTAINER_ATTENDEES = 1

const MINUTES_PER_DAY = 1440

/** A nominal working day, before non-work time is taken out of it (PRD §7). */
export const NOMINAL_WORKDAY_MINUTES = 480

/**
 * A reference window, 09:00–17:00, used for **one purpose only**: measuring how much of
 * the nominal day a non-work block actually removes.
 *
 * This is not office hours and nothing else may read it. PRD §5 frames the timeline by
 * the day's own contents and §7 declines to fix a working window, both deliberately. But
 * "eight hours" is a length with no position, and you cannot subtract a 13:00–17:30 block
 * from a length — the overlap has to be measured against *something*. Anchoring that one
 * subtraction here keeps the arithmetic honest (a blocked Wednesday afternoon leaves the
 * four-hour morning, not an arbitrary 210 minutes) and keeps the anchor from leaking into
 * layout, where it would be wrong.
 */
const CAPACITY_REFERENCE: Interval = { start: 9 * 60, end: 17 * 60 }

/** Lowercase, unaccented, punctuation-free, single-spaced. */
export function normaliseSubject(subject: string): string {
  return subject
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function matchesAny(subject: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => subject.startsWith(prefix))
}

/**
 * What kind of thing this event is.
 *
 * All-day events are never containers: a colleague's holiday already has its own handling
 * as a header band (PRD §17.9) and must not start rewriting the length of the workday.
 */
export function classifyEvent(event: CalendarEvent): EventKind {
  if (event.isAllDay) return 'meeting'
  if (event.attendees.length > MAX_CONTAINER_ATTENDEES) return 'meeting'
  const subject = normaliseSubject(event.subject)
  if (matchesAny(subject, FOCUS_SUBJECTS)) return 'focus'
  if (matchesAny(subject, OFFWORK_SUBJECTS)) return 'offwork'
  return 'meeting'
}

/** Whether this event frames the day rather than filling it. */
export function isContainer(event: CalendarEvent): boolean {
  return classifyEvent(event) !== 'meeting'
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

/** Minutes since local midnight on the day being shaped. Half-open: `[start, end)`. */
export interface Interval {
  start: number
  end: number
}

/**
 * An event's footprint on one calendar day, in minutes since that day's local midnight.
 *
 * Clamped to the day, so a block running past midnight contributes only the part that
 * lands here, and returns null when it does not touch the day at all.
 */
export function intervalOn(event: CalendarEvent, dateKey: string): Interval | null {
  const { start: dayStart, end: dayEnd } = dayRange(dateKey)
  const from = Math.max(dayStart.getTime(), Date.parse(event.start))
  const to = Math.min(dayEnd.getTime(), Date.parse(event.end))
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  return {
    start: Math.round((from - dayStart.getTime()) / 60_000),
    end: Math.min(MINUTES_PER_DAY, Math.round((to - dayStart.getTime()) / 60_000)),
  }
}

/** Merged, ordered union of the intervals — overlapping frames count their span once. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Interval[] = [{ ...sorted[0] }]
  for (const next of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (next.start <= last.end) last.end = Math.max(last.end, next.end)
    else out.push({ ...next })
  }
  return out
}

/** Whether `[start, end)` lies wholly inside one of the intervals. */
export function containedBy(start: number, end: number, intervals: Interval[]): boolean {
  return intervals.some((i) => start >= i.start && end <= i.end)
}

/** Whether a single minute falls inside one of the intervals. */
export function covers(minute: number, intervals: Interval[]): boolean {
  return intervals.some((i) => minute >= i.start && minute < i.end)
}

/** Total minutes the intervals cover, counting overlaps once. */
export function spanOf(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce((total, i) => total + (i.end - i.start), 0)
}

// ---------------------------------------------------------------------------
// dayShape
// ---------------------------------------------------------------------------

export interface DayShape {
  /** Protected working time — work happens here, meetings do not. */
  focus: Interval[]
  /** Outside working hours. */
  offwork: Interval[]
  /** The framing events themselves, kept so a caller can name or link them. */
  containers: CalendarEvent[]
  /** Everything genuinely on the calendar, containers removed. */
  events: CalendarEvent[]
  /**
   * The nominal workday less whatever the non-work blocks take out of it.
   *
   * This is what a load bar should be measured against: a Wednesday with its afternoon
   * blocked is a four-hour day, and two half-hour meetings fill a quarter of it, not a
   * sixteenth of a notional eight.
   */
  availableMinutes: number
}

const EMPTY_SHAPE: DayShape = {
  focus: [],
  offwork: [],
  containers: [],
  events: [],
  availableMinutes: NOMINAL_WORKDAY_MINUTES,
}

/**
 * Splits a day's events into the frame and the contents.
 *
 * Cancelled events are dropped here so every caller sees the same day. The available
 * minutes shrink only for non-work time: focus time is working time and stays in the
 * denominator, which is the whole reason a protected morning with two meetings in it
 * reads as a quarter full rather than as free.
 */
export function dayShape(events: CalendarEvent[], dateKey: string): DayShape {
  const live = events.filter((e) => !e.isCancelled)
  if (live.length === 0) return { ...EMPTY_SHAPE }

  const focus: Interval[] = []
  const offwork: Interval[] = []
  const containers: CalendarEvent[] = []
  const rest: CalendarEvent[] = []

  for (const event of live) {
    const kind = classifyEvent(event)
    if (kind === 'meeting') {
      rest.push(event)
      continue
    }
    containers.push(event)
    const interval = intervalOn(event, dateKey)
    if (!interval) continue
    if (kind === 'focus') focus.push(interval)
    else offwork.push(interval)
  }

  const merged = mergeIntervals(offwork)

  return {
    focus: mergeIntervals(focus),
    offwork: merged,
    containers,
    events: rest,
    availableMinutes: availableMinutesFor(merged),
  }
}

/**
 * The workday that survives the non-work blocks.
 *
 * Only the part of a block that overlaps {@link CAPACITY_REFERENCE} is taken out, so a
 * 13:00–17:30 Wednesday block removes four hours and leaves the four-hour morning, while
 * a block that runs into the evening removes only the part of itself that was ever
 * working time. A day blocked outright leaves zero, and a bar measured against zero reads
 * as a day off rather than as infinite load (see `buildWeekLoad`).
 */
export function availableMinutesFor(offwork: Interval[]): number {
  const removed = mergeIntervals(offwork).reduce((total, i) => {
    const from = Math.max(i.start, CAPACITY_REFERENCE.start)
    const to = Math.min(i.end, CAPACITY_REFERENCE.end)
    return total + Math.max(0, to - from)
  }, 0)
  return Math.max(0, NOMINAL_WORKDAY_MINUTES - removed)
}
