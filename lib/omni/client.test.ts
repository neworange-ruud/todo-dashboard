/**
 * Omni client tests.
 *
 * No live network: every test injects a fake `fetch`. The point of these is the failure
 * matrix — PRD §8 requires the drill-in to render "Could not reach Omni · Retry" instead of
 * an exception, so "does not throw" is a behavioural requirement, not tidiness.
 */

// lib/config imports `server-only`, which refuses to load outside a Server Component.
vi.mock('server-only', () => ({}))

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidate } from '../cache'
import { OMNI_BASE_URL } from '../config'
import {
  getDocument,
  health,
  isConfigured,
  search,
  searchByAttendees,
  SOURCE_TYPES, collapseSeries, MAX_LIMIT,
  type FetchLike,
} from './client'

const KEY = 'omni-test-key'

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function failure(status: number, statusText = ''): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => 'nope',
  } as unknown as Response
}

/** Shaped like PRD §15.5: attributes + metadata, snake_case. */
function hit(overrides: Record<string, unknown> = {}) {
  return {
    id: '01HXXXXXXXXXXXXXXXXXXXXXXX',
    title: 'Acme sync',
    content: 'We agreed to ship the migration before the end of the month.',
    attributes: { source_type: SOURCE_TYPES.transcript, date: '2026-08-28' },
    metadata: { url: 'https://app.fireflies.ai/view/abc' },
    ...overrides,
  }
}

beforeEach(() => {
  invalidate()
  process.env.OMNI_API_KEY = KEY
})

