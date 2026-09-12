import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Switcher from './Switcher'
import { TID } from '@/lib/testids'

describe('Switcher', () => {
  it('has exactly two segments — Month is cut from v1 (PRD §17.4)', () => {
    render(<Switcher value="today" onChange={() => {}} />)

    const segments = screen.getAllByRole('tab')
    expect(segments).toHaveLength(2)
    expect(segments.map((segment) => segment.textContent)).toEqual(['TODAY', 'WEEK'])
    expect(screen.queryByText(/month/i)).not.toBeInTheDocument()
  })

  it('marks the selected horizon', () => {
    render(<Switcher value="week" onChange={() => {}} />)

    expect(screen.getByTestId(TID.switcherWeek)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId(TID.switcherToday)).toHaveAttribute('aria-selected', 'false')
  })

  it('reports the horizon the reader picked', () => {
    const onChange = vi.fn()
    render(<Switcher value="today" onChange={onChange} />)

    fireEvent.click(screen.getByTestId(TID.switcherWeek))
    expect(onChange).toHaveBeenCalledWith('week')
  })

  it('is a tablist, so the two segments read as one control', () => {
    render(<Switcher value="today" onChange={() => {}} />)

    expect(screen.getByTestId(TID.switcher)).toHaveAttribute('role', 'tablist')
  })
})
