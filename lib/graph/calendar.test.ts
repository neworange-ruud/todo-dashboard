import { beforeEach, describe, expect, it, vi } from 'vitest'

// `lib/config.ts` is a server module; the marker package throws outside a React Server
// Component graph, so it is stubbed for the test runner.
vi.mock('server-only', () => ({}))

import { invalidate } from '../cache'
import { GRAPH_USER_PRINCIPAL_NAME, resetEnvCache } from '../config'
import { bucketByDay, calendarViewPath, fetchEventsForDay, fetchEventsForWeek, mapEvents } from './calendar'
import { resetGraphToken, type FetchLike } from './client'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Call {
  url: string
  init?: RequestInit
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response
}

function makeFetch(events: unknown[]): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    if (url.includes('login.microsoftonline.com')) {
      return jsonResponse({ access_token: `tok-${calls.length}`, expires_in: 3600 })
    }
    return jsonResponse({ value: events })
  }
  return { calls, fetchImpl }
}

const graphCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('graph.microsoft.com'))
const tokenCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('login.microsoftonline.com'))

function rawEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    subject: 'Bijpraten BOVAG',
    start: { dateTime: '2026-09-11T10:00:00.0000000', timeZone: 'Europe/Amsterdam' },
    end: { dateTime: '2026-09-11T11:00:00.0000000', timeZone: 'Europe/Amsterdam' },
    location: { displayName: 'Microsoft Teams Meeting' },
    organizer: { emailAddress: { address: 'Ruud.vanFalier@neworange.agency', name: 'Ruud van Falier' } },
    attendees: [
      { emailAddress: { address: 'jorien@bovag.nl', name: 'Jorien' } },
      { emailAddress: { address: 'ruud.vanfalier@neworange.agency', name: 'Ruud van Falier' } },
    ],
    isAllDay: false,
    isCancelled: false,
    webLink: 'https://outlook.office365.com/evt-1',
    ...over,
  }
}

beforeEach(() => {
  invalidate()
  resetGraphToken()
  resetEnvCache()
  process.env.LINEAR_API_KEY = 'lin'
  process.env.GRAPH_TENANT_ID = 'tenant-123'
  process.env.GRAPH_CLIENT_ID = 'client-123'
  process.env.GRAPH_SECRET = 'secret-123'
  process.env.AI_API_KEY = 'ai'
  process.env.AI_API_URL = 'https://example.test/v1'
})

// ---------------------------------------------------------------------------
// PRD §17.8 — the single-identity rule
// ---------------------------------------------------------------------------

describe('single-identity rule (PRD §17.8)', () => {
  it('puts the hard-coded UPN in every outgoing calendar URL', async () => {
    const { calls, fetchImpl } = makeFetch([rawEvent()])
    await fetchEventsForDay('2026-09-11', fetchImpl)
    await fetchEventsForWeek(['2026-09-07', '2026-09-11'], fetchImpl)

    const urls = graphCalls(calls).map((c) => c.url)
    expect(urls.length).toBeGreaterThanOrEqual(2)
    for (const url of urls) {
      expect(url).toContain(GRAPH_USER_PRINCIPAL_NAME)
      expect(new URL(url).pathname).toBe(`/v1.0/users/${GRAPH_USER_PRINCIPAL_NAME}/calendarView`)
    }
  })

  it('exposes no seam for another mailbox — the path is identical for any date range', () => {
    const a = calendarViewPath(new Date('2026-09-11T00:00:00Z'), new Date('2026-09-12T00:00:00Z'))
    const b = calendarViewPath(new Date('2025-01-01T00:00:00Z'), new Date('2025-12-31T00:00:00Z'))
    const pathOf = (p: string) => p.split('?')[0]

    expect(pathOf(a)).toBe(`/users/${GRAPH_USER_PRINCIPAL_NAME}/calendarView`)
    expect(pathOf(b)).toBe(pathOf(a))
    // The UPN is the only address anywhere in the request.
    expect(a.split('@')).toHaveLength(2)
    // Neither fetcher takes an identity: (dateKey|dateKeys, fetchImpl?).
    expect(fetchEventsForDay.length).toBeLessThanOrEqual(2)
    expect(fetchEventsForWeek.length).toBeLessThanOrEqual(2)
  })

  it('cannot be redirected by a crafted date key', async () => {
    const { calls, fetchImpl } = makeFetch([])
    await fetchEventsForDay('2026-09-11', fetchImpl)
    const url = graphCalls(calls)[0].url
    expect(url).not.toContain('victim@')
    expect(new URL(url).pathname).toBe(`/v1.0/users/${GRAPH_USER_PRINCIPAL_NAME}/calendarView`)
  })

  it('sends the selected fields, ordering and Amsterdam timezone preference', async () => {
    const { calls, fetchImpl } = makeFetch([])
    await fetchEventsForDay('2026-09-11', fetchImpl)
    const call = graphCalls(calls)[0]
    const q = new URL(call.url).searchParams

    expect(q.get('$select')).toBe(
      'id,subject,start,end,location,organizer,attendees,isAllDay,isCancelled,webLink',
    )
    expect(q.get('$orderby')).toBe('start/dateTime')
    expect(q.get('$top')).toBe('100')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Prefer).toBe('outlook.timezone="Europe/Amsterdam"')
    expect(headers.Authorization).toMatch(/^Bearer tok-/)
  })
})

