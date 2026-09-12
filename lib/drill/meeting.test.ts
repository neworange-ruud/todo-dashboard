import { describe, expect, it, vi } from 'vitest'

import {
  BLOCK_ORDER,
  buildMeetingDrill,
  companyFromEmail,
  externalCompanies,
  relatedIssues,
  safeMessage,
  type MeetingDrillDeps,
} from './meeting'
import type { CalendarEvent, LinearIssue, OmniDocument } from '../types'

/**
 * The drill-in's contract with the panel (PRD §8).
 *
 * The point of these tests is containment: five blocks come back in a fixed order no
 * matter which sources are down, and `buildMeetingDrill` never rejects. Everything is a
 * fake — no network, no clock dependence.
 */

const event: CalendarEvent = {
  id: 'evt-1',
  subject: 'Acme migration sync',
  start: '2026-09-11T09:00:00+02:00',
  end: '2026-09-11T09:30:00+02:00',
  isAllDay: false,
  isCancelled: false,
  location: 'Teams',
  organizer: { email: 'ruud.vanfalier@neworange.agency', name: 'Ruud', isOrganizer: true },
  attendees: [
    { email: 'ruud.vanfalier@neworange.agency', name: 'Ruud', isOrganizer: true },
    { email: 'jorien@acme.nl', name: 'Jorien de Vries', isOrganizer: false },
    { email: 'sam@acme.nl', name: 'Sam Bakker', isOrganizer: false },
  ],
  webLink: 'https://outlook.office.com/calendar/evt-1',
}

const issues: LinearIssue[] = [
  {
    identifier: 'RW-214',
    title: 'Acme migration cutover plan',
    dueDate: '2026-09-12',
    description: null,
    priority: 0,
    state: 'In Progress',
    labels: ['migration'],
    url: 'https://linear.app/rw/issue/RW-214',
    hasRelations: true,
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-09-10T10:00:00Z',
  },
  {
    identifier: 'RW-900',
    title: 'Rewrite the invoice footer',
    dueDate: null,
    description: null,
    priority: 0,
    state: 'Ready',
    labels: [],
    url: 'https://linear.app/rw/issue/RW-900',
    hasRelations: false,
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-09-10T10:00:00Z',
  },
]

const docs: OmniDocument[] = [
  {
    id: 'doc-1',
    title: 'Acme sync, 28 Aug',
    url: 'https://omni.local/doc-1',
    snippet: 'We agreed to move the cutover to September.',
    sourceType: 'transcript',
    date: '2026-08-28',
  },
]

/** Every source healthy. Individual tests break exactly one leg. */
function workingDeps(): MeetingDrillDeps {
  return {
    loadEvent: async () => event,
    loadIssues: async () => issues,
    loadOmniDocs: async () => ({ ok: true, documents: docs }),
    loadAccount: async () => ({
      ok: true,
      data: {
        companyId: 'c-1',
        companyName: 'Acme',
        stage: 'Active',
        health: 'Green',
        openOpportunities: [],
        lastInvoice: null,
        partial: [],
      },
    }),
    lastTime: async () => ({
      prose: 'You met on 28 August and agreed to move the cutover.',
      sources: [{ label: 'Acme sync, 28 Aug', url: 'https://omni.local/doc-1' }],
      inferred: false,
    }),
    unresolved: async () => ({
      prose: 'Nobody confirmed who owns the DNS switch.',
      sources: [],
      inferred: true,
    }),
  }
}

const statusOf = (blocks: { id: string; status: string }[], id: string) =>
  blocks.find((b) => b.id === id)?.status

