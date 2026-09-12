import { describe, expect, it, vi } from 'vitest'

import {
  buildIssueDrill,
  excerptOf,
  isInviteReply,
  issueTokens,
  relatedIssues,
  senderOf,
  toMailRows,
  toMeetingRows,
} from './issue'
import { ISSUE_BLOCK_ORDER } from './blocks'
import type { LinearIssue, OmniDocument } from '../types'

/**
 * The issue drill-in (PRD §8, "Other drill-in types").
 *
 * The fixtures are shaped like the live systems, not like the happy path: Dutch titles,
 * the real provenance format, Omni's flat-vs-nested extras, and the calendar-response mail
 * that swamped the email block on the first live run.
 */

function issue(over: Partial<LinearIssue> & { identifier: string }): LinearIssue {
  return {
    title: 'Concept: Knowledge Network portal',
    description: null,
    dueDate: null,
    priority: 0,
    state: 'Ready',
    labels: [],
    url: `https://linear.app/neworange/issue/${over.identifier}`,
    hasRelations: false,
    createdAt: '2026-09-11T09:07:47.794Z',
    updatedAt: '2026-09-11T15:18:16.444Z',
    ...over,
  }
}

function doc(over: Partial<OmniDocument> & { id: string }): OmniDocument {
  return {
    title: 'Bijpraten BOVAG',
    url: 'https://app.fireflies.ai/view/abc',
    snippet: '',
    sourceType: 'fireflies',
    date: '2026-09-11T08:00:00Z',
    ...over,
  }
}

const TRANSCRIPT_ID = '01M27T2KN8ENXYZD57Q43E1MM0'

const EXTRACTED = issue({
  identifier: 'RW-769',
  description: `Maakt gedeelde content vindbaar\n\nProvenance: Omni fireflies/${TRANSCRIPT_ID}; evidence 2026-09-11`,
})

describe('issueTokens', () => {
  it('keeps the long Dutch compounds that actually retrieve, longest first', () => {
    const tokens = issueTokens(
      issue({ identifier: 'RW-1', title: 'Valk AI-verbruikskosten ophalen en delen met Misja' }),
    )
    expect(tokens[0]).toBe('ai-verbruikskosten')
    expect(tokens).not.toContain('met')
    expect(tokens).not.toContain('en')
  })

  it('keeps a hyphenated compound whole', () => {
    // Splitting on the hyphen would reduce "Self-service Portal" to "service", which
    // retrieves half the board. The compound is the topic.
    expect(issueTokens(issue({ identifier: 'RW-1', title: 'Self-service Portal' }))).toContain(
      'self-service',
    )
  })

  it('returns nothing retrievable for a title made of stopwords', () => {
    expect(issueTokens(issue({ identifier: 'RW-1', title: 'Een van der het' }))).toEqual([])
  })
})

describe('relatedIssues', () => {
  it('finds neighbours by shared subject words, never itself', () => {
    const self = issue({ identifier: 'RW-769', title: 'Self-service Portal uitwerken' })
    const others = [
      issue({ identifier: 'RW-97', title: 'Self-service Portal verder uitwerken voor pilot' }),
      issue({ identifier: 'RW-500', title: 'Iets heel anders' }),
    ]
    const found = relatedIssues(self, [self, ...others])
    expect(found.map((i) => i.identifier)).toEqual(['RW-97'])
  })
})

