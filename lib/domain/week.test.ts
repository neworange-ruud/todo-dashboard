import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import type { CalendarEvent } from '../types'
import { bookedMinutesForDay, buildWeekLoad, HEAVY_THRESHOLD, WORKDAY_MINUTES } from './week'

// The working week of 7-11 Sep 2026 (Mon-Fri); 11 Sep is the Friday.
const MON = '2026-09-07'
const TUE = '2026-09-08'
const WED = '2026-09-09'
const THU = '2026-09-10'
const FRI = '2026-09-11'

function event(
  over: Partial<CalendarEvent> & { id: string; start: string; end: string },
): CalendarEvent {
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

/** `hours` of meetings on `day`, in one block from 09:00. */
function hours(day: string, count: number): CalendarEvent[] {
  const end = String(9 + count).padStart(2, '0')
  return [event({ id: `${day}-block`, start: `${day}T09:00:00+02:00`, end: `${day}T${end}:00:00+02:00` })]
}

describe('buildWeekLoad', () => {
  it('returns Monday to Friday, labelled and dated', () => {
    const week = buildWeekLoad({}, FRI)
    expect(week).toHaveLength(5)
    expect(week.map((d) => d.label)).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI'])
    expect(week.map((d) => d.date)).toEqual([MON, TUE, WED, THU, FRI])
    expect(week.every((d) => d.workdayMinutes === WORKDAY_MINUTES)).toBe(true)
  })

  it('flags today and only today', () => {
    const week = buildWeekLoad({}, WED)
    expect(week.filter((d) => d.isToday).map((d) => d.date)).toEqual([WED])
  })

  it('reads a missing day as an honest zero rather than throwing', () => {
    const week = buildWeekLoad({ [WED]: hours(WED, 2) }, FRI)
    expect(week.map((d) => d.bookedMinutes)).toEqual([0, 0, 120, 0, 0])
  })

  it('sums booked minutes across a day', () => {
    const week = buildWeekLoad(
      {
        [TUE]: [
          event({ id: 'a', start: `${TUE}T09:00:00+02:00`, end: `${TUE}T09:15:00+02:00` }),
          event({ id: 'b', start: `${TUE}T10:00:00+02:00`, end: `${TUE}T11:00:00+02:00` }),
          event({ id: 'c', start: `${TUE}T14:00:00+02:00`, end: `${TUE}T14:05:00+02:00` }),
        ],
      },
      FRI,
    )
    expect(week[1].bookedMinutes).toBe(80)
  })
})

describe('the heavy-day threshold', () => {
  it('is not heavy at or below 70% of an eight-hour day', () => {
    // 0.7 x 480 = 336 minutes exactly.
    const week = buildWeekLoad(
      { [MON]: [event({ id: 'x', start: `${MON}T09:00:00+02:00`, end: `${MON}T14:36:00+02:00` })] },
      FRI,
    )
    expect(week[0].bookedMinutes).toBe(336)
    expect(week[0].bookedMinutes / WORKDAY_MINUTES).toBe(HEAVY_THRESHOLD)
    expect(week[0].isHeavy).toBe(false)
  })

  it('is heavy one minute above the threshold', () => {
    const week = buildWeekLoad(
      { [MON]: [event({ id: 'x', start: `${MON}T09:00:00+02:00`, end: `${MON}T14:37:00+02:00` })] },
      FRI,
    )
    expect(week[0].bookedMinutes).toBe(337)
    expect(week[0].isHeavy).toBe(true)
  })

  it('leaves a light day alone', () => {
    const week = buildWeekLoad({ [THU]: hours(THU, 2) }, FRI)
    expect(week[3].isHeavy).toBe(false)
  })

  it('marks a fully booked day heavy', () => {
    const week = buildWeekLoad({ [FRI]: hours(FRI, 8) }, FRI)
    expect(week[4].bookedMinutes).toBe(480)
    expect(week[4].isHeavy).toBe(true)
  })
})

describe('what counts as load', () => {
  it('excludes all-day events (PRD §17.9)', () => {
    const katja = event({
      id: 'katja',
      subject: 'Katja vakantie',
      start: `${WED}T00:00:00+02:00`,
      end: `${THU}T00:00:00+02:00`,
      isAllDay: true,
    })
    const week = buildWeekLoad({ [WED]: [katja, ...hours(WED, 1)] }, FRI)
    // A colleague's holiday is not eight hours of your own load.
    expect(week[2].bookedMinutes).toBe(60)
    expect(week[2].isHeavy).toBe(false)
  })

  it('excludes cancelled events', () => {
    const week = buildWeekLoad(
      {
        [WED]: [
          ...hours(WED, 1),
          event({
            id: 'off',
            start: `${WED}T13:00:00+02:00`,
            end: `${WED}T17:00:00+02:00`,
            isCancelled: true,
          }),
        ],
      },
      FRI,
    )
    expect(week[2].bookedMinutes).toBe(60)
  })

  it('counts overlapping meetings once', () => {
    const week = buildWeekLoad(
      {
        [WED]: [
          event({ id: 'a', start: `${WED}T09:00:00+02:00`, end: `${WED}T10:00:00+02:00` }),
          event({ id: 'b', start: `${WED}T09:30:00+02:00`, end: `${WED}T10:30:00+02:00` }),
        ],
      },
      FRI,
    )
    expect(week[2].bookedMinutes).toBe(90)
  })

  it('clamps a meeting straddling midnight to the day it is filed under', () => {
    const overnight = event({
      id: 'overnight',
      start: `${WED}T23:00:00+02:00`,
      end: `${THU}T01:00:00+02:00`,
    })
    expect(bookedMinutesForDay(WED, [overnight])).toBe(60)
    expect(bookedMinutesForDay(THU, [overnight])).toBe(60)
  })

  it('can never bill more than a day to one bar', () => {
    const multiDay = event({
      id: 'offsite',
      start: `${MON}T09:00:00+02:00`,
      end: `${THU}T17:00:00+02:00`,
    })
    expect(bookedMinutesForDay(TUE, [multiDay])).toBe(1440)
  })
})
