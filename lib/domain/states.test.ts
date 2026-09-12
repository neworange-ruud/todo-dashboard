import { describe, expect, it, vi } from 'vitest'

// `lib/config` (reached via `lib/time`) is a server module. Vitest runs outside the
// React Server Components graph, so the marker package has to be neutralised here.
vi.mock('server-only', () => ({}))

import type { LinearIssue, TaskState } from '../types'
import { dueThisWeek, isCommitted, isNew, isUncommitted, needsPlanning, provenanceOf } from './states'

// Week of Monday 7 — Friday 11 September 2026, the week of the board audit (PRD §16).
const WEEK = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']
const TODAY = '2026-09-09' // Wednesday

function issue(partial: Partial<LinearIssue> & { identifier: string; state: TaskState }): LinearIssue {
  return {
    title: 'Untitled',
    dueDate: null,
    priority: 0,
    labels: [],
    url: `https://linear.app/rw/issue/${partial.identifier}`,
    hasRelations: false,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...partial,
  }
}

describe('isCommitted / isUncommitted', () => {
  it('treats In Progress, Waiting and Planned as committed', () => {
    for (const state of ['In Progress', 'Waiting', 'Planned'] as TaskState[]) {
      expect(isCommitted(issue({ identifier: 'RW-1', state }))).toBe(true)
      expect(isUncommitted(issue({ identifier: 'RW-1', state }))).toBe(false)
    }
  })

  it('treats Ready and Inbox as uncommitted', () => {
    for (const state of ['Ready', 'Inbox'] as TaskState[]) {
      expect(isUncommitted(issue({ identifier: 'RW-1', state }))).toBe(true)
      expect(isCommitted(issue({ identifier: 'RW-1', state }))).toBe(false)
    }
  })

  it('accepts a bare state as well as an issue', () => {
    expect(isCommitted('Waiting')).toBe(true)
    expect(isUncommitted('Inbox')).toBe(true)
  })
})

describe('dueThisWeek', () => {
  it('NEVER promotes a Ready issue, however loud its due date (PRD §17.3)', () => {
    // RW-339: Ready, due 2026-07-22, 49 days over on the Wednesday of the audit week.
    // The state always wins — Ready means "not planned yet", so it stays in Needs planning.
    const rw339 = issue({ identifier: 'RW-339', state: 'Ready', dueDate: '2026-07-22' })
    const readyInsideWeek = issue({ identifier: 'RW-340', state: 'Ready', dueDate: '2026-09-10' })
    const planned = issue({ identifier: 'RW-341', state: 'Planned', dueDate: '2026-09-10' })

    const result = dueThisWeek([rw339, readyInsideWeek, planned], WEEK, TODAY)

    expect(result.map((i) => i.identifier)).toEqual(['RW-341'])
  })

  it('never includes Inbox items either', () => {
    const inbox = issue({ identifier: 'RW-350', state: 'Inbox', dueDate: '2026-09-10' })
    expect(dueThisWeek([inbox], WEEK, TODAY)).toEqual([])
  })

  it('sorts soonest first', () => {
    const issues = [
      issue({ identifier: 'RW-3', state: 'Planned', dueDate: '2026-09-11' }),
      issue({ identifier: 'RW-1', state: 'In Progress', dueDate: '2026-09-07' }),
      issue({ identifier: 'RW-2', state: 'Waiting', dueDate: '2026-09-09' }),
    ]

    expect(dueThisWeek(issues, WEEK, TODAY).map((i) => i.identifier)).toEqual([
      'RW-1',
      'RW-2',
      'RW-3',
    ])
  })

  it('keeps input order for issues sharing a due date', () => {
    const issues = [
      issue({ identifier: 'RW-b', state: 'Planned', dueDate: '2026-09-10' }),
      issue({ identifier: 'RW-a', state: 'In Progress', dueDate: '2026-09-10' }),
    ]

    expect(dueThisWeek(issues, WEEK, TODAY).map((i) => i.identifier)).toEqual(['RW-b', 'RW-a'])
  })

  it('drops committed issues with no due date', () => {
    const undated = issue({ identifier: 'RW-4', state: 'In Progress', dueDate: null })
    expect(dueThisWeek([undated], WEEK, TODAY)).toEqual([])
  })

  it('drops due dates beyond the week', () => {
    const nextMonday = issue({ identifier: 'RW-5', state: 'Planned', dueDate: '2026-09-14' })
    const weekend = issue({ identifier: 'RW-6', state: 'Planned', dueDate: '2026-09-12' })
    expect(dueThisWeek([nextMonday, weekend], WEEK, TODAY)).toEqual([])
  })

  it('keeps overdue commitments in the current week, ahead of everything else', () => {
    const overdue = issue({ identifier: 'RW-7', state: 'In Progress', dueDate: '2026-07-22' })
    const dueFriday = issue({ identifier: 'RW-8', state: 'Planned', dueDate: '2026-09-11' })

    expect(dueThisWeek([dueFriday, overdue], WEEK, TODAY).map((i) => i.identifier)).toEqual([
      'RW-7',
      'RW-8',
    ])
  })

  it('does not drag overdue items into a week that is not the current one', () => {
    const overdue = issue({ identifier: 'RW-7', state: 'In Progress', dueDate: '2026-07-22' })
    const nextWeek = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']

    expect(dueThisWeek([overdue], nextWeek, TODAY)).toEqual([])
  })

  it('returns nothing for an empty board', () => {
    expect(dueThisWeek([], WEEK, TODAY)).toEqual([])
  })
})

