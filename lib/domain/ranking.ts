/**
 * The top-five ranking (PRD §17.2).
 *
 * Four of the six ranking inputs in §6 are dead on the real board — no cycles, no
 * estimates, one issue relation, 21 of 22 issues at priority 0 (PRD §16.3). What
 * survives is: overdue, due, meeting-linked, the `Waiting` state, the In Progress
 * tiebreak, and priority as a weak last resort. This module implements exactly that
 * and nothing it cannot evidence.
 *
 * Scoring is banded rather than blended. Each band is separated by more than the sum of
 * every modifier (see {@link SCORING}), so a later due date can never out-rank an
 * earlier one — the modifiers only ever settle ties. That is what "priority is a
 * tiebreaker, not a driver" has to mean numerically.
 */

import { daysBetween, dueLabel } from '../time'
import type { LinearIssue, RankSignal, RankedTask, ReasonClause, TaskState } from '../types'

/** A meeting today that this issue was matched to (round 2, answer 5d). */
export interface MeetingLink {
  eventId: string
  eventSubject: string
}

export interface RankContext {
  /** `YYYY-MM-DD` in Europe/Amsterdam. */
  todayKey: string
  /** Keyed by issue identifier, e.g. `"RW-339"`. */
  meetingLinks?: Map<string, MeetingLink>
}

/**
 * Only committed, *explainable* work is ranked.
 *
 * `Ready` and `Inbox` are excluded by design: they carry no commitment, so any reason
 * line written for them would be invented — and §6 rests on never showing a ranking
 * without a reason beside it.
 */
const RANKABLE_STATES: readonly TaskState[] = ['In Progress', 'Waiting', 'Planned']

// --- Bands. One "day" of spacing is 1000, comfortably above MAX_MODIFIER. ---------
const BAND_OVERDUE = 100_000
const BAND_DUE_TODAY = 90_000
const BAND_DUE_THIS_WEEK = 80_000
const BAND_DUE_LATER = 40_000
const BAND_UNDATED = 0

const PER_DAY_OVERDUE = 1_000
const PER_DAY_THIS_WEEK = 1_000
const PER_DAY_LATER = 10
/** Beyond a year, further days stop mattering — and keep the bands from colliding. */
const DAY_CAP = 365
/** Inclusive upper bound, in days, of "due this week". */
const THIS_WEEK_DAYS = 7

// --- Modifiers. Their sum is smaller than one day of band spacing. ---------------
const MOD_MEETING = 500
const MOD_BLOCKED = 300
const MOD_IN_PROGRESS = 100
/** Linear priority 1 (Urgent) … 4 (Low) → 4 … 1. Priority 0 (unset) contributes nothing. */
const MOD_PRIORITY_MAX = 4
/**
 * The load-bearing invariant: every modifier added together is still worth less than a
 * single day of due-date spacing. That is what makes "priority is a tiebreaker, not a
 * driver" true numerically rather than merely intended. `ranking.test.ts` asserts it.
 */
export const SCORING = {
  maxModifier: MOD_MEETING + MOD_BLOCKED + MOD_IN_PROGRESS + MOD_PRIORITY_MAX,
  perDayOverdue: PER_DAY_OVERDUE,
  perDayThisWeek: PER_DAY_THIS_WEEK,
} as const

const PRIORITY_NAMES: Record<number, string> = {
  1: 'marked urgent',
  2: 'marked high priority',
  3: 'marked medium priority',
  4: 'marked low priority',
}

const WEEKDAY_NAMES: Record<string, string> = {
  SUN: 'Sunday',
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
  SAT: 'Saturday',
}

/**
 * Ranks committed work, strongest first.
 *
 * Returns every rankable issue — the caller takes the first five (PRD §6); the rest fill
 * the list beneath. Deterministic: equal scores preserve input order.
 */
export function rankTasks(issues: LinearIssue[], ctx: RankContext): RankedTask[] {
  const scored = issues
    .filter((issue) => RANKABLE_STATES.includes(issue.state))
    .map((issue, index) => {
      const signals = signalsFor(issue, ctx)
      return { issue, index, signals, score: scoreOf(signals) }
    })

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry, position) => ({
      issue: entry.issue,
      rank: position + 1,
      signals: entry.signals,
      reason: reasonFor(entry.signals, entry.issue, ctx),
    }))
}

/**
 * The signals that fired, strongest first.
 *
 * The order here is the weight order of PRD §17.2, so the reason line reads strongest
 * clause first without any further sorting.
 */
