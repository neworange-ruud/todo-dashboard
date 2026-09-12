import { describe, expect, it, vi } from 'vitest'

// `lib/config` (reached via `lib/time`) is a server module. Vitest runs outside the
// React Server Components graph, so the marker package has to be neutralised here.
vi.mock('server-only', () => ({}))

import type { LinearIssue, TaskState } from '../types'
import { SCORING, rankTasks, type MeetingLink, type RankContext , shortSubject } from './ranking'

/** Friday 11 September 2026 — the day of the board audit (PRD §16). */
const TODAY = '2026-09-11'
const ctx: RankContext = { todayKey: TODAY }

function issue(partial: Partial<LinearIssue> & { identifier: string; state: TaskState }): LinearIssue {
  return {
    title: 'Untitled',
    dueDate: null,
    description: null,
    priority: 0,
    labels: [],
    url: `https://linear.app/rw/issue/${partial.identifier}`,
    hasRelations: false,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...partial,
  }
}

function order(issues: LinearIssue[], context: RankContext = ctx): string[] {
  return rankTasks(issues, context).map((task) => task.issue.identifier)
}

function links(entries: Record<string, MeetingLink>): Map<string, MeetingLink> {
  return new Map(Object.entries(entries))
}

describe('rankTasks — due dates dominate', () => {
  it('puts overdue above due today', () => {
    const overdue = issue({ identifier: 'RW-over', state: 'Planned', dueDate: '2026-09-10' })
    const today = issue({ identifier: 'RW-today', state: 'Planned', dueDate: TODAY })

    expect(order([today, overdue])).toEqual(['RW-over', 'RW-today'])
  })

  it('puts due today above due later this week', () => {
    const today = issue({ identifier: 'RW-today', state: 'Planned', dueDate: TODAY })
    const monday = issue({ identifier: 'RW-mon', state: 'Planned', dueDate: '2026-09-14' })

    expect(order([monday, today])).toEqual(['RW-today', 'RW-mon'])
  })

  it('puts due this week above due beyond the week', () => {
    const thisWeek = issue({ identifier: 'RW-soon', state: 'Planned', dueDate: '2026-09-16' })
    const later = issue({ identifier: 'RW-later', state: 'Planned', dueDate: '2026-10-30' })

    expect(order([later, thisWeek])).toEqual(['RW-soon', 'RW-later'])
  })

  it('ranks the most overdue hardest — RW-339 at 51 days over leads the board', () => {
    const rw339 = issue({ identifier: 'RW-339', state: 'In Progress', dueDate: '2026-07-22' })
    const barelyOver = issue({ identifier: 'RW-1', state: 'In Progress', dueDate: '2026-09-10' })
    const weekOver = issue({ identifier: 'RW-2', state: 'In Progress', dueDate: '2026-09-04' })

    expect(order([barelyOver, weekOver, rw339])).toEqual(['RW-339', 'RW-2', 'RW-1'])
    expect(rankTasks([rw339], ctx)[0].signals).toEqual([
      { kind: 'overdue', daysOver: 51 },
      { kind: 'in-progress' },
    ])
  })

  it('sinks undated items below every dated one, whatever else they carry', () => {
    const loudButUndated = issue({
      identifier: 'RW-undated',
      state: 'Waiting',
      dueDate: null,
      description: null,
      priority: 1,
    })
    const distantlyDated = issue({
      identifier: 'RW-dated',
      state: 'Planned',
      dueDate: '2027-08-01',
    })

    const context: RankContext = {
      todayKey: TODAY,
      meetingLinks: links({ 'RW-undated': { eventId: 'evt-1', eventSubject: 'sync' } }),
    }

    expect(order([loudButUndated, distantlyDated], context)).toEqual(['RW-dated', 'RW-undated'])
  })
})

