import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Week from './Week'
import { TID } from '@/lib/testids'
import type { DayLoad, LinearIssue, TaskState } from '@/lib/types'

const TODAY = '2026-09-11'

function issue(
  identifier: string,
  title: string,
  state: TaskState,
  dueDate: string | null,
  labels: string[] = [],
): LinearIssue {
  return {
    identifier,
    title,
    dueDate,
    priority: 0,
    state,
    labels,
    url: `https://linear.app/rw/issue/${identifier}`,
    hasRelations: false,
    createdAt: '2026-08-28T09:00:00+02:00',
    updatedAt: '2026-09-10T16:30:00+02:00',
  }
}

const load: DayLoad[] = [
  { label: 'MON', date: '2026-09-07', bookedMinutes: 120, workdayMinutes: 480, isToday: false, isHeavy: false },
  { label: 'TUE', date: '2026-09-08', bookedMinutes: 420, workdayMinutes: 480, isToday: false, isHeavy: true },
  { label: 'WED', date: '2026-09-09', bookedMinutes: 60, workdayMinutes: 480, isToday: false, isHeavy: false },
  { label: 'THU', date: '2026-09-10', bookedMinutes: 240, workdayMinutes: 480, isToday: false, isHeavy: false },
  { label: 'FRI', date: TODAY, bookedMinutes: 195, workdayMinutes: 480, isToday: true, isHeavy: false },
]

// Already soonest-first, as `dueThisWeek` hands them over.
const due: LinearIssue[] = [
  issue('RW-339', 'Migrate the Acme mailboxes', 'In Progress', '2026-07-22'),
  issue('RW-214', 'Write the migration runbook', 'Waiting', TODAY),
  issue('RW-118', 'Close out the September invoices', 'Planned', '2026-09-12'),
  issue('RW-501', 'Review the Brain MCP client', 'Planned', '2026-09-18'),
]

// Ready first, then Inbox, as `needsPlanning` hands them over.
const planning: LinearIssue[] = [
  issue('RW-402', 'Decide on the Tailscale port', 'Ready', null),
  issue('RW-430', 'Chase the DPA with Katja', 'Ready', null),
  issue('RW-511', 'Acme asked for an export by Friday', 'Inbox', null, ['Email']),
  issue('RW-512', 'Follow up on the sync recording', 'Inbox', null, ['Transcript']),
  issue('RW-513', 'Unlabelled intake item', 'Inbox', null, []),
]

function renderWeek() {
  return render(<Week load={load} due={due} planning={planning} todayKey={TODAY} />)
}

describe('Week — load lanes', () => {
  it('draws one lane per weekday and marks today', () => {
    renderWeek()

    const lanes = screen.getAllByTestId(TID.loadLane)
    expect(lanes).toHaveLength(5)
    expect(lanes.map((lane) => lane.getAttribute('data-today'))).toEqual([
      'false',
      'false',
      'false',
      'false',
      'true',
    ])
  })

  it('gives a heavy day the warning hue and nobody else (PRD §7)', () => {
    renderWeek()

    const lanes = screen.getAllByTestId(TID.loadLane)
    expect(lanes.map((lane) => lane.getAttribute('data-heavy'))).toEqual([
      'false',
      'true',
      'false',
      'false',
      'false',
    ])
    const heavyBar = lanes[1].querySelector('[data-heavy="true"] , span span') as HTMLElement
    expect(heavyBar).not.toBeNull()
  })

  it('states the booked share as a width and names it for a screen reader, not as a badge', () => {
    renderWeek()

    const lanes = screen.getAllByTestId(TID.loadLane)
    const bar = lanes[1].querySelector('span[style]') as HTMLElement
    expect(bar.style.width).toBe('88%')
    expect(within(lanes[1]).getByRole('img')).toHaveAccessibleName('TUE: 7H booked of 8H')
  })
})

describe('Week — due this week', () => {
  it('names the count inside the header rather than in a badge', () => {
    renderWeek()

    const block = screen.getByTestId(TID.dueThisWeek)
    expect(within(block).getByText('DUE THIS WEEK')).toBeInTheDocument()
    expect(block.textContent).toContain('4')
  })

  it('renders every row in the order given, with its day label', () => {
    renderWeek()

    const rows = screen.getAllByTestId(TID.dueRow)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('51 DAYS OVER')
    expect(rows[1]).toHaveTextContent('TODAY')
    expect(rows[2]).toHaveTextContent('TOMORROW')
  })

  it('colours the dot by urgency and shapes it by state', () => {
    renderWeek()

    const dots = screen
      .getAllByTestId(TID.dueRow)
      .map((row) => row.querySelector('[data-urgency]') as HTMLElement)

    // Overdue, due today, due tomorrow, due next week.
    expect(dots.map((dot) => dot.getAttribute('data-urgency'))).toEqual([
      'critical',
      'risk',
      'risk',
      'none',
    ])
    // In Progress and Waiting are started work; Planned is not.
    expect(dots.map((dot) => dot.getAttribute('data-filled'))).toEqual([
      'true',
      'true',
      'false',
      'false',
    ])
  })
})

