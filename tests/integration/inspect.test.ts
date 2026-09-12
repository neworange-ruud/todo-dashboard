import { describe, it, expect } from 'vitest'
import { fetchIssues } from '../../lib/linear/client'
import { fetchEventsForDay } from '../../lib/graph/calendar'
import { rankTasks } from '../../lib/domain/ranking'
import { needsPlanning, provenanceOf } from '../../lib/domain/states'
import { buildTimeline } from '../../lib/domain/timeline'
import { toDateKey, formatTime, formatDuration } from '../../lib/time'

/** Diagnostic: renders the real board and day so a human can judge the output. */
describe.skipIf(!process.env.LINEAR_API_KEY)('what the real data produces', () => {
  it('top five reads like an opinion, not a dump', async () => {
    const issues = await fetchIssues()
    const today = toDateKey(new Date())
    const ranked = rankTasks(issues, { todayKey: today })

    console.log('\n  TOP FIVE')
    for (const r of ranked.slice(0, 5)) {
      console.log(`  ${r.rank}. ${r.issue.identifier.padEnd(8)} ${r.issue.state.padEnd(12)} ${r.issue.title.slice(0, 44)}`)
      console.log(`     ${r.reason.text}`)
    }
    const planning = needsPlanning(issues)
    console.log(`\n  NEEDS PLANNING (${planning.length})`)
    for (const p of planning) {
      console.log(`  ${p.state === 'Inbox' ? '*NEW' : '    '} ${p.identifier.padEnd(8)} ${p.title.slice(0, 40)} ${provenanceOf(p) ?? ''}`)
    }

    // Quality gates on the reason lines — PRD §6.
    for (const r of ranked.slice(0, 5)) {
      expect(r.reason.text.length, 'reason must be a real clause').toBeGreaterThan(4)
      expect(r.reason.text, 'reason must not be a bare identifier').not.toBe(r.issue.identifier)
    }
    expect(ranked.length).toBeGreaterThan(0)
  }, 30_000)

  it('timeline reflects the real calendar', async () => {
    const today = toDateKey(new Date())
    const events = await fetchEventsForDay(today)
    const layout = buildTimeline(events, new Date(), {})
    console.log(`\n  TIMELINE — booked ${formatDuration(layout.bookedMinutes)}, free ${formatDuration(layout.freeMinutes)}`)
    for (const ad of layout.allDay) console.log(`  [all-day] ${ad.subject}`)
    for (const row of layout.rows) {
      if (row.kind === 'event') {
        console.log(`  ${formatTime(row.event.start)}-${formatTime(row.event.end)} ${row.isNow ? '* ' : row.isPast ? '~ ' : '  '}${row.event.subject.slice(0, 40)} (${row.heightPx}px, ${row.event.attendees.length} att)`)
      } else if (row.kind === 'gap') {
        console.log(`            -- ${row.label}`)
      } else {
        console.log(`  ${row.label} ---- now ----`)
      }
    }
    expect(layout).toBeTruthy()
  }, 45_000)
})
