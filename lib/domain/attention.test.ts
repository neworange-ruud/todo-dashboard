import { describe, it, expect } from 'vitest'
import { buildAttention, findConflicts, findBadlyOverdue, MAX_ITEMS, BADLY_OVERDUE_DAYS } from './attention'
import type { CalendarEvent, LinearIssue } from '../types'

const ev = (o: Partial<CalendarEvent> & { id: string; start: string; end: string }): CalendarEvent => ({
  subject: o.id, isAllDay: false, isCancelled: false, location: null,
  organizer: null, attendees: [], webLink: null, ...o,
})
const iss = (o: Partial<LinearIssue> & { identifier: string }): LinearIssue => ({
  title: o.identifier, dueDate: null, priority: 0, state: 'In Progress', labels: [],
  url: '', hasRelations: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...o,
})

const NOW = new Date('2026-09-11T09:00:00+02:00')
const TODAY = '2026-09-11'

describe('conflicts', () => {
  it('finds overlapping meetings inside the horizon', () => {
    const pairs = findConflicts([
      ev({ id: 'a', start: '2026-09-11T10:00:00+02:00', end: '2026-09-11T11:00:00+02:00' }),
      ev({ id: 'b', start: '2026-09-11T10:30:00+02:00', end: '2026-09-11T11:30:00+02:00' }),
    ], NOW)
    expect(pairs).toHaveLength(1)
  })

  it('ignores all-day events — a colleague on holiday is not a conflict', () => {
    const pairs = findConflicts([
      ev({ id: 'holiday', start: '2026-09-11T00:00:00+02:00', end: '2026-09-11T00:00:00+02:00', isAllDay: true }),
      ev({ id: 'real', start: '2026-09-11T10:00:00+02:00', end: '2026-09-11T11:00:00+02:00' }),
    ], NOW)
    expect(pairs).toHaveLength(0)
  })

  it('ignores conflicts beyond the four-hour horizon', () => {
    const pairs = findConflicts([
      ev({ id: 'a', start: '2026-09-11T20:00:00+02:00', end: '2026-09-11T21:00:00+02:00' }),
      ev({ id: 'b', start: '2026-09-11T20:30:00+02:00', end: '2026-09-11T21:30:00+02:00' }),
    ], NOW)
    expect(pairs).toHaveLength(0)
  })

  it('ignores back-to-back meetings that merely touch', () => {
    const pairs = findConflicts([
      ev({ id: 'a', start: '2026-09-11T10:00:00+02:00', end: '2026-09-11T11:00:00+02:00' }),
      ev({ id: 'b', start: '2026-09-11T11:00:00+02:00', end: '2026-09-11T12:00:00+02:00' }),
    ], NOW)
    expect(pairs).toHaveLength(0)
  })
})

describe('badly overdue', () => {
  it('surfaces RW-339, the real 51-day case', () => {
    const found = findBadlyOverdue([iss({ identifier: 'RW-339', state: 'Ready', dueDate: '2026-07-22' })], TODAY)
    expect(found.map((i) => i.identifier)).toEqual(['RW-339'])
  })

  it('ignores merely-late work below the threshold', () => {
    const dueDate = '2026-09-08' // 3 days over
    expect(findBadlyOverdue([iss({ identifier: 'RW-772', dueDate })], TODAY)).toHaveLength(0)
    expect(BADLY_OVERDUE_DAYS).toBeGreaterThan(3)
  })

  it('ignores undated issues', () => {
    expect(findBadlyOverdue([iss({ identifier: 'RW-1' })], TODAY)).toHaveLength(0)
  })
})

describe('the strip', () => {
  it('is empty on a normal day — and most days are normal', () => {
    const items = buildAttention({
      issues: [iss({ identifier: 'RW-1', dueDate: '2026-09-15' })],
      events: [ev({ id: 'a', start: '2026-09-11T10:00:00+02:00', end: '2026-09-11T11:00:00+02:00' })],
      todayKey: TODAY, now: NOW,
    })
    expect(items).toEqual([])
  })

  it('names the thing in full rather than counting it', () => {
    const items = buildAttention({
      issues: [iss({ identifier: 'RW-339', state: 'Ready', dueDate: '2026-07-22', title: 'The presentation' })],
      events: [], todayKey: TODAY, now: NOW,
    })
    expect(items).toHaveLength(1)
    expect(items[0].text).toContain('RW-339')
    expect(items[0].text).toContain('The presentation')
    expect(items[0].text, 'never a bare count').not.toMatch(/^\d+$/)
  })

  it('caps at three and collapses the rest', () => {
    const issues = Array.from({ length: 6 }, (_, i) =>
      iss({ identifier: `RW-${i}`, dueDate: '2026-06-01' }))
    const items = buildAttention({ issues, events: [], todayKey: TODAY, now: NOW })
    expect(items).toHaveLength(MAX_ITEMS + 1)
    expect(items[MAX_ITEMS].text).toBe('and 3 more')
  })

  it('does not report a blocking overdue issue twice', () => {
    const items = buildAttention({
      issues: [iss({ identifier: 'RW-9', dueDate: '2026-06-01', hasRelations: true })],
      events: [], todayKey: TODAY, now: NOW,
    })
    expect(items).toHaveLength(1)
    expect(items[0].text).toContain('blocking someone else')
  })

  it('orders conflicts before rot — soonest actionable first', () => {
    const items = buildAttention({
      issues: [iss({ identifier: 'RW-339', dueDate: '2026-07-22' })],
      events: [
        ev({ id: 'a', start: '2026-09-11T10:00:00+02:00', end: '2026-09-11T11:00:00+02:00' }),
        ev({ id: 'b', start: '2026-09-11T10:30:00+02:00', end: '2026-09-11T11:30:00+02:00' }),
      ],
      todayKey: TODAY, now: NOW,
    })
    expect(items[0].text).toContain('double-booked')
  })
})