describe('buildMeetingDrill', () => {
  it('returns the five blocks in the fixed order (PRD §8)', async () => {
    const drill = await buildMeetingDrill('evt-1', workingDeps())

    expect(drill.blocks.map((b) => b.id)).toEqual([...BLOCK_ORDER])
    expect(drill.blocks.every((b) => b.status === 'ok')).toBe(true)
    expect(drill.title).toBe('Acme migration sync')
    expect(drill.action).toEqual({
      label: 'Open in Outlook',
      href: 'https://outlook.office.com/calendar/evt-1',
    })
  })

  it('gives every block its own status, timing and sources', async () => {
    const drill = await buildMeetingDrill('evt-1', workingDeps())
    const lastTime = drill.blocks.find((b) => b.id === 'last-time')

    expect(lastTime?.sources).toEqual([
      { label: 'Acme sync, 28 Aug', url: 'https://omni.local/doc-1' },
    ])
    for (const block of drill.blocks) {
      expect(typeof block.elapsedMs).toBe('number')
      expect(block.elapsedMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps every block when every single source fails, and never throws', async () => {
    const boom = () => Promise.reject(new Error('nope'))
    const drill = await buildMeetingDrill('evt-1', {
      loadEvent: async () => event,
      loadIssues: boom,
      loadOmniDocs: async () => ({
        ok: false,
        reason: 'unconfigured',
        message: 'Omni is not configured.',
      }),
      loadAccount: async () => ({
        ok: false,
        reason: 'unreachable',
        message: 'Brain did not answer.',
      }),
    })

    expect(drill.blocks.map((b) => b.id)).toEqual([...BLOCK_ORDER])
    // Attendees come out of the calendar payload, so they survive everything else dying.
    expect(statusOf(drill.blocks, 'attendees')).toBe('ok')
    expect(statusOf(drill.blocks, 'action-items')).toBe('failed')
    expect(statusOf(drill.blocks, 'last-time')).toBe('failed')
    expect(statusOf(drill.blocks, 'account')).toBe('failed')
    expect(statusOf(drill.blocks, 'unresolved')).toBe('failed')
    for (const block of drill.blocks.filter((b) => b.status === 'failed')) {
      expect(block.error, 'a failed block must say what could not be reached').toBeTruthy()
    }
  })

  it('reads an unconfigured CRM as empty rather than as a failure', async () => {
    const drill = await buildMeetingDrill('evt-1', {
      ...workingDeps(),
      loadAccount: async () => ({
        ok: false,
        reason: 'unconfigured',
        message: 'Brain is not configured.',
      }),
    })

    // Nothing found is a true statement; "could not reach" would not be.
    expect(statusOf(drill.blocks, 'account')).toBe('empty')
  })

  it('reads no related issues and no documents as empty, not as an error', async () => {
    const drill = await buildMeetingDrill('evt-1', {
      ...workingDeps(),
      loadIssues: async () => [],
      loadOmniDocs: async () => ({ ok: true, documents: [] }),
    })

    expect(statusOf(drill.blocks, 'action-items')).toBe('empty')
    expect(statusOf(drill.blocks, 'last-time')).toBe('empty')
    expect(statusOf(drill.blocks, 'unresolved')).toBe('empty')
  })

  it('still returns five blocks when the event itself cannot be found', async () => {
    const drill = await buildMeetingDrill('missing', {
      loadEvent: async () => null,
    })

    expect(drill.blocks.map((b) => b.id)).toEqual([...BLOCK_ORDER])
    expect(drill.blocks.every((b) => b.status === 'empty')).toBe(true)
    expect(drill.action.label).toBe('Open in Outlook')
  })

  it('does not reject when the calendar lookup itself blows up', async () => {
    const drill = await buildMeetingDrill('evt-1', {
      loadEvent: () => Promise.reject(new Error('Graph is down')),
    })

    expect(drill.blocks).toHaveLength(BLOCK_ORDER.length)
  })

  it('never asks Omni twice for the two prose blocks', async () => {
    const loadOmniDocs = vi.fn(async () => ({ ok: true as const, documents: docs }))
    await buildMeetingDrill('evt-1', { ...workingDeps(), loadOmniDocs })

    expect(loadOmniDocs).toHaveBeenCalledTimes(1)
  })

  it('says Nothing found when synthesis has nothing to say, rather than inventing prose', async () => {
    const drill = await buildMeetingDrill('evt-1', {
      ...workingDeps(),
      lastTime: async () => ({ prose: '   ', sources: [], inferred: false }),
      loadAccount: async () => ({ ok: true, data: null }),
    })

    expect(statusOf(drill.blocks, 'last-time')).toBe('empty')
    // An account Brain does not know is Nothing found, not a failure.
    expect(statusOf(drill.blocks, 'account')).toBe('empty')
  })

  it('contains a synthesis failure inside its own block', async () => {
    const drill = await buildMeetingDrill('evt-1', {
      ...workingDeps(),
      unresolved: () => Promise.reject(new Error('The model gateway timed out')),
    })

    expect(statusOf(drill.blocks, 'unresolved')).toBe('failed')
    expect(statusOf(drill.blocks, 'last-time')).toBe('ok')
    expect(drill.blocks.find((b) => b.id === 'unresolved')?.error).toBe(
      'The model gateway timed out',
    )
  })
})

describe('helpers', () => {
  it('reads the company off an external address and nothing off an internal one', () => {
    expect(companyFromEmail('jorien@acme.nl')).toBe('Acme')
    expect(companyFromEmail('ruud.vanfalier@neworange.agency')).toBeNull()
    expect(externalCompanies(event)).toEqual(['Acme'])
  })

  it('matches issues on the subject and the company, strongest first', () => {
    expect(relatedIssues(event, issues).map((i) => i.identifier)).toEqual(['RW-214'])
  })

  it('never lets a credential reach a block header', () => {
    expect(safeMessage(new Error('Bearer sk-abcdef'), 'Omni')).toBe('Could not reach Omni')
    expect(safeMessage(new Error('a'.repeat(40)), 'Omni')).toBe('Could not reach Omni')
    expect(safeMessage(new Error('Omni is not configured.'), 'Omni')).toBe(
      'Omni is not configured.',
    )
    expect(safeMessage(null, 'CRM')).toBe('Could not reach CRM')
  })
})
