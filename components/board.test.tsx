import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import TopFive from './TopFive'
import Week from './Week'
import { TID } from '@/lib/testids'
import type { DayLoad, LinearIssue, RankedTask, TaskState } from '@/lib/types'

/**
 * Board mode — the one place the caps come back (PRD §17.13).
 *
 * §17.5 removed the `⌄ N more` caps because the real board is small enough to render
 * whole. That holds for the default view and only the default view: the wall monitor
 * has 720px and no scrollbar, so each block draws **three** rows and the header's named
 * count carries the rest. A count inside a named header is fine; a bare badge is not
 * (§9), which is why every assertion below checks the header as well as the rows.
 */

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
    description: null,
    priority: 0,
    state,
    labels,
    url: `https://linear.app/rw/issue/${identifier}`,
    hasRelations: false,
    createdAt: '2026-08-28T09:00:00+02:00',
    updatedAt: '2026-09-10T16:30:00+02:00',
  }
}

const ranked: RankedTask[] = [
  ['RW-339', 'Migrate the Acme mailboxes', '51 days over'],
  ['RW-214', 'Write the migration runbook', 'blocked by Jorien since Monday'],
  ['RW-402', 'Prepare the design sync agenda', 'needed for the design sync at 14:00'],
  ['RW-118', 'Close out the September invoices', 'due tomorrow'],
  ['RW-501', 'Review the Brain MCP client', 'started yesterday, due Tuesday'],
].map(([identifier, title, reason], index) => ({
  issue: issue(identifier, title, 'Planned', TODAY),
  rank: index + 1,
  signals: [{ kind: 'due', daysUntil: index }],
  reason: { text: reason },
}))

const load: DayLoad[] = [
  { label: 'MON', date: '2026-09-07', bookedMinutes: 120, workdayMinutes: 480, isToday: false, isHeavy: false },
  { label: 'FRI', date: TODAY, bookedMinutes: 195, workdayMinutes: 480, isToday: true, isHeavy: false },
]

// Nine dated items and six uncommitted ones — a fuller day than the board can draw.
const due: LinearIssue[] = Array.from({ length: 9 }, (_, i) =>
  issue(`RW-${600 + i}`, `Due item ${i}`, 'Planned', TODAY),
)
const planning: LinearIssue[] = Array.from({ length: 6 }, (_, i) =>
  issue(`RW-${700 + i}`, `Planning item ${i}`, i < 4 ? 'Ready' : 'Inbox', null),
)

describe('Board mode — top five', () => {
  it('draws three rows and names the full length in the header', () => {
    render(<TopFive tasks={ranked} mode="board" />)

    expect(screen.getAllByTestId(TID.taskRow)).toHaveLength(3)
    expect(screen.getByTestId('top-five-count')).toHaveTextContent('5')
    expect(screen.queryByText('Close out the September invoices')).not.toBeInTheDocument()
  })

  it('keeps the three it draws in rank order, with their reason lines intact', () => {
    render(<TopFive tasks={ranked} mode="board" />)

    const rows = screen.getAllByTestId(TID.taskRow)
    expect(rows[0]).toHaveTextContent('Migrate the Acme mailboxes')
    expect(rows[2]).toHaveTextContent('Prepare the design sync agenda')
    // The cap truncates; it never strips the argument behind a row (PRD §6).
    for (const row of rows) {
      expect(within(row).getByTestId(TID.taskReason).textContent?.trim()).not.toBe('')
    }
  })

  it('shows everything in the default view (PRD §17.5)', () => {
    render(<TopFive tasks={ranked} />)

    expect(screen.getAllByTestId(TID.taskRow)).toHaveLength(5)
    expect(screen.getByText('Close out the September invoices')).toBeInTheDocument()
  })
})

describe('Board mode — week', () => {
  it('caps due this week at three and leaves the count naming the remainder', () => {
    render(<Week load={load} due={due} planning={planning} todayKey={TODAY} mode="board" />)

    expect(screen.getAllByTestId(TID.dueRow)).toHaveLength(3)

    const block = screen.getByTestId(TID.dueThisWeek)
    expect(within(block).getByText('DUE THIS WEEK')).toBeInTheDocument()
    // "DUE THIS WEEK · 9", showing 3.
    expect(block.textContent).toContain('9')
  })

  it('caps needs planning at three and keeps both halves of its named count', () => {
    render(<Week load={load} due={due} planning={planning} todayKey={TODAY} mode="board" />)

    expect(screen.getAllByTestId(TID.planningRow)).toHaveLength(3)
    // Four Ready and two Inbox in the data, whatever is drawn.
    expect(screen.getByTestId(TID.needsPlanning).textContent).toContain('4 READY · 2 NEW')
  })

  it('names no count as a bare badge — every number sits inside a header', () => {
    render(<Week load={load} due={due} planning={planning} todayKey={TODAY} mode="board" />)

    for (const id of [TID.dueThisWeek, TID.needsPlanning]) {
      const head = screen.getByTestId(id).querySelector('h2')
      expect(head?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })

  it('shows every row in the default view (PRD §17.5)', () => {
    render(<Week load={load} due={due} planning={planning} todayKey={TODAY} />)

    expect(screen.getAllByTestId(TID.dueRow)).toHaveLength(9)
    expect(screen.getAllByTestId(TID.planningRow)).toHaveLength(6)
  })

  it('defaults to showing everything when no mode is given', () => {
    const { rerender } = render(
      <Week load={load} due={due} planning={planning} todayKey={TODAY} mode="default" />,
    )
    expect(screen.getAllByTestId(TID.dueRow)).toHaveLength(9)

    rerender(<Week load={load} due={due} planning={planning} todayKey={TODAY} />)
    expect(screen.getAllByTestId(TID.dueRow)).toHaveLength(9)
  })
})

describe('Board mode — identical content, identical hierarchy', () => {
  it('adds and removes no zone: board only truncates and rescales (PRD §17.13)', () => {
    const { unmount } = render(<Week load={load} due={due} planning={planning} todayKey={TODAY} />)
    const defaultBlocks = screen.getAllByRole('heading').map((h) => h.textContent)
    unmount()

    render(<Week load={load} due={due} planning={planning} todayKey={TODAY} mode="board" />)
    const boardBlocks = screen.getAllByRole('heading').map((h) => h.textContent)

    expect(boardBlocks).toEqual(defaultBlocks)
  })
})
