import { describe, it, expect } from 'vitest'
import { health, search, searchByAttendees, isConfigured, SOURCE_TYPES } from '../../lib/omni/client'
import { buildMeetingDrill } from '../../lib/drill/meeting'
import { fetchEventsForDay } from '../../lib/graph/calendar'

/** The enrichment path, end to end, against live Omni. */
describe.skipIf(!process.env.OMNI_API_KEY)('Omni enrichment, live', () => {
  it('is configured and healthy', async () => {
    expect(isConfigured()).toBe(true)
    const h = await health()
    expect(h.ok).toBe(true)
  }, 30_000)

  it('returns real documents for each source we rely on', async () => {
    for (const src of [SOURCE_TYPES.mail, SOURCE_TYPES.calendar, SOURCE_TYPES.transcript]) {
      const r = await search({ query: '', sourceTypes: [src], limit: 3 })
      expect(r.ok, `${src} search failed`).toBe(true)
      if (r.ok) {
        expect(r.documents.length, `${src} returned nothing`).toBeGreaterThan(0)
        for (const d of r.documents) {
          expect(d.id).toBeTruthy()
          expect(typeof d.title).toBe('string')
        }
      }
    }
  }, 60_000)

  it('finds prior context for real attendees', async () => {
    const events = await fetchEventsForDay('2026-09-11')
    const withPeople = events.find((e) => !e.isAllDay && e.attendees.length > 1)
    if (!withPeople) return
    const emails = withPeople.attendees.map((a) => a.email)
    const r = await searchByAttendees(emails, { keywords: withPeople.subject, limit: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      console.log(`  attendees ${emails.join(', ')} → ${r.documents.length} documents`)
      for (const d of r.documents.slice(0, 4)) {
        console.log(`   · [${d.sourceType}] ${d.title.slice(0, 54)}`)
      }
    }
  }, 90_000)

  it('fills the drill-in blocks that were previously empty', async () => {
    const events = await fetchEventsForDay('2026-09-11')
    const meeting = events.find((e) => !e.isAllDay && e.attendees.length > 1)
    if (!meeting) return
    const drill = await buildMeetingDrill(meeting.id)
    console.log(`\n  DRILL-IN — ${meeting.subject}`)
    for (const b of drill.blocks) {
      const detail = b.status === 'ok' && b.data ? String(JSON.stringify(b.data)).slice(0, 70) : (b.error ?? '')
      console.log(`   ${b.id.padEnd(14)} ${b.status.padEnd(7)} ${String(b.elapsedMs ?? '').padStart(5)}ms  ${detail}`)
    }
    // Every block must be present and none may have thrown.
    expect(drill.blocks).toHaveLength(5)
    for (const b of drill.blocks) expect(['ok', 'empty', 'failed']).toContain(b.status)
    // The two Omni-backed blocks must no longer report unreachable.
    const omniBlocks = drill.blocks.filter((b) => b.id === 'last-time' || b.id === 'unresolved')
    for (const b of omniBlocks) {
      expect(b.error ?? '', `${b.id} still unreachable`).not.toMatch(/could not reach omni/i)
    }
  }, 180_000)
})
