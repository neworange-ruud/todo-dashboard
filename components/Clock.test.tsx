import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Clock from './Clock'
import { TID } from '@/lib/testids'

describe('Clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the Amsterdam wall time of the instant it was given', () => {
    // 13:42 UTC in September is 15:42 in Amsterdam.
    render(<Clock nowMs={Date.parse('2026-09-14T13:42:00Z')} />)

    expect(screen.getByTestId(TID.clock)).toHaveTextContent('15:42')
  })

  it('is fixed to Amsterdam regardless of where the browser is', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      render(<Clock nowMs={Date.parse('2026-09-14T13:42:00Z')} />)
      expect(screen.getByTestId(TID.clock)).toHaveTextContent('15:42')
    } finally {
      process.env.TZ = tz
    }
  })

  it('ticks on the minute boundary, not a minute after mount', () => {
    // Mount 20 seconds into the minute: the first tick is owed in 40 seconds.
    const start = Date.parse('2026-09-14T13:42:20Z')
    vi.setSystemTime(start)
    render(<Clock nowMs={start} />)

    expect(screen.getByTestId(TID.clock)).toHaveTextContent('15:42')

    act(() => {
      vi.advanceTimersByTime(40_000)
    })
    expect(screen.getByTestId(TID.clock)).toHaveTextContent('15:43')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByTestId(TID.clock)).toHaveTextContent('15:44')
  })

  it('adopts a fresh instant handed down by a poll', () => {
    const { rerender } = render(<Clock nowMs={Date.parse('2026-09-14T13:42:00Z')} />)
    expect(screen.getByTestId(TID.clock)).toHaveTextContent('15:42')

    rerender(<Clock nowMs={Date.parse('2026-09-14T13:55:00Z')} />)
    expect(screen.getByTestId(TID.clock)).toHaveTextContent('15:55')
  })

  it('is a machine-readable time element', () => {
    render(<Clock nowMs={Date.parse('2026-09-14T13:42:00Z')} />)

    const el = screen.getByTestId(TID.clock)
    expect(el.tagName).toBe('TIME')
    expect(el).toHaveAttribute('dateTime', '15:42')
  })
})