describe('configuration', () => {
  it('reports unconfigured when there is no key', () => {
    delete process.env.OMNI_API_KEY
    expect(isConfigured()).toBe(false)
  })

  it('does not throw and never calls out when unconfigured', async () => {
    delete process.env.OMNI_API_KEY
    const fetchMock = vi.fn()

    const result = await search({ query: 'acme' }, { fetch: fetchMock })

    expect(result).toEqual({
      ok: false,
      reason: 'unconfigured',
      message: expect.stringContaining('OMNI_API_KEY'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves getDocument and searchByAttendees unconfigured too', async () => {
    delete process.env.OMNI_API_KEY
    const fetchMock = vi.fn()

    const doc = await getDocument('01H', { fetch: fetchMock })
    const attendees = await searchByAttendees(['a@b.nl'], {}, { fetch: fetchMock })

    expect(doc.ok).toBe(false)
    expect(attendees.ok).toBe(false)
    expect(doc.ok === false && doc.reason).toBe('unconfigured')
    expect(attendees.ok === false && attendees.reason).toBe('unconfigured')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('search', () => {
  it('posts to the documented endpoint with a bearer token', async () => {
    const fetchMock = vi.fn(async () => ok({ results: [hit()] }))

    await search({ query: 'acme migration', sourceTypes: [SOURCE_TYPES.mail], limit: 5 }, {
      fetch: fetchMock,
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${OMNI_BASE_URL}/api/v1/search`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    // Shape confirmed against the New Orange MCP adapter's SearchRequest model.
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'acme migration',
      mode: 'hybrid',
      limit: 5,
      offset: 0,
      source_types: [SOURCE_TYPES.mail],
    })
  })

  it('clamps limit to Omni\'s accepted 1–100 range', async () => {
    const fetchMock = vi.fn(async () => ok({ results: [] }))
    await search({ query: 'x', limit: 5000 }, { fetch: fetchMock })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).limit).toBe(MAX_LIMIT)
  })

  it('does not send a request Omni would reject as unfiltered', async () => {
    // Omni requires a non-empty query OR a source/attribute filter.
    const fetchMock = vi.fn(async () => ok({ results: [] }))
    const result = await search({ query: '   ' }, { fetch: fetchMock })
    expect(result).toEqual({ ok: true, documents: [] })
    expect(fetchMock, 'no round trip burned on a known-bad request').not.toHaveBeenCalled()
  })

  it('uses the source names Omni actually supports', () => {
    // These came from the reference adapter's allowlist, not from guesswork.
    expect(SOURCE_TYPES.mail).toBe('outlook')
    expect(SOURCE_TYPES.transcript).toBe('fireflies')
    expect(SOURCE_TYPES.slack).toBe('slack')
    expect(SOURCE_TYPES.file).toBe('local_files')
    expect(SOURCE_TYPES.calendar).toBe('outlook_calendar')
  })

  it('maps the response onto OmniDocument', async () => {
    const fetchMock = vi.fn(async () => ok({ results: [hit()] }))

    const result = await search({ query: 'acme' }, { fetch: fetchMock })

    expect(result).toEqual({
      ok: true,
      documents: [
        {
          id: '01HXXXXXXXXXXXXXXXXXXXXXXX',
          title: 'Acme sync',
          url: 'https://app.fireflies.ai/view/abc',
          snippet: 'We agreed to ship the migration before the end of the month.',
          sourceType: SOURCE_TYPES.transcript,
          date: '2026-08-28',
        },
      ],
    })
  })

  it('accepts the other plausible envelopes and skips rows without an id', async () => {
    const fetchMock = vi.fn(async () =>
      ok({ documents: [hit(), { title: 'no id here' }, { score: 0.4, document: hit({ id: 'b' }) }] }),
    )

    const result = await search({ query: 'acme' }, { fetch: fetchMock })

    expect(result.ok).toBe(true)
    expect(result.ok && result.documents.map((d) => d.id)).toEqual([
      '01HXXXXXXXXXXXXXXXXXXXXXXX',
      'b',
    ])
  })

  it('maps 401 to error rather than throwing', async () => {
    const fetchMock = vi.fn(async () => failure(401, 'Unauthorized'))

    const result = await search({ query: 'acme' }, { fetch: fetchMock })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('error')
    expect(result.ok === false && result.message).toContain('401')
  })

  it('maps a network failure to unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    const result = await search({ query: 'acme' }, { fetch: fetchMock })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('unreachable')
    expect(result.ok === false && result.message).toContain(OMNI_BASE_URL)
  })

  it('maps a non-JSON body to error', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        }) as unknown as Response,
    )

    const result = await search({ query: 'acme' }, { fetch: fetchMock })

    expect(result.ok === false && result.reason).toBe('error')
  })

  it('caches a success and does not cache a failure', async () => {
    const good = vi.fn(async () => ok({ results: [hit()] }))
    await search({ query: 'cached' }, { fetch: good })
    await search({ query: 'cached' }, { fetch: good })
    expect(good).toHaveBeenCalledTimes(1)

    // A failure is not cached, so the second call really goes back to Omni. Each call now
    // spends its own full retry budget (Omni 502s intermittently under load), so the count
    // is attempts-per-call × calls rather than calls.
    const bad = vi.fn(async () => failure(500))
    await search({ query: 'uncached' }, { fetch: bad })
    const afterFirst = bad.mock.calls.length
    await search({ query: 'uncached' }, { fetch: bad })
    expect(afterFirst).toBeGreaterThan(0)
    expect(bad.mock.calls.length).toBe(afterFirst * 2)
  })

  it('retries a 502 and succeeds, so the reader never sees the blip', async () => {
    // Verified live: the search service answers 502 intermittently under load and the very
    // same request succeeds a moment later. That is a retry, not a rendered failure.
    let calls = 0
    const flaky = vi.fn(async () => {
      calls += 1
      return calls === 1 ? failure(502) : ok({ results: [hit()] })
    })
    const result = await search({ query: 'flaky-502' }, { fetch: flaky })
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('does not retry an answer, only weather', async () => {
    // 401 means the key is wrong. Asking three times does not make it right.
    const denied = vi.fn(async () => failure(401))
    const result = await search({ query: 'denied-401' }, { fetch: denied })
    expect(result.ok).toBe(false)
    expect(denied).toHaveBeenCalledTimes(1)
  })
})

describe('getDocument', () => {
  it('returns a single mapped document', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => ok({ document: hit({ id: 'doc-1' }) }))

    const result = await getDocument('doc-1', { fetch: fetchMock })

    expect(result.ok && result.document.id).toBe('doc-1')
    expect(fetchMock.mock.calls[0][0]).toBe(`${OMNI_BASE_URL}/api/v1/documents/doc-1`)
  })
})

describe('health', () => {
  it('calls the unauthenticated endpoint without a key present', async () => {
    delete process.env.OMNI_API_KEY
    const fetchMock = vi.fn<FetchLike>(async () =>
      ok({ status: 'healthy', services: { postgres: 'ok', searcher: { status: 'ok' } } }),
    )

    const result = await health({ fetch: fetchMock })

    expect(result).toEqual({
      ok: true,
      health: { status: 'healthy', services: { postgres: 'ok', searcher: 'ok' } },
    })
    const init = fetchMock.mock.calls[0][1]!
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})

describe('searchByAttendees', () => {
  it('merges the attendee and keyword passes, dedupes by id, newest first', async () => {
    const attendeeHits = [
      hit({ id: 'shared', attributes: { source_type: SOURCE_TYPES.mail, date: '2026-08-01' } }),
      hit({ id: 'old-mail', attributes: { source_type: SOURCE_TYPES.mail, date: '2026-07-01' } }),
    ]
    const keywordHits = [
      // Same document surfaced by both passes — must appear once.
      hit({ id: 'shared', attributes: { source_type: SOURCE_TYPES.mail, date: '2026-08-01' } }),
      // The round-2 answer 6 case: the topic came up in a meeting these people were not in.
      hit({ id: 'other-meeting', attributes: { source_type: SOURCE_TYPES.transcript, date: '2026-09-02' } }),
    ]

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as { query: string }
      return ok({ results: body.query.includes('@') ? attendeeHits : keywordHits })
    })

    const result = await searchByAttendees(
      ['Marieke@Acme.nl', 'marieke@acme.nl', 'ruud@neworange.agency'],
      { keywords: 'migration' },
      { fetch: fetchMock },
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.ok && result.documents.map((d) => d.id)).toEqual([
      'other-meeting',
      'shared',
      'old-mail',
    ])

    // Addresses are lower-cased and deduped before they reach the query.
    const attendeeQuery = (
      JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as { query: string }
    ).query
    expect(attendeeQuery).toBe('marieke@acme.nl ruud@neworange.agency')
  })

  it('keeps the surviving pass when the other one fails', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as { query: string }
      if (body.query.includes('@')) return failure(500)
      return ok({ results: [hit({ id: 'from-keywords' })] })
    })

    const result = await searchByAttendees(
      ['marieke@acme.nl'],
      { keywords: 'migration' },
      { fetch: fetchMock },
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.documents.map((d) => d.id)).toEqual(['from-keywords'])
  })

  it('reports a failure only when every pass fails', async () => {
    const fetchMock = vi.fn(async () => failure(401))

    const result = await searchByAttendees(
      ['marieke@acme.nl'],
      { keywords: 'migration' },
      { fetch: fetchMock },
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('error')
  })

  it('runs the attendee pass alone when there are no keywords', async () => {
    const fetchMock = vi.fn(async () => ok({ results: [hit()] }))

    await searchByAttendees(['marieke@acme.nl'], {}, { fetch: fetchMock })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('collapseSeries', () => {
  const doc = (id: string, title: string, sourceType: string, date: string) =>
    ({ id, title, sourceType, date, url: null, snippet: '' }) as never

  it('keeps only the most recent occurrence of a recurring meeting', () => {
    // Sorted newest-first, as the caller guarantees.
    const out = collapseSeries([
      doc('a', 'Bijpraten BOVAG', 'outlook_calendar', '2026-09-11'),
      doc('b', 'Bijpraten BOVAG', 'outlook_calendar', '2026-08-14'),
      doc('c', 'Bijpraten BOVAG', 'outlook_calendar', '2026-07-10'),
      doc('d', '1:1 Jorien', 'outlook_calendar', '2026-09-01'),
    ])
    expect(out.map((d) => d.id)).toEqual(['a', 'd'])
  })

  it('collapses recurring transcripts too', () => {
    const out = collapseSeries([
      doc('a', 'Weekly sync', 'fireflies', '2026-09-11'),
      doc('b', 'Weekly sync', 'fireflies', '2026-09-04'),
    ])
    expect(out).toHaveLength(1)
  })

  it('never collapses mail — a repeated subject is a thread, not a repeat', () => {
    const out = collapseSeries([
      doc('a', 'Re: migration', 'outlook', '2026-09-11'),
      doc('b', 'Re: migration', 'outlook', '2026-09-10'),
    ])
    expect(out, 'each message may say something different').toHaveLength(2)
  })

  it('is case- and whitespace-insensitive but keeps untitled documents', () => {
    const out = collapseSeries([
      doc('a', 'Bijpraten BOVAG', 'outlook_calendar', '2026-09-11'),
      doc('b', '  bijpraten bovag  ', 'outlook_calendar', '2026-08-14'),
      doc('c', '', 'outlook_calendar', '2026-08-01'),
      doc('d', '', 'outlook_calendar', '2026-07-01'),
    ])
    expect(out.map((d) => d.id)).toEqual(['a', 'c', 'd'])
  })
})
