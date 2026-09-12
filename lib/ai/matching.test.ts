import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  collectMatches,
  matchIssuesToMeetings,
  MIN_CONFIDENCE,
  type MatchCompleter,
} from './matching'
import { MATCHING_SYSTEM_PROMPT } from './prompts'
import { invalidate } from '../cache'
import type { CalendarEvent, LinearIssue } from '../types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const at = (time: string) => `2026-09-11T${time}:00+02:00`

function event(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    subject: 'Acme sync',
    start: at('09:00'),
    end: at('10:00'),
    isAllDay: false,
    isCancelled: false,
    location: null,
    organizer: null,
    attendees: [{ email: 'marieke@acme.nl', name: 'Marieke de Vries', isOrganizer: true }],
    webLink: null,
    ...over,
  }
}

function issue(over: Partial<LinearIssue> & { identifier: string }): LinearIssue {
  return {
    title: 'Acme migration cut-over',
    dueDate: null,
    priority: 0,
    state: 'In Progress',
    labels: [],
    url: 'https://linear.app/rw/issue/RW-214',
    hasRelations: false,
    createdAt: at('08:00'),
    updatedAt: at('08:00'),
    ...over,
  }
}

const ACME = event({ id: 'evt-a' })
const DESIGN = event({ id: 'evt-b', subject: 'Design review', start: at('11:00'), end: at('12:00') })
const EVENTS = [ACME, DESIGN]
const ISSUES = [issue({ identifier: 'RW-214' }), issue({ identifier: 'RW-339', title: 'Rebuild the week lanes' })]

function fakeCompleter(answer: unknown) {
  const calls: Array<{ system: string; user: string }> = []
  const fn: MatchCompleter = async (req) => {
    calls.push({ system: req.system, user: req.user })
    return answer as Awaited<ReturnType<MatchCompleter>>
  }
  return { fn, calls }
}

beforeEach(() => invalidate('ai:match:'))

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------

