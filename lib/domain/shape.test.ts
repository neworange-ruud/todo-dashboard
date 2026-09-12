import { describe, expect, it } from 'vitest'

import {
  availableMinutesFor,
  classifyEvent,
  dayShape,
  intervalOn,
  isContainer,
  mergeIntervals,
  normaliseSubject,
} from './shape'
import { buildTimeline } from './timeline'
import { buildWeekLoad } from './week'
import { findConflicts } from './attention'
import { formatDayMonth } from '../time'
import { toSourceRef } from '../ai/synthesis'
import type { OmniDocument } from '../types'
import type { Attendee, CalendarEvent } from '../types'

/**
 * The Wednesday shape (PRD §17.9, round 4).
 *
 * Every event here is copied from the live calendar for Wednesday 16 and 23 September
 * 2026 rather than invented, because the whole feature turns on the exact form these two
 * blocks take: zero invited attendees, `showAs: busy`, recurring occurrences, and a
 * parenthetical in the subject that is prose rather than an identifier.
 */

const WED = '2026-09-16'

function person(email: string, isOrganizer = false): Attendee {
  return { email, name: null, isOrganizer }
}

function event(over: Partial<CalendarEvent> & { subject: string; start: string; end: string }): CalendarEvent {
  return {
    id: over.subject,
    isAllDay: false,
    isCancelled: false,
    location: null,
    organizer: person('ruud.vanfalier@neworange.agency', true),
    // Graph reports these blocks with no invitees; foldAttendees then folds the organiser
    // in, so a solo block arrives holding exactly one person.
    attendees: [person('ruud.vanfalier@neworange.agency', true)],
    webLink: null,
    ...over,
  }
}

/** `09:00` on the Wednesday, as the offset-bearing ISO the Graph mapper produces. */
function at(clock: string): string {
  return `${WED}T${clock}:00+02:00`
}

const VRIJ_HOUDEN = event({
  subject: 'Vrij houden (geen meetings plannen zonder te overleggen)',
  start: at('09:00'),
  end: at('13:00'),
})

const NIET_BESCHIKBAAR = event({
  subject: 'Niet beschikbaar',
  start: at('13:00'),
  end: at('17:30'),
})

const CHECK_IN = event({
  subject: 'Check-in Starterscheck',
  start: at('10:00'),
  end: at('10:30'),
  attendees: [person('ruby.dekok@neworange.agency', true), person('ruud.vanfalier@neworange.agency')],
})

const TUIL = event({
  subject: 'Update/cijfer meeting in Tuil',
  start: at('11:30'),
  end: at('12:00'),
  attendees: [person('office@neworange.agency', true), person('ruud.vanfalier@neworange.agency')],
})

/** 23 September, inside the non-work block. Zero invitees, and still a real commitment. */
const OMA_ADA = event({
  subject: 'Oma Ada haalt kids op en past op',
  start: at('14:00'),
  end: at('16:30'),
})

const WEDNESDAY = [VRIJ_HOUDEN, CHECK_IN, TUIL, NIET_BESCHIKBAAR]

describe('classifyEvent', () => {
  it('reads the two framing blocks for what they are', () => {
    expect(classifyEvent(VRIJ_HOUDEN)).toBe('focus')
    expect(classifyEvent(NIET_BESCHIKBAAR)).toBe('offwork')
  })

  it('leaves everything else a meeting, inside a block or not', () => {
    expect(classifyEvent(CHECK_IN)).toBe('meeting')
    expect(classifyEvent(TUIL)).toBe('meeting')
    expect(classifyEvent(OMA_ADA)).toBe('meeting')
  })

  it('keeps a block that other people were invited to', () => {
    // Somebody scheduled a real meeting and called it this. Being invited is what makes a
    // meeting a meeting, so the subject does not get to overrule the guest list.
    const shared = event({
      subject: 'Niet beschikbaar',
      start: at('13:00'),
      end: at('14:00'),
      attendees: [person('a@neworange.agency', true), person('b@neworange.agency')],
    })
    expect(classifyEvent(shared)).toBe('meeting')
  })

  it('never treats an all-day event as a frame', () => {
    const holiday = event({
      subject: 'Niet beschikbaar',
      start: at('00:00'),
      end: at('00:00'),
      isAllDay: true,
    })
    expect(classifyEvent(holiday)).toBe('meeting')
    expect(isContainer(holiday)).toBe(false)
  })

  it('matches the focus block however its parenthetical is worded', () => {
    expect(classifyEvent(event({ ...VRIJ_HOUDEN, subject: 'Vrij houden' }))).toBe('focus')
    expect(classifyEvent(event({ ...VRIJ_HOUDEN, subject: 'VRIJ HOUDEN — focus' }))).toBe('focus')
  })

  it('normalises accents and punctuation out of the way', () => {
    expect(normaliseSubject('Níet beschíkbaar!')).toBe('niet beschikbaar')
  })
})

