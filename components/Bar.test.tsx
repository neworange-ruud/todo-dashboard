import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Bar from './Bar'
import { TID } from '@/lib/testids'
import type { SyncState } from '@/lib/types'

// The bar's marker is a Client Component that owns the poll and the manual refresh
// (see SyncMarker). Neither the router nor the Server Action exists in jsdom, and
// neither is what these tests are about — the bar's job is what it *says*.
const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => refresh() }),
}))
vi.mock('@/app/actions', () => ({
  refreshSources: vi.fn(async () => {}),
}))

function sync(agoMinutes: number | null): SyncState {
  return {
    lastSyncedAt: agoMinutes === null ? null : new Date(Date.now() - agoMinutes * 60_000).toISOString(),
    sources: { linear: 'ok', graph: 'ok', omni: 'ok', brain: 'ok' },
  }
}

describe('Bar', () => {
  it('carries the wordmark and the date', () => {
    render(<Bar dateLabel="Friday 11 September" sync={sync(2)} nowMs={Date.now()} />)

    expect(screen.getByText('TASK DESK')).toBeInTheDocument()
    expect(screen.getByText('Friday 11 September')).toBeInTheDocument()
  })

  it('renders the sync marker as a button', () => {
    render(<Bar dateLabel="Friday 11 September" sync={sync(2)} nowMs={Date.now()} />)

    const button = screen.getByTestId(TID.refreshButton)
    expect(button.tagName).toBe('BUTTON')
    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Synced 2m ago')
  })

  it('stays quiet while the sync is fresh', () => {
    render(<Bar dateLabel="Friday 11 September" sync={sync(2)} nowMs={Date.now()} />)

    expect(screen.getByTestId(TID.refreshButton)).toHaveAttribute('data-stale', 'false')
  })

  it('shifts the marker to the warning hue beyond 15 minutes (PRD §9)', () => {
    render(<Bar dateLabel="Friday 11 September" sync={sync(22)} nowMs={Date.now()} />)

    expect(screen.getByTestId(TID.refreshButton)).toHaveAttribute('data-stale', 'true')
    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Synced 22m ago')
  })

  it('treats a never-synced state as stale and says so in words', () => {
    render(<Bar dateLabel="Friday 11 September" sync={sync(null)} nowMs={Date.now()} />)

    expect(screen.getByTestId(TID.syncMarker)).toHaveTextContent('Never synced')
    expect(screen.getByTestId(TID.refreshButton)).toHaveAttribute('data-stale', 'true')
  })

  it('calls onRefresh when the marker is pressed', () => {
    const onRefresh = vi.fn()
    render(<Bar dateLabel="Friday 11 September" sync={sync(1)} nowMs={Date.now()} onRefresh={onRefresh} />)

    fireEvent.click(screen.getByTestId(TID.refreshButton))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
