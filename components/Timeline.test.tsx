import { act } from 'react'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Timeline from './Timeline'
import { buildTimeline } from '@/lib/domain/timeline'
import { TID } from '@/lib/testids'
import type { Attendee, CalendarEvent } from '@/lib/types'

const someone = (name: string): Attendee => ({
  email: `${name.toLowerCase()}@neworange.agency`,
  name,
  isOrganizer: false,
})

function event(
  id: string,
  subject: string,
  start: string,
  end: string,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    subject,
    start,
    end,
    isAllDay: false,
    isCancelled: false,
    location: null,
    organizer: null,
    attendees: [],
    webLink: null,
    ...extra,
  }
}

/** A real Friday: someone else's holiday, a standup, a 5-minute block, a live meeting. */
const events: CalendarEvent[] = [
  event('evt-holiday', 'Katja vakantie', '2026-09-11T00:00:00+02:00', '2026-09-12T00:00:00+02:00', {
    isAllDay: true,
  }),
  event('evt-standup', 'Standup', '2026-09-11T09:00:00+02:00', '2026-09-11T09:15:00+02:00', {
    attendees: [someone('Jorien'), someone('Marieke')],
  }),
  event('evt-tandarts', 'Tandarts bevestigen', '2026-09-11T10:00:00+02:00', '2026-09-11T10:05:00+02:00'),
  event('evt-acme', 'Acme migration review', '2026-09-11T11:00:00+02:00', '2026-09-11T12:00:00+02:00', {
    attendees: [someone('Marieke')],
    location: 'Teams',
  }),
  event('evt-design', 'Design sync', '2026-09-11T14:00:00+02:00', '2026-09-11T16:00:00+02:00', {
    attendees: [someone('Jorien')],
  }),
]

const NOW = new Date('2026-09-11T11:42:00+02:00')

function renderAt(now: Date) {
  const layout = buildTimeline(events, now)
  return { layout, ...render(<Timeline layout={layout} now={now} mode="default" />) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Timeline', () => {
  it('renders all-day events in the header band and never as timeline rows (PRD §17.9)', () => {
    renderAt(NOW)

    const band = screen.getByTestId(TID.allDayBand)
    expect(band).toHaveTextContent('Katja vakantie')

    const timeline = screen.getByTestId(TID.timeline)
    expect(within(timeline).queryByText('Katja vakantie')).not.toBeInTheDocument()
    expect(within(timeline).queryByTestId(TID.allDayBand)).not.toBeInTheDocument()
    expect(screen.getAllByTestId(TID.timelineEvent)).toHaveLength(4)
  })

  it('draws each row at the height the layout computed', () => {
    const { layout } = renderAt(NOW)

    const eventRows = layout.rows.filter((row) => row.kind === 'event')
    const rendered = screen.getAllByTestId(TID.timelineEvent)
    rendered.forEach((node, index) => {
      expect(node.style.minHeight).toBe(`${eventRows[index].heightPx}px`)
    })
  })

  it('still renders a five-minute event (the clamp came from the layout)', () => {
    renderAt(NOW)

    const short = screen.getByText('Tandarts bevestigen').closest('a')
    expect(short).not.toBeNull()
    // The lane carries the start; the full range is on the accessible name.
    expect(short).toHaveTextContent('10:00')
    expect(short).toHaveAccessibleName('10:00–10:05 Tandarts bevestigen')
    expect(Number.parseInt(short!.style.minHeight, 10)).toBeGreaterThanOrEqual(32)
  })

  it('dims past events and drops their subtitle', () => {
    renderAt(NOW)

    const standup = screen.getByText('Standup').closest('a')!
    expect(standup).toHaveAttribute('data-past', 'true')
    expect(standup).not.toHaveTextContent('2 ATTENDEES')
  })

  it('elevates the meeting containing now and counts it down', () => {
    renderAt(NOW)

    const current = screen.getByText('Acme migration review').closest('a')!
    expect(current).toHaveAttribute('data-now', 'true')
    expect(current.className).toContain('stripe')
    expect(current).toHaveTextContent('18 MIN LEFT')
    expect(current).toHaveTextContent('1 ATTENDEE · Teams')
  })

  it('shifts the countdown to the critical hue in the final five minutes', () => {
    renderAt(new Date('2026-09-11T11:56:00+02:00'))

    const current = screen.getByText('Acme migration review').closest('a')!
    const countdown = current.querySelector('[data-urgent]')
    expect(countdown).toHaveAttribute('data-urgent', 'true')
    expect(countdown).toHaveTextContent('4 MIN LEFT')
  })

  it('leaves the countdown quiet while there is time left', () => {
    renderAt(NOW)

    const countdown = screen.getByText('18 MIN LEFT')
    expect(countdown).toHaveAttribute('data-urgent', 'false')
  })

  it('re-renders the countdown on the 30 second tick and cleans the interval up', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)

    const layout = buildTimeline(events, NOW)
    const view = render(<Timeline layout={layout} now={NOW} mode="default" />)
    expect(screen.getByText('18 MIN LEFT')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(10 * 60_000)
    })
    expect(screen.getByText('8 MIN LEFT')).toBeInTheDocument()

    const clear = vi.spyOn(globalThis, 'clearInterval')
    view.unmount()
    expect(clear).toHaveBeenCalled()
  })

  it('labels the now rule and the free band, and offers a way back to now', () => {
    renderAt(NOW)

    expect(screen.getByTestId(TID.nowRule)).toHaveTextContent('NOW 11:42')
    expect(screen.getAllByTestId(TID.timelineGap).map((gap) => gap.textContent)).toContain('2H FREE')
    expect(screen.getByTestId(TID.nowButton)).toBeInTheDocument()
  })

  it('stops following once the reader has scrolled away, and resumes on the Now button', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const layout = buildTimeline(events, NOW)
    render(<Timeline layout={layout} now={NOW} mode="default" />)

    const nowButton = screen.getByTestId(TID.nowButton)
    expect(nowButton).toHaveAttribute('data-following', 'true')

    // Let the auto-scroll on mount settle: our own scroll must not count as the reader's.
    act(() => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      screen.getByTestId(TID.timeline).dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(nowButton).toHaveAttribute('data-following', 'false')

    act(() => {
      nowButton.click()
    })
    expect(nowButton).toHaveAttribute('data-following', 'true')
  })

  it('ignores its own auto-scroll, so mounting does not cancel following', () => {
    renderAt(NOW)

    // The mount scroll is still in flight; a scroll event now is ours, not the reader's.
    act(() => {
      screen.getByTestId(TID.timeline).dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(screen.getByTestId(TID.nowButton)).toHaveAttribute('data-following', 'true')
  })

  it('opens every row with the same fixed lane, so times and titles never collide', () => {
    renderAt(NOW)

    const timeline = screen.getByTestId(TID.timeline)
    const rows = Array.from(timeline.children) as HTMLElement[]
    expect(rows.length).toBeGreaterThan(3)

    for (const row of rows) {
      const lane = row.firstElementChild as HTMLElement
      expect(lane).not.toBeNull()
      // Event rows lead with the time lane; gap and now rows lead with its spacer.
      const leadsWithLane =
        lane.className.includes('eventTime') || lane.className.includes('rowLane')
      expect(leadsWithLane, `row "${row.textContent}" must lead with the 42px lane`).toBe(true)
    }
  })

  it('opens the drill-in for a meeting', () => {
    renderAt(NOW)

    expect(screen.getByText('Design sync').closest('a')).toHaveAttribute(
      'href',
      '?drill=meeting:evt-design',
    )
  })
})
