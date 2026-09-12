import { dayRange, WEEKDAY_LABELS, weekdaysOf } from '../time'
import type { CalendarEvent, DayLoad } from '../types'
import { busyMinutes } from './timeline'

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
 */
export function bookedMinutesForDay(dateKey: string, events: CalendarEvent[]): number {
  const { start, end } = dayRange(dateKey)
  const dayStart = start.getTime()
  const dayEnd = end.getTime()

  const intervals = events
    .filter((e) => !e.isAllDay && !e.isCancelled)
    .map((e) => {
      const from = Math.max(dayStart, new Date(e.start).getTime())
      const to = Math.min(dayEnd, new Date(e.end).getTime())
      return {
        startMinutes: Math.round((from - dayStart) / 60_000),
        endMinutes: Math.round((to - dayStart) / 60_000),
      }
    })
    .filter((i) => i.endMinutes > i.startMinutes)

  return busyMinutes(intervals)
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
    const booked = bookedMinutesForDay(date, eventsByDay[date] ?? [])
    return {
      label: WEEKDAY_LABELS[i],
      date,
      bookedMinutes: booked,
      workdayMinutes: WORKDAY_MINUTES,
      isToday: date === todayKey,
      isHeavy: booked / WORKDAY_MINUTES > HEAVY_THRESHOLD,
    }
  })
}
