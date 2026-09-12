import { beforeEach, describe, expect, it, vi } from 'vitest'

// `lib/config.ts` is a server module; the sentence reaches it for MODELS and the identity.
vi.mock('server-only', () => ({}))

import {
  deterministicSentence,
  generateSentence,
  inputHash,
  isEmptyDay,
  MAX_WORDS,
  validateEntities,
  violatesVoice,
  windowFor,
  type SentenceCompleter,
  type SentenceDraft,
} from './sentence'
import { ALL_SYSTEM_PROMPTS, sentenceSystemPrompt } from './prompts'
import { LOCALE_INSTRUCTION } from './client'
import { invalidate } from '../cache'
import type { DashboardModel } from '../view-model'
import type { CalendarEvent, LinearIssue, RankedTask, TimelineRow } from '../types'

// ---------------------------------------------------------------------------
// Fixtures — a plausible 11 Sep 2026 (PRD §17.9)
// ---------------------------------------------------------------------------

const DAY = '2026-09-11'
const at = (time: string) => `${DAY}T${time}:00+02:00`

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
    title: 'Acme migration',
    description: null,
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

function ranked(over: Partial<LinearIssue> & { identifier: string }, rank = 1): RankedTask {
  return {
    issue: issue(over),
    rank,
    signals: [{ kind: 'in-progress' }],
    reason: { text: 'in progress since Monday' },
  }
}

const MEETING_A = event({ id: 'evt-a', subject: 'Acme sync', start: at('09:00'), end: at('10:00') })
const MEETING_B = event({ id: 'evt-b', subject: 'Design review', start: at('11:00'), end: at('12:00') })

const EVENT_ROWS: TimelineRow[] = [
  { kind: 'event', event: MEETING_A, heightPx: 60, isPast: false, isNow: false },
  { kind: 'event', event: MEETING_B, heightPx: 60, isPast: false, isNow: false },
  { kind: 'gap', startMinutes: 14 * 60, endMinutes: 16 * 60, label: '2H free', heightPx: 24, tone: 'free' },
]

function model(over: Partial<DashboardModel> = {}): DashboardModel {
  return {
    todayKey: DAY,
    now: new Date(at('08:30')),
    display: 'default',
    isToday: true,
    attention: [],
    timeline: { allDay: [], rows: EVENT_ROWS, bookedMinutes: 120, freeMinutes: 360, availableMinutes: 480 },
    ranked: [ranked({ identifier: 'RW-214' })],
    due: [],
    planning: [issue({ identifier: 'RW-900', state: 'Inbox', title: 'Follow up with Jasper' })],
    week: [],
    sync: { lastSyncedAt: null, sources: { linear: 'ok', graph: 'ok', omni: 'ok', brain: 'ok' } },
    moreCommitted: 0,
    ...over,
  }
}

/** A fake completer that answers from a queue and records what it was asked. */
function fakeCompleter(...answers: SentenceDraft[]) {
  const calls: Array<{ system: string; user: string }> = []
  const fn: SentenceCompleter = async (req) => {
    calls.push({ system: req.system, user: req.user })
    const next = answers[calls.length - 1] ?? answers[answers.length - 1]
    if (!next) throw new Error('fake exhausted')
    return next
  }
  return { fn, calls }
}

const GOOD = {
  sentence:
    'Today is a meeting day. Your only real block is 14:00-16:00 — spend it on the Acme migration and nothing else. Two people are waiting on it.',
  entities: [
    { text: 'Acme migration', kind: 'issue', ref: 'RW-214' },
    { text: '14:00-16:00', kind: 'timerange', ref: '14:00-16:00' },
  ],
} satisfies SentenceDraft

beforeEach(() => invalidate('sentence:'))

// ---------------------------------------------------------------------------
// The voice checker — PRD §4 is a contract, not a preference
// ---------------------------------------------------------------------------

