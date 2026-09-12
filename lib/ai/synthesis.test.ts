import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  assemble,
  lastTime,
  toSourceRef,
  unresolved,
  type SynthesisCompleter,
} from './synthesis'
import { LAST_TIME_SYSTEM_PROMPT, UNRESOLVED_SYSTEM_PROMPT } from './prompts'
import { invalidate } from '../cache'
import type { OmniFailure } from '../omni/client'
import type { CalendarEvent, OmniDocument } from '../types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEETING: CalendarEvent = {
  id: 'evt-a',
  subject: 'Acme sync',
  start: '2026-09-11T09:00:00+02:00',
  end: '2026-09-11T10:00:00+02:00',
  isAllDay: false,
  isCancelled: false,
  location: null,
  organizer: null,
  attendees: [
    { email: 'marieke@acme.nl', name: 'Marieke de Vries', isOrganizer: true },
    { email: 'jasper@acme.nl', name: null, isOrganizer: false },
  ],
  webLink: null,
}

function doc(over: Partial<OmniDocument> & { id: string }): OmniDocument {
  return {
    title: 'Meeting notes',
    url: 'https://omni.local/doc/1',
    snippet: 'Marieke vroeg om de migratie-planning voor eind augustus.',
    sourceType: 'fireflies_transcript',
    date: '2026-08-28T10:00:00+02:00',
    ...over,
  }
}

const NOTES = doc({ id: 'doc-1' })
const MAIL = doc({
  id: 'doc-2',
  title: 'RE: migration window',
  sourceType: 'outlook_mail',
  date: '2026-09-02T08:00:00+02:00',
})

function fakeCompleter(answer: unknown) {
  const calls: Array<{ system: string; user: string }> = []
  const fn: SynthesisCompleter = async (req) => {
    calls.push({ system: req.system, user: req.user })
    return answer as Awaited<ReturnType<SynthesisCompleter>>
  }
  return { fn, calls }
}

const UNREACHABLE: OmniFailure = {
  ok: false,
  reason: 'unreachable',
  message: 'Could not reach Omni',
}

beforeEach(() => invalidate('synthesis:'))

// ---------------------------------------------------------------------------
// Nothing found — PRD §8
// ---------------------------------------------------------------------------

