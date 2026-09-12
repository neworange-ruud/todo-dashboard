import { describe, expect, it, vi } from 'vitest'

// `lib/time.ts` reaches `lib/config.ts`, which is a server module.
vi.mock('server-only', () => ({}))

import type { CalendarEvent, TimelineRow } from '../types'
import {
  buildTimeline,
  DAY_PADDING_MINUTES,
  GAP_BAND_PX,
  MIN_EVENT_PX,
  PX_PER_MINUTE,
  PX_PER_MINUTE_COMPACT,
} from './timeline'

// ---------------------------------------------------------------------------
// Fixtures — the real 11 Sep 2026 calendar (PRD §17.9)
// ---------------------------------------------------------------------------

const DAY = '2026-09-11'

function at(time: string): string {
  return `${DAY}T${time}:00+02:00`
}

function event(over: Partial<CalendarEvent> & { id: string; start: string; end: string }): CalendarEvent {
  return {
    subject: 'Meeting',
    isAllDay: false,
    isCancelled: false,
    location: null,
    organizer: null,
    attendees: [],
    webLink: null,
    ...over,
  }
}

const KATJA = event({
  id: 'katja',
  subject: 'Katja vakantie',
  start: at('00:00'),
  end: `2026-09-12T00:00:00+02:00`,
  isAllDay: true,
  attendees: Array.from({ length: 5 }, (_, i) => ({
    email: `p${i}@neworange.agency`,
    name: null,
    isOrganizer: i === 0,
  })),
})
const VERVOLG = event({ id: 'vervolg', subject: 'Vervolg meeting plannen Marc & Nikola', start: at('09:00'), end: at('09:15') })
const BOVAG = event({ id: 'bovag', subject: 'Bijpraten BOVAG', start: at('10:00'), end: at('11:00'), location: 'Microsoft Teams Meeting' })
const TANDARTS = event({ id: 'tandarts', subject: 'Tandarts', start: at('11:50'), end: at('12:50') })
const CLAUDE = event({ id: 'claude', subject: 'Claude remote', start: at('14:00'), end: at('14:05') })

const REAL_DAY = [KATJA, VERVOLG, BOVAG, TANDARTS, CLAUDE]

const now = (time: string) => new Date(at(time))
/** A time on another day, so `now` never participates. */
const OTHER_DAY = new Date('2026-09-12T10:00:00+02:00')

const gaps = (rows: TimelineRow[]) => rows.filter((r): r is Extract<TimelineRow, { kind: 'gap' }> => r.kind === 'gap')
const events = (rows: TimelineRow[]) => rows.filter((r): r is Extract<TimelineRow, { kind: 'event' }> => r.kind === 'event')
const nows = (rows: TimelineRow[]) => rows.filter((r): r is Extract<TimelineRow, { kind: 'now' }> => r.kind === 'now')
const row = (rows: TimelineRow[], id: string) => events(rows).find((r) => r.event.id === id)!

// ---------------------------------------------------------------------------

describe('all-day events (PRD §17.9)', () => {
  it('separates them out, never drawing them as rows', () => {
    const layout = buildTimeline(REAL_DAY, OTHER_DAY)
    expect(layout.allDay.map((e) => e.id)).toEqual(['katja'])
    expect(events(layout.rows).map((r) => r.event.id)).toEqual(['vervolg', 'bovag', 'tandarts', 'claude'])
  })

  it('excludes them from booked time', () => {
    const layout = buildTimeline(REAL_DAY, OTHER_DAY)
    // 15 + 60 + 60 + 5 — the 24h holiday contributes nothing.
    expect(layout.bookedMinutes).toBe(140)
  })

  it('renders an all-day-only day as a header band with no timeline', () => {
    const layout = buildTimeline([KATJA], now('10:00'))
    expect(layout.allDay).toHaveLength(1)
    expect(layout.rows).toEqual([])
    expect(layout.bookedMinutes).toBe(0)
    expect(layout.freeMinutes).toBe(0)
  })
})

