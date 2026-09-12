// Imported from constants, not config: this module must stay usable in a client bundle.
import { TIMEZONE } from './constants'

/**
 * Time utilities, fixed to Europe/Amsterdam (PRD §17.4).
 *
 * The timezone is a constant, never read from the client. All arithmetic goes through
 * `Intl` so DST transitions are handled by the platform rather than by hand.
 */

/** Wall-clock parts of `date` as observed in Europe/Amsterdam. */
export function parts(date: Date): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
} {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  })
  const f: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) f[p.type] = p.value
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    year: Number(f.year),
    month: Number(f.month),
    day: Number(f.day),
    // Intl renders midnight as "24" in some locales; normalise to 0.
    hour: Number(f.hour) % 24,
    minute: Number(f.minute),
    weekday: weekdays.indexOf(f.weekday),
  }
}

/** Local calendar date as `YYYY-MM-DD`. */
export function toDateKey(date: Date): string {
  const p = parts(date)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Minutes since local midnight. */
export function minutesSinceMidnight(date: Date): number {
  const p = parts(date)
  return p.hour * 60 + p.minute
}

/**
 * The UTC instant of local midnight starting `dateKey`.
 *
 * Found by probing the offset rather than assuming one, so it is correct on the two
 * days a year the offset changes.
 */
export function startOfLocalDay(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  // Start from the UTC guess, then correct by the observed offset.
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0))
  const p = parts(guess)
  const observed = p.hour * 60 + p.minute
  const corrected = new Date(guess.getTime() - observed * 60_000)
  // One more pass catches a DST boundary crossed by the correction itself.
  const p2 = parts(corrected)
  if (p2.day !== d) {
    const delta = (p2.hour * 60 + p2.minute) - (p2.day < d ? -1440 : 1440)
    return new Date(corrected.getTime() - delta * 60_000)
  }
  const off = p2.hour * 60 + p2.minute
  return off === 0 ? corrected : new Date(corrected.getTime() - off * 60_000)
}

/** Day boundaries for `dateKey`. "Today" rolls over at midnight (round 2, answer 4). */
export function dayRange(dateKey: string): { start: Date; end: Date } {
  const start = startOfLocalDay(dateKey)
  const next = new Date(start.getTime() + 26 * 3600_000)
  return { start, end: startOfLocalDay(toDateKey(next)) }
}

/** Monday–Friday of the week containing `dateKey`. */
export function weekdaysOf(dateKey: string): string[] {
  const start = startOfLocalDay(dateKey)
  const dow = parts(start).weekday // 0 = Sunday
  const offsetToMonday = dow === 0 ? -6 : 1 - dow
  const monday = new Date(start.getTime() + offsetToMonday * 24 * 3600_000)
  return Array.from({ length: 5 }, (_, i) =>
    toDateKey(new Date(monday.getTime() + i * 24 * 3600_000 + 12 * 3600_000)),
  )
}

export const WEEKDAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const

/** Saturday or Sunday in Europe/Amsterdam. */
export function isWeekend(date: Date): boolean {
  const dow = parts(date).weekday // 0 = Sunday
  return dow === 0 || dow === 6
}

/** Time-of-day window driving the sentence's register (PRD §4). */
export function sentenceWindow(now: Date): 'morning' | 'midday' | 'evening' {
  const h = parts(now).hour
  if (h < 11) return 'morning'
  if (h < 16) return 'midday'
  return 'evening'
}

/** `HH:MM` in local time. */
export function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const p = parts(d)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/**
 * Three-letter months, fixed by hand.
 *
 * `Intl`'s own `month: 'short'` renders September as **"Sept"** in en-GB. That breaks the
 * alignment of a column of mono source labels, and — worse — it put "10 Sept" directly
 * beside a "↗ …, 11 Sep" citation in the same drill-in panel. One list, two spellings of
 * the same month, is the kind of detail that makes a careful page look careless.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const dayMonthParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
})

/**
 * `"28 Aug"`, or `"30 Oct 2025"` once it is not the current year.
 *
 * The year is not decoration: a task's *Meetings* block routinely lists something from
 * eleven months ago beside something from last week, and "30 Oct" alone reads as next
 * month. Returns null for anything unparseable, so a caller can omit the stamp entirely
 * rather than print a placeholder.
 */
export function formatDayMonth(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return null
  const f: Record<string, string> = {}
  for (const part of dayMonthParts.formatToParts(new Date(parsed))) f[part.type] = part.value
  const month = MONTHS[Number(f.month) - 1] ?? f.month
  const stamp = `${Number(f.day)} ${month}`
  return f.year === String(parts(now).year) ? stamp : `${stamp} ${f.year}`
}