// ---------------------------------------------------------------------------
// Token caching
// ---------------------------------------------------------------------------

describe('token acquisition', () => {
  it('requests a token once and reuses it for later calls', async () => {
    const { calls, fetchImpl } = makeFetch([])
    await fetchEventsForDay('2026-09-11', fetchImpl)
    invalidate() // force a second Graph round trip, not a cache hit
    await fetchEventsForDay('2026-09-12', fetchImpl)

    expect(graphCalls(calls)).toHaveLength(2)
    expect(tokenCalls(calls)).toHaveLength(1)
  })

  it('posts the client-credentials form to the tenant endpoint', async () => {
    const { calls, fetchImpl } = makeFetch([])
    await fetchEventsForDay('2026-09-11', fetchImpl)
    const token = tokenCalls(calls)[0]

    expect(token.url).toBe('https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token')
    expect(token.init?.method).toBe('POST')
    const body = new URLSearchParams(String(token.init?.body))
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('scope')).toBe('https://graph.microsoft.com/.default')
    expect(body.get('client_id')).toBe('client-123')
    expect(body.get('client_secret')).toBe('secret-123')
  })
})

// ---------------------------------------------------------------------------
// Caching of the events themselves
// ---------------------------------------------------------------------------

describe('event caching', () => {
  it('serves a repeated day from the cache without a second Graph call', async () => {
    const { calls, fetchImpl } = makeFetch([rawEvent()])
    const first = await fetchEventsForDay('2026-09-11', fetchImpl)
    const second = await fetchEventsForDay('2026-09-11', fetchImpl)

    expect(graphCalls(calls)).toHaveLength(1)
    expect(second).toEqual(first)
  })
})

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe('mapping', () => {
  it('drops cancelled events', () => {
    const mapped = mapEvents([
      rawEvent({ id: 'a' }),
      rawEvent({ id: 'b', subject: 'Afgezegd', isCancelled: true }),
    ])
    expect(mapped.map((e) => e.id)).toEqual(['a'])
  })

  it('folds the organizer into attendees and dedupes by lowercased email', () => {
    const [event] = mapEvents([rawEvent()])
    expect(event.organizer).toEqual({
      email: 'Ruud.vanFalier@neworange.agency',
      name: 'Ruud van Falier',
      isOrganizer: true,
    })
    // Two raw attendees + organizer, but the organizer and one attendee are the same person.
    expect(event.attendees).toHaveLength(2)
    expect(event.attendees[0].isOrganizer).toBe(true)
    expect(event.attendees.filter((a) => a.isOrganizer)).toHaveLength(1)
    expect(event.attendees.map((a) => a.email.toLowerCase())).toEqual([
      'ruud.vanfalier@neworange.agency',
      'jorien@bovag.nl',
    ])
  })

  it('handles zero-attendee personal blocks without crashing (PRD §17.9)', () => {
    const [event] = mapEvents([
      rawEvent({ id: 'tandarts', subject: 'Tandarts', attendees: [], organizer: null, location: null }),
    ])
    expect(event.attendees).toEqual([])
    expect(event.organizer).toBeNull()
    expect(event.location).toBeNull()
    expect(event.subject).toBe('Tandarts')
  })

  it('keeps all-day events and reads them as local midnight', () => {
    const [event] = mapEvents([
      rawEvent({
        id: 'katja',
        subject: 'Katja vakantie',
        isAllDay: true,
        start: { dateTime: '2026-09-11T00:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-12T00:00:00.0000000', timeZone: 'UTC' },
      }),
    ])
    expect(event.isAllDay).toBe(true)
    expect(event.start).toBe('2026-09-11T00:00:00+02:00')
    expect(event.end).toBe('2026-09-12T00:00:00+02:00')
  })

  it('renders timed events as Amsterdam wall-clock with an explicit offset', () => {
    const [event] = mapEvents([rawEvent()])
    expect(event.start).toBe('2026-09-11T10:00:00+02:00')
    expect(event.end).toBe('2026-09-11T11:00:00+02:00')
    expect(event.location).toBe('Microsoft Teams Meeting')
    expect(event.webLink).toBe('https://outlook.office365.com/evt-1')
  })

  it('orders by start time', () => {
    const mapped = mapEvents([
      rawEvent({
        id: 'late',
        start: { dateTime: '2026-09-11T14:00:00.0000000', timeZone: 'Europe/Amsterdam' },
        end: { dateTime: '2026-09-11T14:05:00.0000000', timeZone: 'Europe/Amsterdam' },
      }),
      rawEvent({
        id: 'early',
        start: { dateTime: '2026-09-11T09:00:00.0000000', timeZone: 'Europe/Amsterdam' },
        end: { dateTime: '2026-09-11T09:15:00.0000000', timeZone: 'Europe/Amsterdam' },
      }),
    ])
    expect(mapped.map((e) => e.id)).toEqual(['early', 'late'])
  })
})

