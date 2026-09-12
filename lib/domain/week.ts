import { dayRange, WEEKDAY_LABELS, weekdaysOf } from '../time'
import type { CalendarEvent, DayLoad } from '../types'
import { busyMinutes } from './timeline'
import { dayShape, isContainer, type Interval } from './shape'

/**
 * The week zone (PRD §7).
 *
 * Five bars, Monday to Friday, each the share of an eight-hour day already committed.
 * All-day events are excluded exactly as they are from the timeline — a colleague's
 * holiday is not eight hours of your own load (PRD §17.9).
 */

/** A nominal working day. Deliberately not configurable in v1. */
export const WORKDAY_MINUTES = 480
/** Above this share the bar takes the warning hue — the only colour in the zone. */
export const HEAVY_THRESHOLD = 0.7

/**
 * Booked minutes for one calendar day.
 *
 * Clamped to the day's own boundaries, so a meeting straddling midnight (or a multi-day
 * block filed under every day it touches) can never bill more than 24 hours to one bar.
 * Overlapping meetings are counted as a union, not summed.
 *
 * Framing blocks are excluded (PRD §17.9, round 4). *Vrij houden* and *Niet beschikbaar*
 * between them cover eight and a half hours of a Wednesday, which read as a day booked
 * solid when the truth is a protected morning holding two half-hour meetings.
 */
export function bookedMinutesForDay(dateKey: string, events: CalendarEvent[]): number {
  const { start, end } = dayRange(dateKey)
  const dayStart = start.getTime()
  const dayEnd = end.getTime()
  const offwork = dayShape(events, dateKey).offwork

  const intervals = events
    .filter((e) => !e.isAllDay && !e.isCancelled && !isContainer(e))
    .map((e) => {
      const from = Math.max(dayStart, new Date(e.start).getTime())
      const to = Math.min(dayEnd, new Date(e.end).getTime())
      return {
        startMinutes: Math.round((from - dayStart) / 60_000),
        endMinutes: Math.round((to - dayStart) / 60_000),
      }
    })
    // Numerator and denominator have to agree about which hours exist. A 14:00 commitment
    // on a Wednesday is real, shows on the timeline and is not working load — billing its
    // two and a half hours against a four-hour morning it does not touch read as a day
    // nearly two-thirds full when the morning was entirely free.
    .flatMap((i) => subtract(i, offwork))
    .filter((i) => i.endMinutes > i.startMinutes)

  return busyMinutes(intervals)
}

/** `interval` with every off-work stretch cut out of it; may yield none, one or two pieces. */
function subtract(
  interval: { startMinutes: number; endMinutes: number },
  offwork: Interval[],
): Array<{ startMinutes: number; endMinutes: number }> {
  let pieces = [interval]
  for (const block of offwork) {
    const next: typeof pieces = []
    for (const piece of pieces) {
      if (block.end <= piece.startMinutes || block.start >= piece.endMinutes) {
        next.push(piece)
        continue
      }
      if (block.start > piece.startMinutes) {
        next.push({ startMinutes: piece.startMinutes, endMinutes: block.start })
      }
      if (block.end < piece.endMinutes) {
        next.push({ startMinutes: block.end, endMinutes: piece.endMinutes })
      }
    }
    pieces = next
  }
  return pieces
}

/**
 * Monday–Friday load for the week containing `todayKey`.
 *
 * `eventsByDay` is keyed by `YYYY-MM-DD`; a missing or absent day simply reads as empty
 * rather than throwing, so a partial Graph response degrades to an honest zero bar.
 */
export function buildWeekLoad(
  eventsByDay: Record<string, CalendarEvent[]>,
  todayKey: string,
): DayLoad[] {
  return weekdaysOf(todayKey).map((date, i) => {
    const events = eventsByDay[date] ?? []
    const booked = bookedMinutesForDay(date, events)
    // A day with its afternoon blocked off is a four-hour day, and two half-hour meetings
    // fill a quarter of it. Measured against a notional eight they would read as a
    // sixteenth — technically a smaller number, and a materially less true one.
    const workdayMinutes = dayShape(events, date).availableMinutes
    return {
      label: WEEKDAY_LABELS[i],
      date,
      bookedMinutes: booked,
      workdayMinutes,
      isToday: date === todayKey,
      // A day with no working time left cannot be heavy; it is simply not a working day.
      isHeavy: workdayMinutes > 0 && booked / workdayMinutes > HEAVY_THRESHOLD,
    }
  })
}