describe('proportional occupied time', () => {
  it('draws an hour to scale', () => {
    const layout = buildTimeline([BOVAG], OTHER_DAY)
    expect(row(layout.rows, 'bovag').heightPx).toBe(Math.round(60 * PX_PER_MINUTE))
  })

  it('clamps a 5-minute event to the 32px minimum', () => {
    const layout = buildTimeline(REAL_DAY, OTHER_DAY)
    // 5 x 0.9 = 4.5px, which would be invisible.
    expect(row(layout.rows, 'claude').heightPx).toBe(MIN_EVENT_PX)
    expect(row(layout.rows, 'vervolg').heightPx).toBe(MIN_EVENT_PX)
  })

  it('halves the scale on mobile while keeping the clamp', () => {
    const workshop = event({ id: 'workshop', start: at('09:00'), end: at('12:00') })
    const desktop = buildTimeline([workshop, CLAUDE], OTHER_DAY)
    const mobile = buildTimeline([workshop, CLAUDE], OTHER_DAY, { compact: true })

    expect(row(desktop.rows, 'workshop').heightPx).toBe(Math.round(180 * PX_PER_MINUTE))
    expect(row(mobile.rows, 'workshop').heightPx).toBe(Math.round(180 * PX_PER_MINUTE_COMPACT))
    // Proportion is preserved: half the pixels for the same minutes.
    expect(row(mobile.rows, 'workshop').heightPx * 2).toBe(row(desktop.rows, 'workshop').heightPx)
    // The clamp still wins for anything short.
    expect(row(mobile.rows, 'claude').heightPx).toBe(MIN_EVENT_PX)
  })
})

describe('compressed empty time', () => {
  it('collapses the 11:00-11:50 gap into one fixed labelled band', () => {
    const layout = buildTimeline(REAL_DAY, OTHER_DAY)
    const gap = gaps(layout.rows).find((g) => g.startMinutes === 11 * 60)!
    expect(gap).toBeDefined()
    expect(gap.endMinutes).toBe(11 * 60 + 50)
    expect(gap.label).toBe('50M FREE')
    expect(gap.heightPx).toBe(GAP_BAND_PX)
  })

  it('gives a long gap the same height as a short one', () => {
    const layout = buildTimeline(REAL_DAY, OTHER_DAY)
    const long = gaps(layout.rows).find((g) => g.label === '1H 10M FREE')!
    const short = gaps(layout.rows).find((g) => g.label === '45M FREE')!
    expect(long.heightPx).toBe(short.heightPx)
    expect(long.heightPx).toBe(GAP_BAND_PX)
  })

  it('emits a band between every pair of events', () => {
    const layout = buildTimeline(REAL_DAY, OTHER_DAY)
    expect(gaps(layout.rows).map((g) => g.label)).toEqual([
      '30M FREE', // leading padding
      '45M FREE', // 09:15 -> 10:00
      '50M FREE', // 11:00 -> 11:50
      '1H 10M FREE', // 12:50 -> 14:00
      '30M FREE', // trailing padding
    ])
  })

  it('absorbs sub-30-minute gaps in compact mode', () => {
    const tight = [
      event({ id: 'a', start: at('09:00'), end: at('09:15') }),
      event({ id: 'b', start: at('09:30'), end: at('10:00') }), // 15-minute gap
      event({ id: 'c', start: at('11:00'), end: at('11:30') }), // 60-minute gap
    ]
    const desktop = buildTimeline(tight, OTHER_DAY)
    const mobile = buildTimeline(tight, OTHER_DAY, { compact: true })

    expect(gaps(desktop.rows).map((g) => g.label)).toContain('15M FREE')
    expect(gaps(mobile.rows).map((g) => g.label)).not.toContain('15M FREE')
    expect(gaps(mobile.rows).map((g) => g.label)).toContain('1H FREE')
    // Absorbing a band must not change what the day actually costs.
    expect(mobile.bookedMinutes).toBe(desktop.bookedMinutes)
    expect(mobile.freeMinutes).toBe(desktop.freeMinutes)
  })
})

describe('day range', () => {
  it('frames the day from first event -30 to last event +30', () => {
    const layout = buildTimeline(REAL_DAY, OTHER_DAY)
    const all = gaps(layout.rows)
    const first = all[0]
    const last = all[all.length - 1]

    expect(first.startMinutes).toBe(9 * 60 - DAY_PADDING_MINUTES) // 08:30
    expect(last.endMinutes).toBe(14 * 60 + 5 + DAY_PADDING_MINUTES) // 14:35
    // Never a fixed 09:00-18:00 frame.
    expect(last.endMinutes).not.toBe(18 * 60)
  })

  it('frames a single event tightly around itself', () => {
    const layout = buildTimeline([BOVAG], OTHER_DAY)
    expect(layout.rows).toHaveLength(3)
    expect(gaps(layout.rows)[0]).toMatchObject({ startMinutes: 570, endMinutes: 600, label: '30M FREE' })
    expect(gaps(layout.rows)[1]).toMatchObject({ startMinutes: 660, endMinutes: 690, label: '30M FREE' })
    expect(layout.bookedMinutes).toBe(60)
    expect(layout.freeMinutes).toBe(60)
  })

  it('never runs past midnight', () => {
    const late = event({ id: 'late', start: at('23:40'), end: `2026-09-12T00:00:00+02:00` })
    const layout = buildTimeline([late], OTHER_DAY)
    expect(gaps(layout.rows).every((g) => g.endMinutes <= 1440)).toBe(true)
  })
})

