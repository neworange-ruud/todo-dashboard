import type { AttentionItem, CalendarEvent, LinearIssue } from '../types'
import { daysBetween, formatTime } from '../time'
import { isContainer } from './shape'

/**
 * The attention strip (PRD §9).
 *
 * Appears only for things that are **true, actionable and time-bound**, and names them
 * in full. Never a badge, never a count, never a red dot: "a count with no name is
 * anxiety with no information."
 *
 * The strip is absent — taking zero height — when nothing qualifies, and most days
 * nothing does. Adding a rule here is expensive: every false positive trains the reader
 * to ignore the one that matters.
 */

/** An issue this far past its due date is flagged regardless of state. */
export const BADLY_OVERDUE_DAYS = 7

/** Double-bookings are only actionable if they are close enough to do something about. */
export const CONFLICT_HORIZON_HOURS = 4

export const MAX_ITEMS = 3

export interface AttentionContext {
  issues: LinearIssue[]
  events: CalendarEvent[]
  todayKey: string
  now: Date
  /**
   * How far ahead of `now` a conflict still counts. Defaults to
   * {@link CONFLICT_HORIZON_HOURS}.
   *
   * Widened to a whole day when the dashboard is previewing another date (PRD §17.14):
   * there, `now` is that day's midnight and the question is no longer "what is about to
   * go wrong" but "what already looks wrong about that day".
   */
  horizonHours?: number
}

function overlaps(a: CalendarEvent, b: CalendarEvent): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)
}

/**
 * Double-bookings starting within the horizon.
 *
 * All-day events are excluded: a colleague's holiday overlapping your morning is not a
 * conflict, and on a real calendar it would fire every single day.
 *
 * Framing blocks are excluded for the same reason and more urgently. *Vrij houden* spans
 * the whole Wednesday morning, so every meeting held in that morning overlapped it and the
 * strip announced a double-booking for each one — a rule that fires every week is a rule
 * the reader learns to skip, which is exactly what §9 warns this zone must never become.
 */
export function findConflicts(
  events: CalendarEvent[],
  now: Date,
  horizonHours: number = CONFLICT_HORIZON_HOURS,
): Array<[CalendarEvent, CalendarEvent]> {
  const horizon = now.getTime() + horizonHours * 3600_000
  const candidates = events
    .filter((e) => !e.isAllDay && !e.isCancelled && !isContainer(e))
    .filter((e) => Date.parse(e.end) > now.getTime() && Date.parse(e.start) <= horizon)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))

  const pairs: Array<[CalendarEvent, CalendarEvent]> = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (overlaps(candidates[i], candidates[j])) pairs.push([candidates[i], candidates[j]])
    }
  }
  return pairs
}

/** Issues more than {@link BADLY_OVERDUE_DAYS} past due, worst first. */
export function findBadlyOverdue(issues: LinearIssue[], todayKey: string): LinearIssue[] {
  return issues
    .filter((i) => i.dueDate !== null)
    .map((i) => ({ issue: i, over: -daysBetween(i.dueDate!, todayKey) }))
    .filter((x) => x.over > BADLY_OVERDUE_DAYS)
    .sort((a, b) => b.over - a.over)
    .map((x) => x.issue)
}

/**
 * Builds the strip. Returns an empty array when nothing qualifies — the caller renders
 * nothing at all rather than an empty container.
 *
 * Ordered by how much the reader can still do about it: conflicts (minutes away) before
 * blocking work (today) before rot (weeks old).
 */
export function buildAttention(ctx: AttentionContext): AttentionItem[] {
  const items: AttentionItem[] = []

  for (const [a, b] of findConflicts(ctx.events, ctx.now, ctx.horizonHours)) {
    items.push({
      text: `You are double-booked at ${formatTime(a.start)} — ${a.subject} and ${b.subject}.`,
      href: `?drill=meeting:${encodeURIComponent(a.id)}`,
    })
  }

  // Something you own is blocking someone else and is overdue.
  for (const issue of ctx.issues) {
    if (!issue.hasRelations || !issue.dueDate) continue
    const over = -daysBetween(issue.dueDate, ctx.todayKey)
    if (over <= 0) continue
    items.push({
      text: `${issue.identifier} is ${over} ${over === 1 ? 'day' : 'days'} overdue and is blocking someone else.`,
      href: `?drill=issue:${encodeURIComponent(issue.identifier)}`,
    })
  }

  for (const issue of findBadlyOverdue(ctx.issues, ctx.todayKey)) {
    // Already reported above as a blocking item.
    if (items.some((i) => i.text.startsWith(issue.identifier))) continue
    const over = -daysBetween(issue.dueDate!, ctx.todayKey)
    items.push({
      text: `${issue.identifier} is ${over} days past its due date — ${issue.title}`,
      href: `?drill=issue:${encodeURIComponent(issue.identifier)}`,
    })
  }

  if (items.length <= MAX_ITEMS) return items

  // A fourth collapses into "and N more" rather than growing the strip (PRD §9).
  const shown = items.slice(0, MAX_ITEMS)
  const rest = items.length - MAX_ITEMS
  shown.push({ text: `and ${rest} more`, href: '?drill=attention' })
  return shown
}
