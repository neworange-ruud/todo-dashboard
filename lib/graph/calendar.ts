import 'server-only'
import { getOrFetch } from '../cache'
import { GRAPH_USER_PRINCIPAL_NAME, TTL } from '../config'
import { dayRange, parts, toDateKey } from '../time'
import type { Attendee, CalendarEvent } from '../types'
import { graphGet, type FetchLike } from './client'

/**
 * Calendar reads (PRD §17.8, §17.9).
 *
 * SECURITY — the single-identity rule. The Graph credential can read any mailbox in the
 * tenant, so the mailbox is fixed here and nowhere else: every function below takes a
 * *date range* and never an identity. {@link GRAPH_USER_PRINCIPAL_NAME} is a compile-time
 * constant; it is never a parameter, never read from the environment, and never derived
 * from request input. `calendar.test.ts` asserts this against every outgoing URL.
 */

const SELECT = [
  'id',
  'subject',
  'start',
  'end',
  'location',
  'organizer',
  'attendees',
  'isAllDay',
  'isCancelled',
  'webLink',
].join(',')

/** Graph caps `$top` at 1000; a day or a working week never comes close to 100. */
const PAGE_SIZE = 100

// ---------------------------------------------------------------------------
// Wire shapes — only the fields we `$select`.
// ---------------------------------------------------------------------------

interface GraphDateTime {
  dateTime?: string | null
  timeZone?: string | null
}

interface GraphEmailAddress {
  address?: string | null
  name?: string | null
}

interface GraphAttendee {
  emailAddress?: GraphEmailAddress | null
}

interface GraphEvent {
  id?: string | null
  subject?: string | null
  start?: GraphDateTime | null
  end?: GraphDateTime | null
  location?: { displayName?: string | null } | null
  organizer?: GraphAttendee | null
  attendees?: GraphAttendee[] | null
  isAllDay?: boolean | null
  isCancelled?: boolean | null
  webLink?: string | null
}

interface GraphCollection<T> {
  value?: T[] | null
}

// ---------------------------------------------------------------------------
// URL construction — the only place a UPN enters a request.
// ---------------------------------------------------------------------------

/**
 * The `calendarView` path for a range.
 *
 * Exported for the security test. Note the absent `user` parameter: that absence *is* the
 * mitigation described in PRD §17.8.
 */
export function calendarViewPath(start: Date, end: Date): string {
  const query = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    $select: SELECT,
    $orderby: 'start/dateTime',
    $top: String(PAGE_SIZE),
  })
  return `/users/${GRAPH_USER_PRINCIPAL_NAME}/calendarView?${query.toString()}`
}

// ---------------------------------------------------------------------------
// Time mapping
// ---------------------------------------------------------------------------

const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, '0')
}

/** The UTC instant at which the given Europe/Amsterdam wall-clock occurs. */
function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const seen = parts(new Date(guess))
  const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, second)
  // How far ahead of UTC the zone is at that instant.
  return new Date(guess - (seenUtc - guess))
}

/**
 * Render an instant as an ISO string carrying Amsterdam's offset, e.g.
 * `2026-09-11T09:00:00+02:00`.
 *
 * `lib/types.ts` asks for "ISO 8601 in Europe/Amsterdam": an offset-bearing string is both
 * unambiguous to `new Date()` and readable as the wall-clock Outlook shows. A bare local
 * string would be re-parsed in the *runtime's* zone, which is exactly the bug PRD §17.4 rules out.
 */
function toZonedIso(instant: Date): string {
  const p = parts(instant)
  const seconds = instant.getUTCSeconds()
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, seconds)
  const offsetMinutes = Math.round((asUtc - instant.getTime()) / 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const offset = `${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(seconds)}${offset}`
  )
}

/**
 * Graph's `{ dateTime, timeZone }` pair to an offset-bearing ISO string.
 *
 * We send `Prefer: outlook.timezone="Europe/Amsterdam"`, so `timeZone` is normally the
 * tenant echo of that. A bare wall-clock is therefore read as Amsterdam local; `UTC` is
 * honoured when Graph ignores the header. All-day events are *always* read as local
 * midnight — a UTC reading would shunt them onto the neighbouring day (PRD §17.9).
 */
export function graphDateTimeToIso(dt: GraphDateTime | null | undefined, isAllDay = false): string | null {
  const raw = dt?.dateTime?.trim()
  if (!raw) return null

  if (!isAllDay && OFFSET_RE.test(raw)) return toZonedIso(new Date(raw))

  const m = WALL_CLOCK_RE.exec(raw)
  if (!m) {
    const fallback = new Date(raw)
    return Number.isNaN(fallback.getTime()) ? null : toZonedIso(fallback)
  }

  const [, y, mo, d, h, mi, s] = m
  const zone = dt?.timeZone?.trim().toUpperCase()
  if (!isAllDay && (zone === 'UTC' || zone === 'GMT' || zone === 'GMT STANDARD TIME')) {
    return toZonedIso(new Date(`${m[0]}Z`))
  }
  // Any other `timeZone` value (e.g. a Windows id) is read as the zone we asked for in the
  // `Prefer` header — guessing at Windows ids would be worse than trusting our own request.
  return toZonedIso(
    wallClockToInstant(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s ?? 0)),
  )
}