describe('now', () => {
  it('inserts a now row at the current minute, splitting the gap it falls in', () => {
    const layout = buildTimeline(REAL_DAY, now('09:30'))
    expect(nows(layout.rows)).toHaveLength(1)
    expect(nows(layout.rows)[0].atMinutes).toBe(9 * 60 + 30)
    expect(nows(layout.rows)[0].label).toBe('NOW 09:30')

    const labels = gaps(layout.rows).map((g) => g.label)
    expect(labels).toContain('15M FREE') // 09:15 -> now
    expect(labels).toContain('30M FREE') // now -> 10:00
  })

  it('flags the event containing now and places the rule above it', () => {
    const layout = buildTimeline(REAL_DAY, now('10:30'))
    expect(row(layout.rows, 'bovag').isNow).toBe(true)
    expect(row(layout.rows, 'bovag').isPast).toBe(false)

    const rows = layout.rows
    expect(rows[rows.indexOf(row(rows, 'bovag')) - 1].kind).toBe('now')
    expect(nows(rows)).toHaveLength(1)
  })

  it('marks wholly-past events and leaves future ones alone', () => {
    const layout = buildTimeline(REAL_DAY, now('12:00'))
    expect(row(layout.rows, 'vervolg').isPast).toBe(true)
    expect(row(layout.rows, 'bovag').isPast).toBe(true)
    expect(row(layout.rows, 'tandarts').isPast).toBe(false)
    expect(row(layout.rows, 'claude').isPast).toBe(false)
  })

  it('omits the now row when now is on another day', () => {
    expect(nows(buildTimeline(REAL_DAY, OTHER_DAY).rows)).toHaveLength(0)
  })

  it('omits the now row when now is outside the framed range', () => {
    expect(nows(buildTimeline(REAL_DAY, now('06:00')).rows)).toHaveLength(0)
    expect(nows(buildTimeline(REAL_DAY, now('20:00')).rows)).toHaveLength(0)
  })
})

describe('nowOnward (wall monitor)', () => {
  it('removes past events rather than dimming them', () => {
    const layout = buildTimeline(REAL_DAY, now('12:00'), { nowOnward: true })
    expect(events(layout.rows).map((r) => r.event.id)).toEqual(['tandarts', 'claude'])
    expect(events(layout.rows).every((r) => !r.isPast)).toBe(true)
    // Only the remaining commitments are billed.
    expect(layout.bookedMinutes).toBe(65)
  })

  it('starts the frame at now rather than before it', () => {
    const layout = buildTimeline(REAL_DAY, now('12:00'), { nowOnward: true })
    expect(layout.rows[0].kind).toBe('now')
    const first = events(layout.rows)[0]
    expect(first.isNow).toBe(true)
    expect(gaps(layout.rows).every((g) => g.startMinutes >= 12 * 60)).toBe(true)
  })

  it('still keeps all-day events in the header band', () => {
    const layout = buildTimeline(REAL_DAY, now('12:00'), { nowOnward: true })
    expect(layout.allDay.map((e) => e.id)).toEqual(['katja'])
  })

  it('empties the timeline once the last event is over', () => {
    const layout = buildTimeline(REAL_DAY, now('18:00'), { nowOnward: true })
    expect(layout.rows).toEqual([])
    expect(layout.bookedMinutes).toBe(0)
    expect(layout.allDay).toHaveLength(1)
  })
})

describe('degenerate days', () => {
  it('does not crash on an empty day', () => {
    const layout = buildTimeline([], now('10:00'))
    expect(layout).toEqual({ allDay: [], rows: [], bookedMinutes: 0, freeMinutes: 0 })
  })

  it('ignores cancelled events', () => {
    const layout = buildTimeline([{ ...BOVAG, isCancelled: true }, CLAUDE], OTHER_DAY)
    expect(events(layout.rows).map((r) => r.event.id)).toEqual(['claude'])
  })

  it('counts overlapping meetings once, not twice', () => {
    const conflict = [
      event({ id: 'a', start: at('10:00'), end: at('11:00') }),
      event({ id: 'b', start: at('10:30'), end: at('11:30') }),
    ]
    const layout = buildTimeline(conflict, OTHER_DAY)
    expect(layout.bookedMinutes).toBe(90)
    expect(events(layout.rows)).toHaveLength(2)
  })

  it('treats a zero-attendee personal block as an ordinary row', () => {
    const layout = buildTimeline([TANDARTS], OTHER_DAY)
    expect(row(layout.rows, 'tandarts').event.attendees).toEqual([])
    expect(row(layout.rows, 'tandarts').heightPx).toBeGreaterThan(MIN_EVENT_PX)
  })
})