describe('violatesVoice', () => {
  it('flags a greeting', () => {
    expect(violatesVoice('Good morning! Today is a meeting day.')).toContain('greeting')
    expect(violatesVoice('Hi — today is a meeting day.')).toContain('greeting')
    expect(violatesVoice('Hello. The afternoon is yours.')).toContain('greeting')
  })

  it("flags the reader's name", () => {
    expect(violatesVoice('Ruud, today is a meeting day.')).toContain('name')
    expect(violatesVoice('The day is packed, ruud.')).toContain('name')
  })

  it('flags encouragement', () => {
    expect(violatesVoice("Today is a meeting day. You've got this.")).toContain('encouragement')
    expect(violatesVoice("Let's make it a productive one.")).toContain('encouragement')
    expect(violatesVoice('The afternoon is clear 💪')).toContain('encouragement')
  })

  it('flags an answer past the word cap', () => {
    const long = `The day is busy. ${Array.from({ length: 70 }, () => 'work').join(' ')}.`
    expect(long.trim().split(/\s+/).length).toBeGreaterThan(MAX_WORDS)
    expect(violatesVoice(long)).toContain('word-count')
  })

  it('flags restating counts the reader can see below it', () => {
    expect(violatesVoice('You have 4 meetings and 3 tasks due today.')).toContain('restates-counts')
    expect(violatesVoice('Four meetings and three issues, then the day is yours.')).toContain(
      'restates-counts',
    )
  })

  it('catches the whole PRD §4 "wrong" example at once', () => {
    const wrong =
      "Good morning! You have 4 meetings and 3 tasks due today. You've got this — let's make it a productive one!"
    expect(violatesVoice(wrong).sort()).toEqual(
      ['encouragement', 'greeting', 'restates-counts'].sort(),
    )
  })

  it('passes the PRD §4 "right" example', () => {
    expect(violatesVoice(GOOD.sentence)).toEqual([])
  })

  it('allows a single count that carries a judgement', () => {
    // PRD's own midday example. One count is prose; two in a row is the dashboard read aloud.
    expect(violatesVoice('Two meetings down. The block you protected starts in 40 minutes.')).toEqual(
      [],
    )
  })

  it('flags an Inbox item as the recommendation', () => {
    expect(
      violatesVoice('Start with RW-900 before the afternoon goes.', {
        forbiddenIdentifiers: ['RW-900'],
      }),
    ).toContain('inbox-recommendation')
  })
})

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe('validateEntities', () => {
  it('drops entities whose text is not a substring of the sentence', () => {
    const entities = validateEntities('Today is a meeting day.', [
      { text: 'meeting day', kind: 'meeting', ref: 'evt-a' },
      { text: 'Acme migration', kind: 'issue', ref: 'RW-214' },
    ])
    expect(entities).toEqual([{ text: 'meeting day', kind: 'meeting', ref: 'evt-a' }])
  })

  it('drops unknown kinds, empty refs and duplicates', () => {
    const entities = validateEntities('Acme sync at 09:00.', [
      { text: 'Acme sync', kind: 'spaceship', ref: 'evt-a' },
      { text: 'Acme sync', kind: 'meeting', ref: '' },
      { text: 'Acme sync', kind: 'meeting', ref: 'evt-a' },
      { text: 'Acme sync', kind: 'meeting', ref: 'evt-a' },
    ])
    expect(entities).toEqual([{ text: 'Acme sync', kind: 'meeting', ref: 'evt-a' }])
  })

  it('drops an entity pointing at a forbidden Inbox issue', () => {
    expect(
      validateEntities('RW-900 is waiting.', [{ text: 'RW-900', kind: 'issue', ref: 'RW-900' }], [
        'RW-900',
      ]),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Registers, hashing and the fallback
// ---------------------------------------------------------------------------

describe('window selection', () => {
  it('uses the clock when something is scheduled', () => {
    expect(windowFor(model({ now: new Date(at('08:30')) }))).toBe('morning')
    expect(windowFor(model({ now: new Date(at('12:30')) }))).toBe('midday')
    expect(windowFor(model({ now: new Date(at('17:30')) }))).toBe('evening')
  })

  it('uses the empty register when nothing is scheduled', () => {
    const quiet = model({
      timeline: { allDay: [], rows: [], bookedMinutes: 0, freeMinutes: 480, availableMinutes: 480 },
    })
    expect(isEmptyDay(quiet)).toBe(true)
    expect(windowFor(quiet)).toBe('empty')
  })
})

describe('inputHash', () => {
  it('is stable while the material facts are, and moves when they are not', () => {
    const base = model()
    expect(inputHash(base)).toBe(inputHash(model({ now: new Date(at('08:47')) })))
    expect(inputHash(base)).not.toBe(inputHash(model({ ranked: [] })))
    expect(inputHash(base)).not.toBe(
      inputHash(model({ attention: [{ text: 'Double-booked at 11:00', href: '#' }] })),
    )
  })
})

describe('deterministicSentence', () => {
  it('states the shape of the day and points at one thing', () => {
    const { text, entities } = deterministicSentence(model())
    expect(text).toBe('Two meetings today, and 2H clear this afternoon. RW-214 is the one that matters.')
    expect(entities).toEqual([{ text: 'RW-214', kind: 'issue', ref: 'RW-214' }])
  })

  it('never points at an Inbox item', () => {
    const onlyInbox = model({ ranked: [ranked({ identifier: 'RW-900', state: 'Inbox' })] })
    expect(deterministicSentence(onlyInbox).text).not.toContain('RW-900')
  })

  it('names the freedom on an empty day', () => {
    const quiet = model({ timeline: { allDay: [], rows: [], bookedMinutes: 0, freeMinutes: 480, availableMinutes: 480 } })
    expect(deterministicSentence(quiet).text).toMatch(/^Nothing on the calendar today/)
  })

  it('is itself within the voice', () => {
    expect(violatesVoice(deterministicSentence(model()).text)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe('generateSentence', () => {
  it('returns the model answer when it holds the voice, with validated entities', async () => {
    const fake = fakeCompleter(GOOD)
    const result = await generateSentence(model(), fake.fn)

    expect(fake.calls).toHaveLength(1)
    expect(result.text).toBe(GOOD.sentence)
    expect(result.window).toBe('morning')
    expect(result.inputHash).toBe(inputHash(model()))
    expect(result.entities.map((e) => e.ref)).toEqual(['RW-214', '14:00-16:00'])
  })

  it('drops an entity the UI could not linkify', async () => {
    const fake = fakeCompleter({
      sentence: 'Today is a meeting day. The afternoon is the only clear run.',
      entities: [
        { text: 'the only clear run', kind: 'timerange', ref: '14:00-16:00' },
        { text: 'Acme migration', kind: 'issue', ref: 'RW-214' },
      ],
    })
    const result = await generateSentence(model(), fake.fn)
    expect(result.entities).toEqual([
      { text: 'the only clear run', kind: 'timerange', ref: '14:00-16:00' },
    ])
  })

  it('retries exactly once, naming the breach back to the model', async () => {
    const fake = fakeCompleter({ sentence: 'Good morning! Big day.', entities: [] }, GOOD)
    const result = await generateSentence(model(), fake.fn)

    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1].user).toContain('Your previous answer was rejected')
    expect(fake.calls[1].user).toContain('Never greet')
    expect(result.text).toBe(GOOD.sentence)
  })

  it('falls back to the deterministic sentence after a second violation', async () => {
    const fake = fakeCompleter(
      { sentence: 'Good morning! Big day.', entities: [] },
      { sentence: "Hello Ruud — you've got this.", entities: [] },
    )
    const result = await generateSentence(model(), fake.fn)

    expect(fake.calls).toHaveLength(2)
    expect(result.text).toBe(deterministicSentence(model()).text)
    expect(result.entities).toEqual([{ text: 'RW-214', kind: 'issue', ref: 'RW-214' }])
  })

  it('never renders nothing when the gateway fails', async () => {
    const exploding: SentenceCompleter = async () => {
      throw new Error('AI gateway returned 503')
    }
    const result = await generateSentence(model(), exploding)
    expect(result.text).toBe(deterministicSentence(model()).text)
    expect(result.window).toBe('morning')
  })

  it('never lets an Inbox item be the recommendation', async () => {
    const fake = fakeCompleter(
      {
        sentence: 'Today is a meeting day. Start with RW-900 before the afternoon goes.',
        entities: [{ text: 'RW-900', kind: 'issue', ref: 'RW-900' }],
      },
      GOOD,
    )
    const result = await generateSentence(model(), fake.fn)

    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1].user).toContain('never recommend one')
    expect(result.text).not.toContain('RW-900')
    expect(result.entities.map((e) => e.ref)).not.toContain('RW-900')
  })

  it('falls back rather than shipping a second Inbox recommendation', async () => {
    const bad = {
      sentence: 'Today is a meeting day. Start with RW-900 before the afternoon goes.',
      entities: [{ text: 'RW-900', kind: 'issue', ref: 'RW-900' }],
    }
    const fake = fakeCompleter(bad, bad)
    const result = await generateSentence(model(), fake.fn)
    expect(result.text).not.toContain('RW-900')
    expect(result.text).toBe(deterministicSentence(model()).text)
  })

  it('caches on the input hash, so a second render costs nothing', async () => {
    const fake = fakeCompleter(GOOD)
    await generateSentence(model(), fake.fn)
    await generateSentence(model({ now: new Date(at('08:52')) }), fake.fn)
    expect(fake.calls).toHaveLength(1)
  })

  it('tells the model which register it is writing in, and never leaks Inbox as recommendable', async () => {
    const fake = fakeCompleter(GOOD)
    await generateSentence(model(), fake.fn)
    expect(fake.calls[0].system).toBe(sentenceSystemPrompt('morning'))
    expect(fake.calls[0].user).toContain('NOT recommendable')
    expect(fake.calls[0].user).toContain('RW-900')
  })
})

describe('prompts', () => {
  it('pins the output language on every system prompt', () => {
    for (const prompt of ALL_SYSTEM_PROMPTS) expect(prompt).toContain(LOCALE_INSTRUCTION)
  })
})

describe('the weekend register (PRD §9)', () => {
  const saturday = new Date('2026-09-12T14:00:00+02:00')
  const sunday = new Date('2026-09-13T09:00:00+02:00')
  const friday = new Date('2026-09-11T14:00:00+02:00')

  it('overrides the clock on Saturday and Sunday', () => {
    // A Saturday afternoon is still a Saturday: "the afternoon is open" is technically
    // true and completely wrong.
    expect(windowFor(model({ now: saturday }))).toBe('weekend')
    expect(windowFor(model({ now: sunday }))).toBe('weekend')
  })

  it('leaves weekdays alone', () => {
    expect(windowFor(model({ now: friday }))).not.toBe('weekend')
  })

  it('says so plainly in the deterministic fallback', () => {
    const out = deterministicSentence(model({ now: saturday }), 'weekend')
    expect(out.text.toLowerCase()).toContain('weekend')
    expect(out.text, 'never tells the reader to work').not.toMatch(/use it to|spend it on|finish/i)
  })

  it('the weekend fallback still passes the voice rules', () => {
    const out = deterministicSentence(model({ now: saturday }), 'weekend')
    expect(violatesVoice(out.text)).toEqual([])
  })
})
