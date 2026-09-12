import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import TopFive from './TopFive'
import { TID } from '@/lib/testids'
import type { LinearIssue, RankedTask, TaskState } from '@/lib/types'

function issue(identifier: string, title: string, state: TaskState, dueDate: string | null): LinearIssue {
  return {
    identifier,
    title,
    dueDate,
    priority: 0,
    state,
    labels: [],
    url: `https://linear.app/rw/issue/${identifier}`,
    hasRelations: false,
    createdAt: '2026-08-20T09:00:00+02:00',
    updatedAt: '2026-09-10T16:30:00+02:00',
  }
}

const tasks: RankedTask[] = [
  {
    issue: issue('RW-339', 'Migrate the Acme mailboxes', 'In Progress', '2026-07-22'),
    rank: 1,
    signals: [{ kind: 'overdue', daysOver: 51 }],
    reason: { text: '51 days over · Marieke asked again on Tuesday', source: { label: 'Email', url: 'https://mail/1' } },
  },
  {
    issue: issue('RW-214', 'Write the migration runbook', 'Waiting', '2026-09-11'),
    rank: 2,
    signals: [{ kind: 'blocked' }],
    reason: { text: 'blocked by Jorien since Monday' },
  },
  {
    issue: issue('RW-402', 'Prepare the design sync agenda', 'Planned', '2026-09-11'),
    rank: 3,
    signals: [{ kind: 'meeting-linked', eventId: 'evt-3', eventSubject: 'Design sync' }],
    reason: { text: 'needed for the design sync at 14:00', inferred: true },
  },
  {
    issue: issue('RW-118', 'Close out the September invoices', 'Planned', '2026-09-12'),
    rank: 4,
    signals: [{ kind: 'due', daysUntil: 1 }],
    reason: { text: 'due tomorrow' },
  },
  {
    issue: issue('RW-501', 'Review the Brain MCP client', 'In Progress', '2026-09-15'),
    rank: 5,
    signals: [{ kind: 'in-progress' }],
    reason: { text: 'started yesterday, due Tuesday' },
  },
  {
    issue: issue('RW-777', 'Never shown — the sixth item', 'Planned', '2026-09-16'),
    rank: 6,
    signals: [{ kind: 'due', daysUntil: 5 }],
    reason: { text: 'due Wednesday' },
  },
]