describe('the email block', () => {
  it('recognises the invitation replies Outlook generates, in both languages', () => {
    expect(isInviteReply('Declined: Self-service Portal')).toBe(true)
    expect(isInviteReply('Geaccepteerd: Self-service Portal')).toBe(true)
    expect(isInviteReply('Accepted: Self-service Portal')).toBe(true)
    expect(isInviteReply('Voorlopig geaccepteerd: Self-service Portal')).toBe(true)
    // Real correspondence about the same subject must survive.
    expect(isInviteReply('Self-service Portal')).toBe(false)
    expect(isInviteReply('Re: Self-service Portal')).toBe(false)
  })

  it('drops the replies and keeps the conversation', () => {
    // On the first live run four of six rows were invitation responses, which pushed the
    // actual thread out of the block entirely.
    const rows = toMailRows([
      doc({ id: '1', title: 'Declined: Self-service Portal', sourceType: 'outlook', date: '2026-09-09' }),
      doc({ id: '2', title: 'Geaccepteerd: Self-service Portal', sourceType: 'outlook', date: '2026-09-08' }),
      doc({ id: '3', title: 'Self-service Portal', sourceType: 'outlook', date: '2026-09-08' }),
    ])
    expect(rows.map((r) => r.subject)).toEqual(['Self-service Portal'])
  })

  it('collapses a thread to its most recent message', () => {
    const rows = toMailRows([
      doc({ id: '1', title: 'ISO roadmap', sourceType: 'outlook', date: '2026-09-11' }),
      doc({ id: '2', title: 'Re: ISO roadmap', sourceType: 'outlook', date: '2026-09-10' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].date).toBe('2026-09-11')
  })

  it('reads the sender out of the indexed header block', () => {
    expect(senderOf('Subject: ISO roadmap\nFrom: Ruud van Falier <ruud@x.nl>\nTo: marc@x.nl')).toBe(
      'Ruud van Falier',
    )
    expect(senderOf('no headers here')).toBeNull()
  })

  it('strips the header block out of the excerpt', () => {
    const body = 'Subject: ISO roadmap\nFrom: Ruud <r@x.nl>\nDate: 2026-09-11\n\nTijdens deze meeting kijken we naar openstaand werk.'
    expect(excerptOf(body)).toBe('Tijdens deze meeting kijken we naar openstaand werk.')
  })
})

describe('the meetings block', () => {
  const reference = Date.parse('2026-09-12T00:00:00Z')

  it('carries the Graph event id through, so a row is a real drill target', () => {
    const rows = toMeetingRows(
      [doc({ id: '1', title: 'Self-service Portal', sourceType: 'outlook_calendar', eventId: 'AAMk_id=' })],
      reference,
    )
    expect(rows[0].eventId).toBe('AAMk_id=')
  })

  it('separates what has happened from what has not', () => {
    const rows = toMeetingRows(
      [
        doc({ id: '1', title: 'Later', sourceType: 'outlook_calendar', date: '2026-11-24T09:00:00Z' }),
        doc({ id: '2', title: 'Earlier', sourceType: 'outlook_calendar', date: '2026-09-03T09:00:00Z' }),
      ],
      reference,
    )
    expect(rows.map((r) => [r.title, r.upcoming])).toEqual([
      ['Later', true],
      ['Earlier', false],
    ])
  })

  it('collapses a recurring series to its most recent occurrence', () => {
    const rows = toMeetingRows(
      [
        doc({ id: '1', title: 'Wekelijks overleg', sourceType: 'outlook_calendar', date: '2026-09-03T09:00:00Z' }),
        doc({ id: '2', title: 'Wekelijks overleg', sourceType: 'outlook_calendar', date: '2026-09-10T09:00:00Z' }),
      ],
      reference,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].date).toBe('2026-09-10T09:00:00Z')
  })
})

describe('buildIssueDrill', () => {
  const now = () => 0

  it('lays out the issue vocabulary, always five, always in order', async () => {
    const payload = await buildIssueDrill('RW-769', {
      loadIssues: async () => [EXTRACTED],
      omniSearch: async () => ({ ok: true, documents: [] }),
      now,
    })
    expect(payload.blocks.map((b) => b.id)).toEqual([...ISSUE_BLOCK_ORDER])
    expect(payload.action).toEqual({
      label: 'Open in Linear',
      href: 'https://linear.app/neworange/issue/RW-769',
    })
  })

  it('fetches the one transcript the task points at rather than searching for it', async () => {
    const loadDocument = vi.fn(async (id: string) => ({
      ok: true as const,
      document: doc({ id, snippet: 'Ruud stelde een kennisportaal voor.' }),
    }))
    const omniSearch = vi.fn(async () => ({ ok: true as const, documents: [] }))
    const synthesise = vi.fn(async () => ({
      prose: 'Ruud proposed a portal; Tom suggested a leaderboard.',
      sources: [{ label: 'Bijpraten BOVAG, 11 Sep' }],
      inferred: false,
      statements: [],
      empty: false,
    }))

    const payload = await buildIssueDrill('RW-769', {
      loadIssues: async () => [EXTRACTED],
      loadDocument,
      omniSearch,
      synthesise,
      now,
    })

    expect(loadDocument).toHaveBeenCalledWith(TRANSCRIPT_ID)
    // The pointer is exact, so the fallback search over 609 transcripts never runs.
    expect(omniSearch).not.toHaveBeenCalledWith(expect.anything(), ['fireflies'], expect.anything())

    const said = payload.blocks.find((b) => b.id === 'said')!
    expect(said.status).toBe('ok')
    expect((said.data as { prose: string }).prose).toContain('leaderboard')
  })

  it('falls back to a search when the pointer leads nowhere', async () => {
    // A dead id is a reason to look elsewhere, not a reason to show an error.
    const omniSearch = vi.fn(async () => ({
      ok: true as const,
      documents: [doc({ id: 'found', snippet: 'Er is over het portaal gesproken.' })],
    }))
    const synthesise = vi.fn(async () => ({
      prose: 'It came up briefly.',
      sources: [],
      inferred: true,
      statements: [],
      empty: false,
    }))

    const payload = await buildIssueDrill('RW-769', {
      loadIssues: async () => [EXTRACTED],
      loadDocument: async () => ({ ok: false as const, reason: 'error' as const, message: 'gone' }),
      omniSearch,
      synthesise,
      now,
    })

    expect(omniSearch).toHaveBeenCalledWith(expect.any(String), ['fireflies'], 6)
    expect(payload.blocks.find((b) => b.id === 'said')!.status).toBe('ok')
  })

  it('names where a task came from without showing the reader an opaque id', async () => {
    const payload = await buildIssueDrill('RW-769', {
      loadIssues: async () => [EXTRACTED],
      loadDocument: async (id) => ({ ok: true as const, document: doc({ id, snippet: 'x' }) }),
      omniSearch: async () => ({ ok: true, documents: [] }),
      synthesise: async () => ({ prose: '', sources: [], inferred: false, statements: [], empty: true }),
      now,
    })

    const detail = payload.blocks.find((b) => b.id === 'issue-detail')!
    expect(detail.status).toBe('ok')
    const data = detail.data as {
      sections: Array<{ label: string | null; body: string }>
      origin: { sourceType: string; title: string | null }
    }
    const body = data.sections.map((x) => x.body).join(' ')
    expect(body).not.toContain('Provenance:')
    expect(body).toContain('Maakt gedeelde content')
    expect(data.origin.sourceType).toBe('fireflies')
    expect(data.origin.title).toBe('Bijpraten BOVAG')
    expect(detail.sources?.[0].label).toContain('Bijpraten BOVAG')
  })

  it('fails one block without touching the other four', async () => {
    const payload = await buildIssueDrill('RW-769', {
      loadIssues: async () => [EXTRACTED],
      loadDocument: async () => ({ ok: true as const, document: doc({ id: 'x', snippet: 'y' }) }),
      synthesise: async () => ({ prose: 'Said something.', sources: [], inferred: false, statements: [], empty: false }),
      omniSearch: async () => ({ ok: false, reason: 'unreachable', message: 'Omni is down' }),
      now,
    })

    const byId = Object.fromEntries(payload.blocks.map((b) => [b.id, b.status]))
    expect(byId.meetings).toBe('failed')
    expect(byId.email).toBe('failed')
    expect(byId['issue-detail']).toBe('ok')
    expect(byId.said).toBe('ok')
    expect(byId['related-issues']).toBe('empty')
  })

  it('renders five honest containers for an identifier that is not on the board', async () => {
    const payload = await buildIssueDrill('RW-000', { loadIssues: async () => [], now })
    expect(payload.blocks.map((b) => b.status)).toEqual(Array(5).fill('empty'))
    expect(payload.action.href).toBeNull()
  })
})