export function signalsFor(issue: LinearIssue, ctx: RankContext): RankSignal[] {
  const signals: RankSignal[] = []

  if (issue.dueDate) {
    const daysUntil = daysBetween(issue.dueDate, ctx.todayKey)
    if (daysUntil < 0) signals.push({ kind: 'overdue', daysOver: -daysUntil })
    else signals.push({ kind: 'due', daysUntil })
  }

  const meeting = ctx.meetingLinks?.get(issue.identifier)
  if (meeting) {
    signals.push({
      kind: 'meeting-linked',
      eventId: meeting.eventId,
      eventSubject: meeting.eventSubject,
    })
  }

  // `Waiting` is the board's only usable blocked signal — issue relations are effectively
  // dead (1 on the whole board), so the state carries the meaning instead (PRD §17.2.4).
  if (issue.state === 'Waiting') signals.push({ kind: 'blocked' })
  if (issue.state === 'In Progress') signals.push({ kind: 'in-progress' })
  if (issue.priority > 0) signals.push({ kind: 'priority', value: issue.priority })

  return signals
}

function scoreOf(signals: RankSignal[]): number {
  let score = BAND_UNDATED

  for (const signal of signals) {
    switch (signal.kind) {
      case 'overdue':
        score += BAND_OVERDUE + Math.min(signal.daysOver, DAY_CAP) * PER_DAY_OVERDUE
        break
      case 'due':
        score += dueScore(signal.daysUntil)
        break
      case 'meeting-linked':
        score += MOD_MEETING
        break
      case 'blocked':
        score += MOD_BLOCKED
        break
      case 'in-progress':
        score += MOD_IN_PROGRESS
        break
      case 'priority':
        score += Math.max(0, MOD_PRIORITY_MAX + 1 - signal.value)
        break
    }
  }

  return score
}

function dueScore(daysUntil: number): number {
  if (daysUntil === 0) return BAND_DUE_TODAY
  if (daysUntil <= THIS_WEEK_DAYS) return BAND_DUE_THIS_WEEK - daysUntil * PER_DAY_THIS_WEEK
  return BAND_DUE_LATER - Math.min(daysUntil, DAY_CAP) * PER_DAY_LATER
}

/**
 * The default reason line, built from Linear fields alone.
 *
 * The model replaces this with an Omni-sourced clause where it can ("Marieke asked for
 * this on Tuesday"), but the fallback must always be true and always be present — an
 * item with no reason does not belong in the five (PRD §6, §17.2).
 */
/** Meeting subjects are free text and often long; a reason clause has to stay one line. */
export function shortSubject(subject: string, max = 34): string {
  const clean = subject.replace(/\s*--\s.*$/, '').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

export function reasonFor(
  signals: RankSignal[],
  issue: LinearIssue,
  ctx: RankContext,
): ReasonClause {
  const clauses = signals
    .map((signal) => clauseFor(signal, issue, ctx))
    .filter((clause): clause is string => clause !== null)
  if (clauses.length > 0) return { text: clauses.join(' · ') }
  // Only reachable for an undated, unprioritised Planned issue with no meeting link.
  return { text: 'no due date set' }
}

function clauseFor(signal: RankSignal, issue: LinearIssue, ctx: RankContext): string | null {
  switch (signal.kind) {
    case 'overdue':
      return `${signal.daysOver} ${signal.daysOver === 1 ? 'day' : 'days'} over`
    case 'due':
      return dueClause(signal.daysUntil, issue, ctx)
    case 'meeting-linked':
      // Real calendar subjects run long ("Vervolg meeting plannen Marc & Nikola --
      // vooraf toesturen monitoren/changes/bitwarden"). The reason line is one clause
      // on one line, so trim at a word boundary rather than wrapping the row.
      return `blocking today's ${shortSubject(signal.eventSubject)}`
    case 'blocked':
      return 'blocked by someone else'
    case 'in-progress':
      return 'already started'
    case 'priority':
      return PRIORITY_NAMES[signal.value] ?? null
  }
}

/**
 * Human phrasing for a future due date, reusing {@link dueLabel} so the reason line and
 * the trailing lane can never drift apart in their reading of the same date.
 */
function dueClause(daysUntil: number, issue: LinearIssue, ctx: RankContext): string {
  if (daysUntil === 0) return 'due today'
  if (daysUntil === 1) return 'due tomorrow'
  const label = issue.dueDate ? dueLabel(issue.dueDate, ctx.todayKey) : ''
  const named = WEEKDAY_NAMES[label]
  return named ? `due ${named}` : `due in ${daysUntil} days`
}