// ---------------------------------------------------------------------------
// Attendee mapping
// ---------------------------------------------------------------------------

function toAttendee(raw: GraphAttendee | null | undefined, isOrganizer: boolean): Attendee | null {
  const email = raw?.emailAddress?.address?.trim()
  if (!email) return null
  const name = raw?.emailAddress?.name?.trim()
  return { email, name: name && name.length > 0 ? name : null, isOrganizer }
}

/**
 * Organizer folded into the attendee list, deduped by lowercased address.
 *
 * The organizer leads, and an attendee entry for the same person keeps the organizer flag
 * rather than producing two rows for one human. Zero-attendee personal blocks (*Tandarts*,
 * *Claude remote* — PRD §17.9) come back as an empty array, never a crash.
 */
export function foldAttendees(
  organizer: Attendee | null,
  raw: GraphAttendee[] | null | undefined,
): Attendee[] {
  const out: Attendee[] = []
  const seen = new Set<string>()

  if (organizer) {
    out.push(organizer)
    seen.add(organizer.email.toLowerCase())
  }

  for (const entry of raw ?? []) {
    const attendee = toAttendee(entry, false)
    if (!attendee) continue
    const key = attendee.email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(attendee)
  }

  return out
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

export function mapEvent(raw: GraphEvent): CalendarEvent | null {
  const isAllDay = raw.isAllDay === true
  const start = graphDateTimeToIso(raw.start, isAllDay)
  const end = graphDateTimeToIso(raw.end, isAllDay)
  if (!raw.id || !start || !end) return null

  const organizer = toAttendee(raw.organizer, true)
  const location = raw.location?.displayName?.trim()

  return {
    id: raw.id,
    subject: raw.subject?.trim() || '(no subject)',
    start,
    end,
    isAllDay,
    isCancelled: raw.isCancelled === true,
    location: location && location.length > 0 ? location : null,
    organizer,
    attendees: foldAttendees(organizer, raw.attendees),
    webLink: raw.webLink ?? null,
  }
}

/** Map, drop cancelled meetings and anything unmappable, then order by start. */
export function mapEvents(raw: GraphEvent[] | null | undefined): CalendarEvent[] {
  return (raw ?? [])
    .map(mapEvent)
    .filter((e): e is CalendarEvent => e !== null && !e.isCancelled)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
}

// ---------------------------------------------------------------------------
// Fetchers — a date range in, never a person
// ---------------------------------------------------------------------------

async function fetchRange(start: Date, end: Date, fetchImpl?: FetchLike): Promise<CalendarEvent[]> {
  const res = await graphGet<GraphCollection<GraphEvent>>(
    calendarViewPath(start, end),
    fetchImpl ?? fetch,
  )
  return mapEvents(res.value)
}

/** Every event on `dateKey` (`YYYY-MM-DD`), cached for {@link TTL.graph}. */
export async function fetchEventsForDay(
  dateKey: string,
  fetchImpl?: FetchLike,
): Promise<CalendarEvent[]> {
  return getOrFetch(`graph:events:day:${dateKey}`, TTL.graph, () => {
    const { start, end } = dayRange(dateKey)
    return fetchRange(start, end, fetchImpl)
  })
}

/**
 * Events for a set of days, bucketed by date key.
 *
 * One `calendarView` call spans the whole range rather than five — Graph charges per
 * request and a working week fits comfortably inside one page. An event is filed under
 * every requested day it overlaps, so a meeting that straddles midnight shows on both.
 */
export async function fetchEventsForWeek(
  dateKeys: string[],
  fetchImpl?: FetchLike,
): Promise<Record<string, CalendarEvent[]>> {
  const keys = [...dateKeys].sort()
  const empty: Record<string, CalendarEvent[]> = {}
  for (const key of keys) empty[key] = []
  if (keys.length === 0) return empty

  const start = dayRange(keys[0]).start
  const end = dayRange(keys[keys.length - 1]).end

  const events = await getOrFetch(
    `graph:events:week:${keys[0]}:${keys[keys.length - 1]}`,
    TTL.graph,
    () => fetchRange(start, end, fetchImpl),
  )

  return bucketByDay(events, keys)
}

/** File each event under every requested day it overlaps. */
export function bucketByDay(
  events: CalendarEvent[],
  dateKeys: string[],
): Record<string, CalendarEvent[]> {
  const out: Record<string, CalendarEvent[]> = {}
  for (const key of dateKeys) out[key] = []

  const bounds = dateKeys.map((key) => {
    const { start, end } = dayRange(key)
    return { key, from: start.getTime(), to: end.getTime() }
  })

  for (const event of events) {
    const from = new Date(event.start).getTime()
    const to = new Date(event.end).getTime()

    for (const day of bounds) {
      // Half-open overlap, with zero-length events (all-day 00:00-00:00) treated as present.
      const overlaps = from < day.to && (to > day.from || (to === from && from >= day.from))
      if (overlaps) out[day.key].push(event)
    }
  }

  return out
}

/** The date key an event belongs to by its start instant. */
export function eventDateKey(event: CalendarEvent): string {
  return toDateKey(new Date(event.start))
}
