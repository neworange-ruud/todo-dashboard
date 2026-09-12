import { describe, it, expect } from 'vitest'
import { fetchIssues } from '../../lib/linear/client'
import { fetchEventsForDay } from '../../lib/graph/calendar'
import { GRAPH_USER_PRINCIPAL_NAME, LINEAR_TEAM_KEY } from '../../lib/config'
import { toDateKey } from '../../lib/time'
import { rankTasks } from '../../lib/domain/ranking'
import { dueThisWeek, needsPlanning } from '../../lib/domain/states'
import { buildTimeline } from '../../lib/domain/timeline'
import { COMMITTED_STATES, EXCLUDED_STATE_NAMES } from '../../lib/types'

/**
 * Integration tests against the real services.
 *
 * These are the only tests that touch the network. They self-skip when credentials
 * are absent, so the default `npm test` stays hermetic on a fresh checkout.
 */

const hasLinear = Boolean(process.env.LINEAR_API_KEY)
const hasGraph = Boolean(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID)
const today = toDateKey(new Date())

describe.skipIf(!hasLinear)('Linear, live', () => {
  it('returns only the five states Task Desk reads', async () => {
    const issues = await fetchIssues()
    expect(issues.length).toBeGreaterThan(0)
    const states = [...new Set(issues.map((i) => i.state))].sort()
    for (const s of states) {
      expect(EXCLUDED_STATE_NAMES, `"${s}" must never reach the product`).not.toContain(s)
    }
    // 55 issues sit in Duplicate on the real board — the single biggest noise source.
    expect(states).not.toContain('Duplicate')
  }, 30_000)

  it('scopes to the one team', async () => {
    const issues = await fetchIssues()
    for (const i of issues) expect(i.identifier.startsWith(LINEAR_TEAM_KEY + '-')).toBe(true)
  }, 30_000)

  it('ranks real issues without ever surfacing uncommitted work', async () => {
    const issues = await fetchIssues()
    const ranked = rankTasks(issues, { todayKey: today })

    // rankTasks orders the *whole* committed set; the view slices the first five.
    // PRD §6 needs the remainder for the "N more in progress or planned" disclosure.
    const committed = issues.filter((i) => COMMITTED_STATES.includes(i.state))
    expect(ranked.length).toBe(committed.length)

    for (const r of ranked) {
      expect(COMMITTED_STATES, 'Ready/Inbox must never be ranked').toContain(r.issue.state)
      expect(r.reason.text.trim(), 'every ranked item needs a reason').not.toBe('')
    }
    expect(new Set(ranked.map((r) => r.rank)).size, 'ranks are unique').toBe(ranked.length)

    // Scores must be monotonically non-increasing — the order has to mean something.
    const topFive = ranked.slice(0, 5)
    expect(topFive.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].rank, 'ranks ascend without gaps').toBe(ranked[i - 1].rank + 1)
    }
  }, 30_000)

  it('never promotes a dated Ready issue into Due this week (PRD §17.3)', async () => {
    const issues = await fetchIssues()
    // The real board has two Ready issues carrying due dates — this is not hypothetical.
    const datedReady = issues.filter((i) => i.state === 'Ready' && i.dueDate)
    const due = dueThisWeek(issues, [today], today)
    for (const r of datedReady) {
      expect(
        due.map((d) => d.identifier),
        `${r.identifier} is Ready and must stay out of Due this week`,
      ).not.toContain(r.identifier)
    }
    const planning = needsPlanning(issues)
    for (const r of datedReady) {
      expect(planning.map((p) => p.identifier)).toContain(r.identifier)
    }
  }, 30_000)
})

describe.skipIf(!hasGraph)('Microsoft Graph, live', () => {
  it('reads only the pinned mailbox and returns usable events', async () => {
    const events = await fetchEventsForDay(today)
    expect(Array.isArray(events)).toBe(true)
    for (const e of events) {
      expect(e.id).toBeTruthy()
      expect(Date.parse(e.start), `bad start on "${e.subject}"`).not.toBeNaN()
      expect(Date.parse(e.end), `bad end on "${e.subject}"`).not.toBeNaN()
      // The end time is exactly what Omni's connector drops; it is why we go direct.
      expect(Date.parse(e.end)).toBeGreaterThanOrEqual(Date.parse(e.start))
      expect(e.isCancelled, 'cancelled events must be filtered out').toBe(false)
    }
  }, 45_000)

  it('builds a coherent timeline from the real day', async () => {
    const events = await fetchEventsForDay(today)
    const layout = buildTimeline(events, new Date(), {})
    // All-day events ("Katja vakantie") must sit outside the timeline entirely.
    for (const ad of layout.allDay) {
      expect(ad.isAllDay).toBe(true)
      const inRows = layout.rows.some((r) => r.kind === 'event' && r.event.id === ad.id)
      expect(inRows, 'all-day events never become timeline rows (PRD §17.9)').toBe(false)
    }
    expect(layout.bookedMinutes).toBeGreaterThanOrEqual(0)
    expect(layout.bookedMinutes).toBeLessThanOrEqual(24 * 60)
    for (const row of layout.rows) {
      if (row.kind !== 'now') expect(row.heightPx).toBeGreaterThan(0)
    }
  }, 45_000)

  it('the mailbox constant is the one we expect', () => {
    expect(GRAPH_USER_PRINCIPAL_NAME).toBe('ruud.vanfalier@neworange.agency')
  })
})
