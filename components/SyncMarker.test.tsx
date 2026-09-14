import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SyncMarker from './SyncMarker'
import { TID } from '@/lib/testids'

const routerRefresh = vi.fn()
const refreshSources = vi.fn(async () => {})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))
vi.mock('@/app/actions', () => ({
  refreshSources: () => refreshSources(),
}))

/**
 * The marker is the one component that keeps the page from lying about itself, so what
 * is tested here is the behaviour that failure looked like: a dashboard rendered once,
 * left open, and still showing a meeting that had finished and a task that was closed.
 */
describe('SyncMarker', () => {
  const NOW = Date.parse('2026-09-14T15:42:00Z')

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    routerRefresh.mockClear()
    refreshSources.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function visibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    })
  }

  it('reads its first frame from the server instant, not from the browser clock', () => {
    render(
      <SyncMarker
        lastSyncedAt={new Date(NOW - 2 * 60_000).toISOString()}
        nowMs={NOW}
        pollMs={0}
      />,
    )

    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Synced 2m ago')
    expect(screen.getByTestId(TID.refreshButton)).toHaveAttribute('data-stale', 'false')
  })

  it('ages its own label between polls', () => {
    render(
      <SyncMarker
        lastSyncedAt={new Date(NOW - 30_000).toISOString()}
        nowMs={NOW}
        pollMs={0}
      />,
    )

    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Synced just now')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Synced 1m ago')
  })

  it('polls on the interval', () => {
    visibility('visible')
    render(<SyncMarker lastSyncedAt={new Date(NOW).toISOString()} nowMs={NOW} pollMs={60_000} />)

    expect(routerRefresh).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(routerRefresh).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(routerRefresh).toHaveBeenCalledTimes(3)
  })

  it('does not poll a hidden tab, and catches up when it returns', () => {
    visibility('hidden')
    render(<SyncMarker lastSyncedAt={new Date(NOW).toISOString()} nowMs={NOW} pollMs={60_000} />)

    act(() => {
      vi.advanceTimersByTime(300_000)
    })
    expect(routerRefresh).not.toHaveBeenCalled()

    visibility('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(routerRefresh).toHaveBeenCalledTimes(1)
  })

  it('pressing it drops the source caches rather than only re-rendering', async () => {
    render(<SyncMarker lastSyncedAt={new Date(NOW).toISOString()} nowMs={NOW} pollMs={0} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId(TID.refreshButton))
    })

    expect(refreshSources).toHaveBeenCalledTimes(1)
    // A re-render alone would hand back the same cached response under the same claim
    // of having just synced, which is the failure PRD §9 forbids.
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('adopts a fresh instant from a poll without waiting for its own tick', () => {
    const { rerender } = render(
      <SyncMarker
        lastSyncedAt={new Date(NOW - 10 * 60_000).toISOString()}
        nowMs={NOW}
        pollMs={0}
      />,
    )
    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Synced 10m ago')

    const later = NOW + 60_000
    rerender(
      <SyncMarker lastSyncedAt={new Date(later).toISOString()} nowMs={later} pollMs={0} />,
    )

    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Synced just now')
  })

  it('says so in words when nothing has ever synced', () => {
    render(<SyncMarker lastSyncedAt={null} nowMs={NOW} pollMs={0} />)

    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Never synced')
    expect(screen.getByTestId(TID.refreshButton)).toHaveAttribute('data-stale', 'true')
  })
})