describe('empty inputs', () => {
  it('returns an empty map for an empty calendar, without calling the model', async () => {
    const fake = fakeCompleter({ pairs: [{ issueIdentifier: 'RW-214', eventId: 'evt-a', confidence: 1 }] })
    const matches = await matchIssuesToMeetings([], ISSUES, fake.fn)

    expect(matches.size).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('returns an empty map for an empty backlog', async () => {
    const fake = fakeCompleter({ pairs: [] })
    expect((await matchIssuesToMeetings(EVENTS, [], fake.fn)).size).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('ignores all-day markers and cancelled meetings', async () => {
    const fake = fakeCompleter({ pairs: [] })
    const noise = [
      event({ id: 'evt-holiday', isAllDay: true, subject: 'Jasper on holiday' }),
      event({ id: 'evt-dead', isCancelled: true }),
    ]
    expect((await matchIssuesToMeetings(noise, ISSUES, fake.fn)).size).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Confidence and verification
// ---------------------------------------------------------------------------

describe('collectMatches', () => {
  it('keeps a confident pair with its justification', () => {
    const matches = collectMatches(
      {
        pairs: [
          {
            issueIdentifier: 'RW-214',
            eventId: 'evt-a',
            confidence: 0.9,
            reason: 'both are the Acme cut-over',
          },
        ],
      },
      EVENTS,
      ISSUES,
    )

    expect(matches.get('RW-214')).toEqual({
      eventId: 'evt-a',
      eventSubject: 'Acme sync',
      confidence: 0.9,
      reason: 'both are the Acme cut-over',
    })
  })

  it('drops low-confidence pairs', () => {
    const matches = collectMatches(
      {
        pairs: [
          { issueIdentifier: 'RW-214', eventId: 'evt-a', confidence: MIN_CONFIDENCE - 0.01, reason: 'maybe' },
          { issueIdentifier: 'RW-339', eventId: 'evt-b', confidence: MIN_CONFIDENCE, reason: 'the week lanes' },
        ],
      },
      EVENTS,
      ISSUES,
    )

    expect(matches.has('RW-214')).toBe(false)
    expect(matches.has('RW-339')).toBe(true)
  })

  it('drops identifiers and event ids it was never given', () => {
    const matches = collectMatches(
      {
        pairs: [
          { issueIdentifier: 'RW-999', eventId: 'evt-a', confidence: 1, reason: 'invented issue' },
          { issueIdentifier: 'RW-214', eventId: 'evt-zzz', confidence: 1, reason: 'invented meeting' },
        ],
      },
      EVENTS,
      ISSUES,
    )
    expect(matches.size).toBe(0)
  })

  it('keeps the strongest pair when an issue is matched twice', () => {
    const matches = collectMatches(
      {
        pairs: [
          { issueIdentifier: 'RW-214', eventId: 'evt-b', confidence: 0.7, reason: 'weaker' },
          { issueIdentifier: 'RW-214', eventId: 'evt-a', confidence: 0.95, reason: 'stronger' },
        ],
      },
      EVENTS,
      ISSUES,
    )
    expect(matches.get('RW-214')?.eventId).toBe('evt-a')
  })

  it('does not throw on malformed output', () => {
    expect(collectMatches(undefined, EVENTS, ISSUES).size).toBe(0)
    expect(collectMatches({}, EVENTS, ISSUES).size).toBe(0)
    expect(collectMatches({ pairs: 'nope' } as never, EVENTS, ISSUES).size).toBe(0)
    expect(collectMatches({ pairs: [null, 42, {}] } as never, EVENTS, ISSUES).size).toBe(0)
    expect(
      collectMatches(
        { pairs: [{ issueIdentifier: 'RW-214', eventId: 'evt-a', confidence: 'very' }] } as never,
        EVENTS,
        ISSUES,
      ).size,
    ).toBe(0)
  })

  it('substitutes a reason rather than shipping an empty one', () => {
    const matches = collectMatches(
      { pairs: [{ issueIdentifier: 'RW-214', eventId: 'evt-a', confidence: 0.8 }] },
      EVENTS,
      ISSUES,
    )
    expect(matches.get('RW-214')?.reason).toBe('related to Acme sync')
  })
})

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe('matchIssuesToMeetings', () => {
  it('feeds the model compact subjects, attendees and titles', async () => {
    const fake = fakeCompleter({ pairs: [] })
    await matchIssuesToMeetings(EVENTS, ISSUES, fake.fn)

    expect(fake.calls[0].system).toBe(MATCHING_SYSTEM_PROMPT)
    expect(fake.calls[0].user).toContain('eventId: evt-a | 09:00 | Acme sync | with: Marieke de Vries')
    expect(fake.calls[0].user).toContain('- RW-339 | In Progress | Rebuild the week lanes')
  })

  it('never throws when the model returns rubbish', async () => {
    const fake = fakeCompleter('not an object')
    await expect(matchIssuesToMeetings(EVENTS, ISSUES, fake.fn)).resolves.toBeInstanceOf(Map)
  })

  it('never throws when the gateway fails', async () => {
    const exploding: MatchCompleter = async () => {
      throw new Error('AI gateway returned 503')
    }
    expect((await matchIssuesToMeetings(EVENTS, ISSUES, exploding)).size).toBe(0)
  })

  it('caches on the inputs', async () => {
    const fake = fakeCompleter({
      pairs: [{ issueIdentifier: 'RW-214', eventId: 'evt-a', confidence: 0.9, reason: 'Acme' }],
    })
    const first = await matchIssuesToMeetings(EVENTS, ISSUES, fake.fn)
    const second = await matchIssuesToMeetings(EVENTS, ISSUES, fake.fn)

    expect(fake.calls).toHaveLength(1)
    expect(second.get('RW-214')).toEqual(first.get('RW-214'))
  })
})
