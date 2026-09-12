/**
 * State rules — which list an issue belongs to.
 *
 * Pure functions over {@link LinearIssue}. The one rule worth reading twice is in
 * {@link dueThisWeek}: the state always wins over the date (PRD §17.3).
 */

import { daysBetween } from '../time'
import {
  COMMITTED_STATES,
  UNCOMMITTED_STATES,
  type LinearIssue,
  type ProvenanceLabel,
  type TaskState,
} from '../types'

/** Checked in order, so an issue carrying both labels reports `Email`. */
const PROVENANCE_LABELS: readonly ProvenanceLabel[] = ['Email', 'Transcript']

function stateOf(input: LinearIssue | TaskState): TaskState {
  return typeof input === 'string' ? input : input.state
}

/** In Progress, Waiting, Planned — work that answers "what do I do". */
export function isCommitted(input: LinearIssue | TaskState): boolean {
  return COMMITTED_STATES.includes(stateOf(input))
}

/** Ready, Inbox — work that answers "what have I not decided yet". */
export function isUncommitted(input: LinearIssue | TaskState): boolean {
  return UNCOMMITTED_STATES.includes(stateOf(input))
}

/**
 * The Due this week list, soonest first.
 *
 * **Committed states only.** A due date on a `Ready` issue does *not* promote it here —
 * `Ready` means "not planned yet" and the state always wins (PRD §17.3). RW-339 is the
 * live example: `Ready`, 51 days overdue, and still it belongs in Needs planning.
 *
 * `weekDateKeys` is Monday–Friday (`weekdaysOf`). When `todayKey` falls inside that week,
 * committed items already overdue are included too: an overdue commitment is still owed
 * this week, and dropping it because its date sits in July would hide the loudest item on
 * the board. For a week that is not the current one, only dates inside the week qualify.
 */
export function dueThisWeek(
  issues: LinearIssue[],
  weekDateKeys: string[],
  todayKey: string,
): LinearIssue[] {
  const week = new Set(weekDateKeys)
  const isCurrentWeek = week.has(todayKey)

  const picked = issues.filter((issue) => {
    if (!isCommitted(issue)) return false
    if (!issue.dueDate) return false
    if (week.has(issue.dueDate)) return true
    return isCurrentWeek && daysBetween(issue.dueDate, todayKey) < 0
  })

  return stableSort(picked, (a, b) => daysBetween(a.dueDate as string, b.dueDate as string))
}

/**
 * The Needs planning list: Ready first, then Inbox, each group in input order.
 *
 * Ready leads because it is a decision you have already half-made; Inbox is raw intake
 * nobody has looked at yet and carries the `*NEW` marker (PRD §6).
 */
export function needsPlanning(issues: LinearIssue[]): LinearIssue[] {
  return [
    ...issues.filter((issue) => issue.state === 'Ready'),
    ...issues.filter((issue) => issue.state === 'Inbox'),
  ]
}

/** Inbox items are machine-extracted and never seen by a human — the `*NEW` marker. */
export function isNew(issue: LinearIssue): boolean {
  return issue.state === 'Inbox'
}

/**
 * Where a machine-extracted issue came from, from its labels (PRD §17.6).
 *
 * Structured and free, rather than asking a model. Labels span states, so this marks
 * origin, not status.
 */
export function provenanceOf(issue: LinearIssue): ProvenanceLabel | null {
  for (const label of PROVENANCE_LABELS) {
    if (issue.labels.includes(label)) return label
  }
  return null
}

/** `Array.prototype.sort` is stable in modern engines; this makes the guarantee explicit. */
function stableSort<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compare(a.item, b.item) || a.index - b.index)
    .map((entry) => entry.item)
}