/** Compact duration: "45M", "1H 15M", "2H". */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h === 0) return `${rem}M`
  if (rem === 0) return `${h}H`
  return `${h}H ${rem}M`
}

/** "2m ago", "1h ago" — for the sync marker. */
export function formatRelative(from: Date | number, now: Date = new Date()): string {
  const ms = now.getTime() - (typeof from === 'number' ? from : from.getTime())
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// The date override (PRD §17.14)
// ---------------------------------------------------------------------------

/**
 * How far either side of today the dashboard will look.
 *
 * Wide enough to answer "what does Monday look like" and to check back over a quarter,
 * narrow enough that a typo or a crawler cannot send the calendar fetcher somewhere
 * expensive and meaningless.
 */
export const VIEW_DATE_RANGE_DAYS = 180

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export interface ViewDate {
  /** The day the dashboard is drawing, `YYYY-MM-DD`. */
  key: string
  /** True when that day is really today — the only case where "now" means anything. */
  isToday: boolean
}

/** `dateKey` shifted by whole days, keeping to local midnights across a DST boundary. */
export function addDays(dateKey: string, days: number): string {
  // Noon, so a 23- or 25-hour day cannot round the arithmetic onto a neighbour.
  const at = startOfLocalDay(dateKey).getTime() + days * 86_400_000 + 12 * 3600_000
  return toDateKey(new Date(at))
}

/**
 * Reads the `?date=` parameter (PRD §17.14).
 *
 * Accepts a plain `YYYY-MM-DD`, the words *today* / *tomorrow* / *yesterday*, a weekday
 * name resolving to the next such day (or today, when today is that day), and a signed
 * day offset like `+3` or `-1`.
 *
 * **Anything it cannot read becomes today.** A dashboard is judged on its bad days (PRD
 * §9): a mistyped link should open on the live day, never on an error page and never on
 * some silently invented date. The caller is told which day it landed on, and the bar says
 * so out loud whenever that is not today.
 */
export function resolveViewDate(param: string | null | undefined, now: Date = new Date()): ViewDate {
  const todayKey = toDateKey(now)
  const key = parseViewDate(param, todayKey)
  return { key, isToday: key === todayKey }
}

function parseViewDate(param: string | null | undefined, todayKey: string): string {
  const raw = param?.trim().toLowerCase()
  if (!raw || raw === 'today') return todayKey

  if (raw === 'tomorrow') return addDays(todayKey, 1)
  if (raw === 'yesterday') return addDays(todayKey, -1)

  const offset = /^([+-]\d{1,3})$/.exec(raw)
  if (offset) return clampToRange(addDays(todayKey, Number(offset[1])), todayKey)

  const weekday = WEEKDAY_NAMES.indexOf(raw)
  if (weekday >= 0) {
    const current = parts(startOfLocalDay(todayKey)).weekday
    // "Monday" on a Monday means today, not a week from now — you are asking about the
    // day you named, and the nearest one you can still do something about is this one.
    return addDays(todayKey, (weekday - current + 7) % 7)
  }

  const explicit = DATE_KEY_RE.exec(raw)
  if (explicit) {
    const [, y, m, d] = explicit
    // Round-trips through the calendar, so 2026-02-31 is rejected rather than rolled over.
    const candidate = `${y}-${m}-${d}`
    if (toDateKey(startOfLocalDay(candidate)) !== candidate) return todayKey
    return clampToRange(candidate, todayKey)
  }

  return todayKey
}

function clampToRange(candidate: string, todayKey: string): string {
  const delta = daysBetween(candidate, todayKey)
  return Math.abs(delta) > VIEW_DATE_RANGE_DAYS ? todayKey : candidate
}

/** Whole days between two `YYYY-MM-DD` keys. Negative when `a` is before `b`. */
export function daysBetween(a: string, b: string): number {
  const ms = startOfLocalDay(a).getTime() - startOfLocalDay(b).getTime()
  return Math.round(ms / 86_400_000)
}

/** Day label for a due date relative to today: "TODAY", "THU", "3 DAYS OVER". */
export function dueLabel(dueDate: string, todayKey: string): string {
  const delta = daysBetween(dueDate, todayKey)
  if (delta === 0) return 'TODAY'
  if (delta < 0) return `${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'DAY' : 'DAYS'} OVER`
  if (delta === 1) return 'TOMORROW'
  if (delta <= 6) {
    const d = startOfLocalDay(dueDate)
    return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][parts(d).weekday]
  }
  return dueDate
}