describe('dayShape', () => {
  it('separates the frame from the contents', () => {
    const shape = dayShape(WEDNESDAY, WED)
    expect(shape.containers.map((e) => e.subject)).toEqual([
      VRIJ_HOUDEN.subject,
      NIET_BESCHIKBAAR.subject,
    ])
    expect(shape.events.map((e) => e.subject)).toEqual([CHECK_IN.subject, TUIL.subject])
  })

  it('places the frames on the clock', () => {
    const shape = dayShape(WEDNESDAY, WED)
    expect(shape.focus).toEqual([{ start: 9 * 60, end: 13 * 60 }])
    expect(shape.offwork).toEqual([{ start: 13 * 60, end: 17 * 60 + 30 }])
  })

  it('measures the day that is actually left', () => {
    // 13:00–17:30 removes four working hours from the eight, leaving the morning.
    expect(dayShape(WEDNESDAY, WED).availableMinutes).toBe(240)
  })

  it('leaves an ordinary day at its full length', () => {
    expect(dayShape([CHECK_IN, TUIL], WED).availableMinutes).toBe(480)
  })

  it('ignores a block that never overlapped working hours', () => {
    const evening = event({ subject: 'Niet beschikbaar', start: at('18:00'), end: at('22:00') })
    expect(dayShape([evening], WED).availableMinutes).toBe(480)
  })

  it('reads a wholly blocked day as no working day at all', () => {
    const whole = event({ subject: 'Niet beschikbaar', start: at('08:00'), end: at('18:00') })
    expect(dayShape([whole], WED).availableMinutes).toBe(0)
  })
})

describe('intervals', () => {
  it('clamps an event to the day it is being measured on', () => {
    expect(intervalOn(CHECK_IN, WED)).toEqual({ start: 600, end: 630 })
    expect(intervalOn(CHECK_IN, '2026-09-17')).toBeNull()
  })

  it('counts overlapping frames once', () => {
    expect(mergeIntervals([{ start: 0, end: 60 }, { start: 30, end: 120 }])).toEqual([
      { start: 0, end: 120 },
    ])
  })

  it('subtracts only the working part of a block', () => {
    expect(availableMinutesFor([{ start: 13 * 60, end: 17 * 60 + 30 }])).toBe(240)
    expect(availableMinutesFor([])).toBe(480)
  })
})

describe('the timeline on a Wednesday', () => {
  // A Thursday, so `now` never lands on the day under test and the NOW rule stays out of it.
  const elsewhere = new Date('2026-09-17T10:00:00+02:00')

  it('does not draw the frames as meetings', () => {
    const layout = buildTimeline(WEDNESDAY, elsewhere, { dateKey: WED })
    const drawn = layout.rows.filter((r) => r.kind === 'event').map((r) => r.event.subject)
    expect(drawn).toEqual([CHECK_IN.subject, TUIL.subject])
  })

  it('bills only the real meetings', () => {
    // One hour, not eight and a half.
    expect(buildTimeline(WEDNESDAY, elsewhere, { dateKey: WED }).bookedMinutes).toBe(60)
  })

  it('says the protected time is kept clear rather than free', () => {
    const layout = buildTimeline(WEDNESDAY, elsewhere, { dateKey: WED })
    const gaps = layout.rows.filter((r) => r.kind === 'gap')
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.every((g) => g.tone === 'clear')).toBe(true)
    expect(gaps[0].label).toMatch(/KEPT CLEAR$/)
  })

  it('frames the whole protected block even when nothing is in it', () => {
    // 23 September: a morning kept clear, holding nothing at all.
    const layout = buildTimeline([VRIJ_HOUDEN, NIET_BESCHIKBAAR], elsewhere, { dateKey: WED })
    const gaps = layout.rows.filter((r) => r.kind === 'gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ startMinutes: 9 * 60, endMinutes: 13 * 60, tone: 'clear' })
    expect(gaps[0].label).toBe('4H KEPT CLEAR')
  })

  it('ends the day where work ends', () => {
    const layout = buildTimeline([VRIJ_HOUDEN, NIET_BESCHIKBAAR], elsewhere, { dateKey: WED })
    const last = layout.rows[layout.rows.length - 1]
    expect(last.kind === 'gap' && last.endMinutes).toBe(13 * 60)
  })

  it('shows what someone put inside the non-work block, and marks it', () => {
    const layout = buildTimeline([VRIJ_HOUDEN, NIET_BESCHIKBAAR, OMA_ADA], elsewhere, {
      dateKey: WED,
    })
    const rows = layout.rows.filter((r) => r.kind === 'event')
    expect(rows).toHaveLength(1)
    expect(rows[0].event.subject).toBe(OMA_ADA.subject)
    expect(rows[0].outsideHours).toBe(true)
  })

  it('never labels one band as both kept clear and outside hours', () => {
    const layout = buildTimeline([VRIJ_HOUDEN, NIET_BESCHIKBAAR, OMA_ADA], elsewhere, {
      dateKey: WED,
    })
    for (const row of layout.rows) {
      if (row.kind !== 'gap') continue
      if (row.tone === 'clear') expect(row.endMinutes).toBeLessThanOrEqual(13 * 60)
      if (row.tone === 'offwork') expect(row.startMinutes).toBeGreaterThanOrEqual(13 * 60)
    }
  })
})