describe('empty inputs', () => {
  it('returns a typed empty result for zero documents, without calling the model', async () => {
    const fake = fakeCompleter({ statements: [{ text: 'should never be written' }] })
    const result = await lastTime(MEETING, { ok: true, documents: [] }, fake.fn)

    expect(fake.calls).toHaveLength(0)
    expect(result).toEqual({ prose: '', sources: [], inferred: false, statements: [], empty: true })
  })

  it('returns the same empty result when Omni is unreachable, and never throws', async () => {
    const fake = fakeCompleter({ statements: [] })
    const result = await unresolved(MEETING, UNREACHABLE, fake.fn)

    expect(fake.calls).toHaveLength(0)
    expect(result.empty).toBe(true)
    expect(result.prose).toBe('')
  })

  it('accepts a bare document array as well as an Omni result', async () => {
    const fake = fakeCompleter({ statements: [] })
    const result = await lastTime(MEETING, [], fake.fn)
    expect(fake.calls).toHaveLength(0)
    expect(result.empty).toBe(true)
  })

  it('is empty when the model answers with nothing usable', async () => {
    const fake = fakeCompleter({ statements: [{ text: '   ' }, { documentId: 'doc-1' }] })
    const result = await lastTime(MEETING, [NOTES], fake.fn)
    expect(result.empty).toBe(true)
    expect(result.prose).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Sourcing — PRD §8
// ---------------------------------------------------------------------------

describe('sourcing', () => {
  it('returns prose with a source for every sourced statement', async () => {
    const fake = fakeCompleter({
      statements: [
        { text: 'You last spoke on 28 August about the migration window.', documentId: 'doc-1' },
        { text: 'Marieke confirmed the cut-over by mail a week later.', documentId: 'doc-2' },
      ],
    })
    const result = await lastTime(MEETING, { ok: true, documents: [NOTES, MAIL] }, fake.fn)

    expect(result.empty).toBe(false)
    expect(result.inferred).toBe(false)
    expect(result.prose).toBe(
      'You last spoke on 28 August about the migration window. ' +
        'Marieke confirmed the cut-over by mail a week later.',
    )
    expect(result.sources).toEqual([
      { label: 'Meeting notes, 28 Aug', url: 'https://omni.local/doc/1', documentId: 'doc-1' },
      { label: 'RE: migration window, 2 Sep', url: 'https://omni.local/doc/1', documentId: 'doc-2' },
    ])
    expect(result.statements.every((s) => s.inferred === false)).toBe(true)
  })

  it('marks an unsourceable claim inferred rather than dropping it', async () => {
    const fake = fakeCompleter({
      statements: [
        { text: 'The migration window was agreed for end of August.', documentId: 'doc-1' },
        { text: 'Nobody has confirmed the rollback plan.', documentId: '' },
      ],
    })
    const result = await unresolved(MEETING, [NOTES], fake.fn)

    expect(result.statements).toHaveLength(2)
    expect(result.prose).toContain('Nobody has confirmed the rollback plan.')
    expect(result.statements[1]).toEqual({
      text: 'Nobody has confirmed the rollback plan.',
      source: null,
      inferred: true,
    })
    expect(result.inferred).toBe(true)
  })

  it('treats a citation to a document it was never given as unsourced', async () => {
    const fake = fakeCompleter({
      statements: [{ text: 'Jasper promised the schema by Friday.', documentId: 'doc-invented' }],
    })
    const result = await unresolved(MEETING, [NOTES], fake.fn)

    expect(result.statements[0].source).toBeNull()
    expect(result.statements[0].inferred).toBe(true)
    expect(result.sources).toEqual([])
  })

  it('does not throw on a malformed answer', () => {
    expect(assemble(undefined, [NOTES]).empty).toBe(true)
    expect(assemble({ statements: 'nope' } as never, [NOTES]).empty).toBe(true)
    expect(assemble({ statements: [null, 7] } as never, [NOTES]).empty).toBe(true)
  })

  it('labels a source the way PRD §8 renders it', () => {
    expect(toSourceRef(NOTES).label).toBe('Meeting notes, 28 Aug')
    expect(toSourceRef(doc({ id: 'x', date: null })).label).toBe('Meeting notes')
  })
})

// ---------------------------------------------------------------------------
// Prompting and caching
// ---------------------------------------------------------------------------

describe('the two blocks', () => {
  it('ask different questions of the same documents', async () => {
    const answer = { statements: [{ text: 'A sourced claim.', documentId: 'doc-1' }] }
    const a = fakeCompleter(answer)
    const b = fakeCompleter(answer)

    await lastTime(MEETING, [NOTES], a.fn)
    await unresolved(MEETING, [NOTES], b.fn)

    expect(a.calls[0].system).toBe(LAST_TIME_SYSTEM_PROMPT)
    expect(b.calls[0].system).toBe(UNRESOLVED_SYSTEM_PROMPT)
    expect(a.calls[0].user).toContain('documentId: doc-1')
    expect(a.calls[0].user).toContain('Marieke de Vries <marieke@acme.nl>')
    expect(a.calls[0].user).toContain('Acme sync')
  })

  it('caches per meeting per day', async () => {
    const fake = fakeCompleter({ statements: [{ text: 'A sourced claim.', documentId: 'doc-1' }] })
    await lastTime(MEETING, [NOTES], fake.fn)
    await lastTime(MEETING, [NOTES], fake.fn)
    expect(fake.calls).toHaveLength(1)
  })

  it('lets a gateway failure surface, so the block can say so instead of lying', async () => {
    const exploding: SynthesisCompleter = async () => {
      throw new Error('AI gateway returned 503')
    }
    await expect(lastTime(MEETING, [NOTES], exploding)).rejects.toThrow('503')
  })
})