describe('Week — needs planning', () => {
  it('splits the header count into named halves', () => {
    renderWeek()

    const block = screen.getByTestId(TID.needsPlanning)
    expect(block.textContent).toContain('2 READY · 3 NEW')
  })

  it('shows every row — the caps are gone at real volumes (PRD §17.5)', () => {
    renderWeek()

    expect(screen.getAllByTestId(TID.planningRow)).toHaveLength(5)
    expect(screen.queryByText(/more waiting to be planned/)).not.toBeInTheDocument()
  })

  it('marks only Inbox rows with *NEW', () => {
    renderWeek()

    const rows = screen.getAllByTestId(TID.planningRow)
    const marked = rows.filter((row) => within(row).queryByTestId(TID.newMarker) !== null)
    expect(marked).toHaveLength(3)
    expect(marked.every((row) => row.textContent?.includes('*NEW'))).toBe(true)
    expect(within(rows[0]).queryByTestId(TID.newMarker)).toBeNull()
  })

  it('shows the source line only where a provenance label exists (PRD §17.6)', () => {
    renderWeek()

    const sources = screen.getAllByTestId(TID.sourceRef)
    expect(sources.map((node) => node.textContent?.trim())).toEqual(['↗ Email', '↗ Transcript'])

    const unlabelled = screen.getAllByTestId(TID.planningRow)[4]
    expect(within(unlabelled).queryByTestId(TID.sourceRef)).toBeNull()
  })
})

describe('Week — empty', () => {
  it('says so plainly rather than apologising', () => {
    render(<Week load={load} due={[]} planning={[]} todayKey={TODAY} />)

    expect(screen.getByText('Nothing due before the weekend.')).toBeInTheDocument()
    expect(screen.getByText('Nothing waiting to be planned.')).toBeInTheDocument()
    expect(screen.queryAllByTestId(TID.dueRow)).toHaveLength(0)
  })

  it('invents nothing to fill the space (PRD §9)', () => {
    const { container } = render(<Week load={load} due={[]} planning={[]} todayKey={TODAY} />)

    // No illustration, no encouragement, no call to action. Whitespace is the outcome.
    expect(container.querySelectorAll('svg, img')).toHaveLength(0)
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/great|well done|you're all caught up|🎉/i)
  })

  it('keeps the load lanes, because an empty list is not an empty week', () => {
    render(<Week load={load} due={[]} planning={[]} todayKey={TODAY} />)

    expect(screen.getAllByTestId(TID.loadLane)).toHaveLength(5)
    expect(screen.getByTestId(TID.needsPlanning).textContent).toContain('0 READY · 0 NEW')
  })
})

/**
 * Source down (PRD §9): one inline line for the affected zone, cached rows still
 * rendering behind it, and every other zone untouched.
 */
describe('Week — source down', () => {
  it('names the source and the time the cached data is from', () => {
    render(
      <Week
        load={load}
        due={due}
        planning={planning}
        todayKey={TODAY}
        unavailable={{ source: 'Linear', since: '08:12' }}
      />,
    )

    const notice = screen.getByTestId('zone-unavailable')
    expect(notice).toHaveTextContent('Linear unreachable · showing data from 08:12')
    expect(within(notice).getByText('Retry')).toBeInTheDocument()
    expect(notice.className).toContain('stripe')
  })

  it('keeps rendering every cached row behind the notice', () => {
    render(
      <Week
        load={load}
        due={due}
        planning={planning}
        todayKey={TODAY}
        unavailable={{ source: 'Linear', since: '08:12' }}
      />,
    )

    expect(screen.getAllByTestId(TID.dueRow)).toHaveLength(4)
    expect(screen.getAllByTestId(TID.planningRow)).toHaveLength(5)
    expect(screen.getAllByTestId(TID.loadLane)).toHaveLength(5)
  })

  it('appears exactly once, above the zone rather than on every block', () => {
    render(
      <Week
        load={load}
        due={due}
        planning={planning}
        todayKey={TODAY}
        unavailable={{ source: 'Linear' }}
      />,
    )

    expect(screen.getAllByTestId('zone-unavailable')).toHaveLength(1)
  })

  it('says nothing when the source is healthy', () => {
    renderWeek()

    expect(screen.queryByTestId('zone-unavailable')).not.toBeInTheDocument()
  })
})
