import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Attention from './Attention'
import { TID } from '@/lib/testids'
import type { AttentionItem } from '@/lib/types'

const items: AttentionItem[] = [
  { text: 'RW-339 is 51 days overdue and Marieke is waiting on it.', href: '?drill=issue:RW-339' },
  { text: 'You are double-booked at 14:00 — Acme review and the design sync.', href: '?drill=meeting:evt-14' },
  { text: 'RW-208 blocks Jorien and slipped past its due date yesterday.', href: '?drill=issue:RW-208' },
  { text: 'RW-412 has been waiting on legal for nine days.', href: '?drill=issue:RW-412' },
  { text: 'The Acme migration target date passed with three issues open.', href: '?drill=issue:RW-500' },
]

describe('Attention', () => {
  it('renders nothing at all when nothing qualifies (PRD §9)', () => {
    const { container } = render(<Attention items={[]} />)

    // Zero height, not a collapsed strip: there is no element on the page.
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId(TID.attention)).not.toBeInTheDocument()
  })

  it('names the thing in full and links into its drill-in', () => {
    render(<Attention items={items.slice(0, 1)} />)

    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '?drill=issue:RW-339')
    expect(link).toHaveTextContent('RW-339 is 51 days overdue and Marieke is waiting on it.')
    expect(screen.getByText('NEEDS ATTENTION')).toBeInTheDocument()
  })

  it('shows at most three items and collapses the rest into a named line', () => {
    const { container } = render(<Attention items={items} />)

    expect(screen.getAllByRole('link')).toHaveLength(3)
    expect(container.textContent).toContain('and 2 more')
  })

  it('does not add an overflow line at exactly three items', () => {
    render(<Attention items={items.slice(0, 3)} />)

    expect(screen.getAllByRole('link')).toHaveLength(3)
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument()
  })
})
