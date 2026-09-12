import { describe, it, expect } from 'vitest'
import { buildDashboard } from '../../lib/view-model'

describe.skipIf(!process.env.LINEAR_API_KEY)('dashboard composition, live', () => {
  it('builds a complete model without throwing', async () => {
    const m = await buildDashboard('default')
    expect(m.todayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Array.isArray(m.ranked)).toBe(true)
    expect(Array.isArray(m.planning)).toBe(true)
    expect(m.week).toHaveLength(5)
    expect(m.sync.sources.linear).toBe('ok')
    console.log(`  ranked=${m.ranked.length} due=${m.due.length} planning=${m.planning.length} ` +
      `allDay=${m.timeline.allDay.length} rows=${m.timeline.rows.length} attention=${m.attention.length}`)
    console.log(`  week: ${m.week.map(d => `${d.label} ${Math.round(d.bookedMinutes)}m${d.isHeavy ? '!' : ''}`).join(' ')}`)
    console.log(`  sync: ${JSON.stringify(m.sync.sources)}`)
  }, 60_000)

  it('board mode drops past events from the timeline', async () => {
    const def = await buildDashboard('default')
    const board = await buildDashboard('board')
    const pastIn = (rows: typeof def.timeline.rows) =>
      rows.filter((r) => r.kind === 'event' && r.isPast).length
    expect(pastIn(board.timeline.rows)).toBeLessThanOrEqual(pastIn(def.timeline.rows))
  }, 60_000)
})