describe('the week bar on a Wednesday', () => {
  it('measures an hour of meetings against a four-hour day', () => {
    const week = buildWeekLoad({ [WED]: WEDNESDAY }, WED)
    const wednesday = week.find((d) => d.date === WED)!
    expect(wednesday.bookedMinutes).toBe(60)
    expect(wednesday.workdayMinutes).toBe(240)
    expect(wednesday.isHeavy).toBe(false)
  })

  it('does not call a day off a heavy day', () => {
    const whole = event({ subject: 'Niet beschikbaar', start: at('08:00'), end: at('18:00') })
    const wednesday = buildWeekLoad({ [WED]: [whole] }, WED).find((d) => d.date === WED)!
    expect(wednesday.workdayMinutes).toBe(0)
    expect(wednesday.isHeavy).toBe(false)
  })
})

describe('the attention strip on a Wednesday', () => {
  it('does not call a meeting inside a protected morning a double-booking', () => {
    // Before the frame existed this fired for every meeting held on a Wednesday, which is
    // precisely the weekly false positive PRD §9 says this zone cannot afford.
    const conflicts = findConflicts(WEDNESDAY, new Date(at('09:30')))
    expect(conflicts).toEqual([])
  })

  it('still finds a genuine overlap inside that morning', () => {
    const clash = event({
      subject: 'Something else',
      start: at('10:00'),
      end: at('10:30'),
      attendees: [person('x@neworange.agency', true), person('ruud.vanfalier@neworange.agency')],
    })
    const conflicts = findConflicts([...WEDNESDAY, clash], new Date(at('09:30')))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].map((e) => e.subject).sort()).toEqual(
      [CHECK_IN.subject, clash.subject].sort(),
    )
  })
})

describe('load and capacity agree about which hours exist', () => {
  it('does not bill an evening commitment against the morning it never touched', () => {
    // 23 September: a protected morning holding nothing, and a personal block at 14:00
    // inside the non-work afternoon. The morning was entirely free.
    const week = buildWeekLoad({ [WED]: [VRIJ_HOUDEN, NIET_BESCHIKBAAR, OMA_ADA] }, WED)
    const wednesday = week.find((d) => d.date === WED)!
    expect(wednesday.bookedMinutes).toBe(0)
    expect(wednesday.workdayMinutes).toBe(240)
  })

  it('still counts the part of a meeting that runs inside working time', () => {
    const straddles = event({
      subject: 'Runs past the end of the day',
      start: at('12:30'),
      end: at('14:30'),
      attendees: [person('a@neworange.agency', true), person('b@neworange.agency')],
    })
    const week = buildWeekLoad({ [WED]: [VRIJ_HOUDEN, NIET_BESCHIKBAAR, straddles] }, WED)
    // 12:30–13:00 is working time; 13:00–14:30 is not.
    expect(week.find((d) => d.date === WED)!.bookedMinutes).toBe(30)
  })
})

describe('formatDayMonth', () => {
  const now = new Date('2026-09-12T10:00:00+02:00')

  it('spells September "Sep", not the en-GB default "Sept"', () => {
    // Two spellings of one month in a single panel is the bug this exists to prevent.
    expect(formatDayMonth('2026-09-10T09:00:00Z', now)).toBe('10 Sep')
  })

  it('adds the year once it is no longer this one', () => {
    // A task's meetings list mixes last week with last year; "30 Oct" alone reads as soon.
    expect(formatDayMonth('2025-10-30T09:00:00Z', now)).toBe('30 Oct 2025')
  })

  it('says nothing rather than printing a placeholder', () => {
    expect(formatDayMonth(null, now)).toBeNull()
    expect(formatDayMonth('not a date', now)).toBeNull()
  })
})


describe('source labels', () => {
  const doc = (over: Partial<OmniDocument> & { id: string }): OmniDocument => ({
    title: 'Bijpraten BOVAG',
    url: 'https://app.fireflies.ai/view/abc',
    snippet: '',
    sourceType: 'fireflies',
    date: '2026-09-11T08:00:00Z',
    ...over,
  })

  it('stamps an ordinary title with its date', () => {
    expect(toSourceRef(doc({ id: '1' })).label).toBe('Bijpraten BOVAG, 11 Sep')
  })

  it('leaves a Fireflies timestamp title alone', () => {
    // "Sep 04, 01:04 PM, 4 Sep" is the same day said twice in two formats.
    const label = toSourceRef(doc({ id: '2', title: 'Sep 04, 01:04 PM', date: '2026-09-04T11:04:00Z' })).label
    expect(label).toBe('Sep 04, 01:04 PM')
  })

  it('carries the link through, which is the point of the affordance', () => {
    expect(toSourceRef(doc({ id: '3' })).url).toContain('fireflies.ai')
  })
})