describe('rankTasks — the softer signals', () => {
  it('surfaces Waiting: blocked by someone else lifts an otherwise equal item', () => {
    const waiting = issue({ identifier: 'RW-wait', state: 'Planned', dueDate: '2026-09-14' })
    const blocked = issue({ identifier: 'RW-blocked', state: 'Waiting', dueDate: '2026-09-14' })

    const ranked = rankTasks([waiting, blocked], ctx)
    expect(ranked[0].issue.identifier).toBe('RW-blocked')
    expect(ranked[0].signals).toContainEqual({ kind: 'blocked' })
    expect(ranked[0].reason.text).toContain('blocked by someone else')
  })

  it('lets In Progress beat Planned at an equal due date', () => {
    const planned = issue({ identifier: 'RW-planned', state: 'Planned', dueDate: '2026-09-14' })
    const started = issue({ identifier: 'RW-started', state: 'In Progress', dueDate: '2026-09-14' })

    expect(order([planned, started])).toEqual(['RW-started', 'RW-planned'])
  })

  it('does not let In Progress beat an earlier due date', () => {
    const startedLater = issue({ identifier: 'RW-started', state: 'In Progress', dueDate: '2026-09-15' })
    const plannedSooner = issue({ identifier: 'RW-planned', state: 'Planned', dueDate: '2026-09-14' })

    expect(order([startedLater, plannedSooner])).toEqual(['RW-planned', 'RW-started'])
  })

  it('lifts a meeting-linked item above an identical unlinked one', () => {
    const linked = issue({ identifier: 'RW-linked', state: 'Planned', dueDate: '2026-09-14' })
    const plain = issue({ identifier: 'RW-plain', state: 'Planned', dueDate: '2026-09-14' })

    const context: RankContext = {
      todayKey: TODAY,
      meetingLinks: links({ 'RW-linked': { eventId: 'evt-9', eventSubject: 'Acme sync' } }),
    }

    expect(order([plain, linked], context)).toEqual(['RW-linked', 'RW-plain'])
  })

  it('never lets a meeting link override an earlier due date', () => {
    const linkedLater = issue({ identifier: 'RW-linked', state: 'Planned', dueDate: '2026-09-16' })
    const plainSooner = issue({ identifier: 'RW-plain', state: 'Planned', dueDate: '2026-09-14' })

    const context: RankContext = {
      todayKey: TODAY,
      meetingLinks: links({ 'RW-linked': { eventId: 'evt-9', eventSubject: 'Acme sync' } }),
    }

    expect(order([linkedLater, plainSooner], context)).toEqual(['RW-plain', 'RW-linked'])
  })
})

describe('rankTasks — priority is a tiebreaker, not a driver', () => {
  it('breaks an otherwise identical pair', () => {
    const urgent = issue({
      identifier: 'RW-urgent',
      state: 'Planned',
      dueDate: '2026-09-14',
      description: null,
      priority: 1,
    })
    const unset = issue({ identifier: 'RW-unset', state: 'Planned', dueDate: '2026-09-14' })

    expect(order([unset, urgent])).toEqual(['RW-urgent', 'RW-unset'])
  })

  it('orders set priorities by urgency', () => {
    const low = issue({ identifier: 'RW-low', state: 'Planned', dueDate: '2026-09-14', priority: 4 })
    const high = issue({ identifier: 'RW-high', state: 'Planned', dueDate: '2026-09-14', priority: 2 })

    expect(order([low, high])).toEqual(['RW-high', 'RW-low'])
  })

  it('cannot outrank a sooner due date, a meeting link, Waiting or In Progress', () => {
    const urgentButLater = issue({
      identifier: 'RW-urgent',
      state: 'Planned',
      dueDate: '2026-09-15',
      description: null,
      priority: 1,
    })
    const dueSooner = issue({ identifier: 'RW-sooner', state: 'Planned', dueDate: '2026-09-14' })
    const startedSameDay = issue({
      identifier: 'RW-started',
      state: 'In Progress',
      dueDate: '2026-09-15',
    })

    expect(order([urgentButLater, dueSooner, startedSameDay])).toEqual([
      'RW-sooner',
      'RW-started',
      'RW-urgent',
    ])
  })
})

describe('the scoring invariant', () => {
  it('keeps every modifier combined below one day of due-date spacing', () => {
    expect(SCORING.maxModifier).toBeLessThan(SCORING.perDayThisWeek)
    expect(SCORING.maxModifier).toBeLessThan(SCORING.perDayOverdue)
  })
})

describe('rankTasks — what it refuses to rank', () => {
  it('NEVER ranks Ready or Inbox, however overdue (PRD §17.3)', () => {
    const rw339 = issue({ identifier: 'RW-339', state: 'Ready', dueDate: '2026-07-22' })
    const inbox = issue({ identifier: 'RW-inbox', state: 'Inbox', labels: ['Email'] })
    const planned = issue({ identifier: 'RW-planned', state: 'Planned', dueDate: '2026-10-01' })

    expect(order([rw339, inbox, planned])).toEqual(['RW-planned'])
  })

  it('returns an empty list for an empty board', () => {
    expect(rankTasks([], ctx)).toEqual([])
  })

  it('returns an empty list when nothing is committed', () => {
    expect(rankTasks([issue({ identifier: 'RW-1', state: 'Ready' })], ctx)).toEqual([])
  })
})