describe('TopFive', () => {
  it('shows at most five rows (PRD §6)', () => {
    render(<TopFive tasks={tasks} />)

    expect(screen.getAllByTestId(TID.taskRow)).toHaveLength(5)
    expect(screen.queryByText('Never shown — the sixth item')).not.toBeInTheDocument()
  })

  it('gives EVERY row a non-empty reason line', () => {
    render(<TopFive tasks={tasks} />)

    const rows = screen.getAllByTestId(TID.taskRow)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const reason = row.querySelector(`[data-testid="${TID.taskReason}"]`)
      expect(reason).not.toBeNull()
      expect(reason?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })

  it('fills the dot for started work and leaves it hollow otherwise', () => {
    render(<TopFive tasks={tasks} />)

    const dots = screen.getAllByTestId(TID.taskStateDot)
    // In Progress, Waiting, Planned, Planned, In Progress
    expect(dots.map((dot) => dot.getAttribute('data-filled'))).toEqual([
      'true',
      'true',
      'false',
      'false',
      'true',
    ])
  })

  it('renders the rank, issue key and title in their own lanes', () => {
    render(<TopFive tasks={tasks} />)

    const first = screen.getAllByTestId(TID.taskRow)[0]
    expect(first).toHaveTextContent('RW-339')
    expect(first).toHaveTextContent('Migrate the Acme mailboxes')
    expect(first.querySelector('a')).toHaveAttribute('href', '?drill=issue:RW-339')
  })

  it('shows the source affordance when the clause came from Omni context', () => {
    render(<TopFive tasks={tasks} />)

    const source = screen.getAllByTestId(TID.sourceRef)
    expect(source).toHaveLength(1)
    expect(source[0]).toHaveTextContent('↗ Email')
    expect(source[0]).toHaveAttribute('href', 'https://mail/1')
  })

  it('says "inferred" out loud when the model could not source the claim', () => {
    render(<TopFive tasks={tasks} />)

    expect(screen.getByText('inferred')).toBeInTheDocument()
  })

  it('renders one honest line when there is nothing committed', () => {
    render(<TopFive tasks={[]} />)

    const empty = screen.getByTestId(TID.topFiveEmpty)
    expect(empty).toBeInTheDocument()
    expect(empty.textContent).toMatch(/nothing in progress or planned/i)
    expect(screen.queryAllByTestId(TID.taskRow)).toHaveLength(0)
    // No encouragement, no illustration.
    expect(empty.textContent).not.toMatch(/great|nice work|you've got this|🎉/i)
  })
})

/**
 * Meetings but no tasks (PRD §9): "the top-five column shows one line pointing at the
 * next horizon rather than apologising". Whitespace is the intended outcome; the test
 * is here to stop anyone filling it.
 */
describe('TopFive — quiet', () => {
  it('points at the next horizon instead of apologising or inventing work', () => {
    render(<TopFive tasks={[]} />)

    const empty = screen.getByTestId(TID.topFiveEmpty)
    // It names where the next thing comes from — that is the whole content of the line.
    expect(empty.textContent).toMatch(/the week below/i)
    expect(empty.textContent).not.toMatch(/sorry|unfortunately|oops/i)
    // Nothing is drawn to fill the space.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('offers no suggestions, no counts and no call to action', () => {
    const { container } = render(<TopFive tasks={[]} />)

    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(screen.getByTestId(TID.topFiveEmpty).textContent).not.toMatch(/\d/)
  })
})

/**
 * Source down (PRD §9): one inline line, and the cached rows keep rendering behind it.
 * The zone is degraded, not broken — blanking it would trade a stale truth for none.
 */
describe('TopFive — source down', () => {
  it('names the source and the time the data is from, and offers a retry', () => {
    render(<TopFive tasks={tasks} unavailable={{ source: 'Linear', since: '08:12' }} />)

    const notice = screen.getByTestId('zone-unavailable')
    expect(notice).toHaveTextContent('Linear unreachable · showing data from 08:12')
    expect(within(notice).getByText('Retry')).toBeInTheDocument()
  })

  it('keeps rendering the cached rows behind the notice', () => {
    render(<TopFive tasks={tasks} unavailable={{ source: 'Linear', since: '08:12' }} />)

    expect(screen.getAllByTestId(TID.taskRow)).toHaveLength(5)
    expect(screen.getByText('Migrate the Acme mailboxes')).toBeInTheDocument()
  })

  it('carries the 2px stripe and nothing else — no badge, no icon, no panel', () => {
    render(<TopFive tasks={tasks} unavailable={{ source: 'Linear' }} />)

    const notice = screen.getByTestId('zone-unavailable')
    expect(notice.className).toContain('stripe')
    // Without a cached timestamp it simply does not claim one.
    expect(notice).toHaveTextContent('Linear unreachable')
    expect(notice.textContent).not.toContain('showing data from')
  })

  it('shows the line above an empty zone too, rather than swallowing it', () => {
    render(<TopFive tasks={[]} unavailable={{ source: 'Linear', since: '08:12' }} />)

    expect(screen.getByTestId('zone-unavailable')).toBeInTheDocument()
    expect(screen.getByTestId(TID.topFiveEmpty)).toBeInTheDocument()
  })

  it('says nothing at all when every source is healthy', () => {
    render(<TopFive tasks={tasks} />)

    expect(screen.queryByTestId('zone-unavailable')).not.toBeInTheDocument()
  })
})