describe('needsPlanning', () => {
  it('lists Ready before Inbox and keeps each group in input order', () => {
    const issues = [
      issue({ identifier: 'RW-inbox-1', state: 'Inbox' }),
      issue({ identifier: 'RW-ready-1', state: 'Ready' }),
      issue({ identifier: 'RW-progress', state: 'In Progress' }),
      issue({ identifier: 'RW-inbox-2', state: 'Inbox' }),
      issue({ identifier: 'RW-ready-2', state: 'Ready' }),
      issue({ identifier: 'RW-planned', state: 'Planned' }),
      issue({ identifier: 'RW-waiting', state: 'Waiting' }),
    ]

    expect(needsPlanning(issues).map((i) => i.identifier)).toEqual([
      'RW-ready-1',
      'RW-ready-2',
      'RW-inbox-1',
      'RW-inbox-2',
    ])
  })

  it('includes a Ready issue that carries a due date — this is its only list', () => {
    const rw339 = issue({ identifier: 'RW-339', state: 'Ready', dueDate: '2026-07-22' })
    expect(needsPlanning([rw339]).map((i) => i.identifier)).toEqual(['RW-339'])
  })

  it('returns nothing for an empty board', () => {
    expect(needsPlanning([])).toEqual([])
  })
})

describe('isNew', () => {
  it('marks Inbox items and nothing else', () => {
    expect(isNew(issue({ identifier: 'RW-1', state: 'Inbox' }))).toBe(true)
    expect(isNew(issue({ identifier: 'RW-2', state: 'Ready' }))).toBe(false)
    expect(isNew(issue({ identifier: 'RW-3', state: 'In Progress' }))).toBe(false)
  })
})

describe('provenanceOf', () => {
  it('reads the Email and Transcript labels', () => {
    expect(provenanceOf(issue({ identifier: 'RW-1', state: 'Inbox', labels: ['Email'] }))).toBe(
      'Email',
    )
    expect(
      provenanceOf(issue({ identifier: 'RW-2', state: 'Inbox', labels: ['Transcript'] })),
    ).toBe('Transcript')
  })

  it('ignores topic labels', () => {
    const topical = issue({
      identifier: 'RW-3',
      state: 'Ready',
      labels: ['Technische richting en architectuur'],
    })
    expect(provenanceOf(topical)).toBeNull()
  })

  it('prefers Email when an issue carries both', () => {
    const both = issue({ identifier: 'RW-4', state: 'Inbox', labels: ['Transcript', 'Email'] })
    expect(provenanceOf(both)).toBe('Email')
  })
})