describe('rankTasks — determinism', () => {
  it('preserves input order for equal scores', () => {
    const issues = [
      issue({ identifier: 'RW-z', state: 'Planned', dueDate: '2026-09-14' }),
      issue({ identifier: 'RW-a', state: 'Planned', dueDate: '2026-09-14' }),
      issue({ identifier: 'RW-m', state: 'Planned', dueDate: '2026-09-14' }),
    ]

    expect(order(issues)).toEqual(['RW-z', 'RW-a', 'RW-m'])
    // And again — no hidden state between calls.
    expect(order(issues)).toEqual(['RW-z', 'RW-a', 'RW-m'])
  })

  it('numbers ranks from 1, contiguously', () => {
    const issues = [
      issue({ identifier: 'RW-1', state: 'Planned', dueDate: '2026-09-14' }),
      issue({ identifier: 'RW-2', state: 'In Progress', dueDate: '2026-09-10' }),
      issue({ identifier: 'RW-3', state: 'Waiting', dueDate: null }),
    ]

    expect(rankTasks(issues, ctx).map((task) => task.rank)).toEqual([1, 2, 3])
  })
})

describe('rankTasks — the reason line', () => {
  it('joins the signals that fired, strongest first', () => {
    const rw339 = issue({ identifier: 'RW-339', state: 'Planned', dueDate: '2026-07-22' })
    const context: RankContext = {
      todayKey: TODAY,
      meetingLinks: links({ 'RW-339': { eventId: 'evt-1', eventSubject: 'sync' } }),
    }

    const [ranked] = rankTasks([rw339], context)
    expect(ranked.signals).toEqual([
      { kind: 'overdue', daysOver: 51 },
      { kind: 'meeting-linked', eventId: 'evt-1', eventSubject: 'sync' },
    ])
    expect(ranked.reason.text).toBe("51 days over · blocking today's sync")
  })

  it('names a due date in human words', () => {
    const today = issue({ identifier: 'RW-1', state: 'Planned', dueDate: TODAY })
    const tomorrow = issue({ identifier: 'RW-2', state: 'Planned', dueDate: '2026-09-12' })
    const monday = issue({ identifier: 'RW-3', state: 'Planned', dueDate: '2026-09-14' })
    const distant = issue({ identifier: 'RW-4', state: 'Planned', dueDate: '2026-10-30' })

    const texts = rankTasks([today, tomorrow, monday, distant], ctx).map((t) => t.reason.text)
    expect(texts).toEqual(['due today', 'due tomorrow', 'due Monday', 'due in 49 days'])
  })

  it('singularises a one-day overrun', () => {
    const yesterday = issue({ identifier: 'RW-1', state: 'Planned', dueDate: '2026-09-10' })
    expect(rankTasks([yesterday], ctx)[0].reason.text).toBe('1 day over')
  })

  it('always produces a reason, even for an undated Planned item', () => {
    const undated = issue({ identifier: 'RW-1', state: 'Planned', dueDate: null })
    expect(rankTasks([undated], ctx)[0].reason.text).toBe('no due date set')
  })

  it('reports a set priority and the started state', () => {
    const started = issue({
      identifier: 'RW-1',
      state: 'In Progress',
      dueDate: TODAY,
      description: null,
      priority: 1,
    })
    expect(rankTasks([started], ctx)[0].reason.text).toBe(
      'due today · already started · marked urgent',
    )
  })
})

describe('shortSubject', () => {
  it('keeps a short subject intact', () => {
    expect(shortSubject('1:1 Jorien')).toBe('1:1 Jorien')
  })

  it('drops the trailing note real calendar entries carry after "--"', () => {
    expect(
      shortSubject('Vervolg meeting plannen Marc & Nikola -- vooraf toesturen monitoren'),
    ).toBe('Vervolg meeting plannen Marc &…')
  })

  it('trims at a word boundary rather than mid-word', () => {
    const out = shortSubject('Quarterly review preparation session with the whole team')
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(36)
    expect(out).not.toMatch(/\s…$/)
  })
})