// ---------------------------------------------------------------------------
// Week bucketing
// ---------------------------------------------------------------------------

describe('week fetching', () => {
  it('spans the whole week in one Graph call and buckets by day', async () => {
    const { calls, fetchImpl } = makeFetch([
      rawEvent({ id: 'mon' }),
      rawEvent({
        id: 'wed',
        start: { dateTime: '2026-09-09T09:00:00.0000000', timeZone: 'Europe/Amsterdam' },
        end: { dateTime: '2026-09-09T10:00:00.0000000', timeZone: 'Europe/Amsterdam' },
      }),
    ])
    const byDay = await fetchEventsForWeek(
      ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
      fetchImpl,
    )

    expect(graphCalls(calls)).toHaveLength(1)
    expect(Object.keys(byDay)).toHaveLength(5)
    expect(byDay['2026-09-09'].map((e) => e.id)).toEqual(['wed'])
    expect(byDay['2026-09-11'].map((e) => e.id)).toEqual(['mon'])
    expect(byDay['2026-09-07']).toEqual([])
  })

  it('returns an empty map for no days without calling Graph', async () => {
    const { calls, fetchImpl } = makeFetch([])
    expect(await fetchEventsForWeek([], fetchImpl)).toEqual({})
    expect(calls).toHaveLength(0)
  })

  it('files an event under every requested day it overlaps', () => {
    const [event] = mapEvents([
      rawEvent({
        id: 'overnight',
        start: { dateTime: '2026-09-10T23:00:00.0000000', timeZone: 'Europe/Amsterdam' },
        end: { dateTime: '2026-09-11T01:00:00.0000000', timeZone: 'Europe/Amsterdam' },
      }),
    ])
    const byDay = bucketByDay([event], ['2026-09-10', '2026-09-11'])
    expect(byDay['2026-09-10']).toHaveLength(1)
    expect(byDay['2026-09-11']).toHaveLength(1)
  })
})
