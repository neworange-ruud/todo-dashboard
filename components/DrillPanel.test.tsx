import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DrillPanel, { parseTrail, serialiseTrail, type DrillFetcher } from './DrillPanel'
import { BLOCK_ORDER, BLOCK_TITLES, type DrillBlockId } from '@/lib/drill/meeting'
import { ISSUE_BLOCK_ORDER, MEETING_BLOCK_ORDER } from '@/lib/drill/blocks'
import { TID } from '@/lib/testids'
import type { DrillBlock } from '@/lib/types'

/**
 * Acceptance tests for the panel's mechanics (PRD §8).
 *
 * No network: the panel takes its fetcher as a prop, and every block here is resolved by
 * hand so arrival order can be controlled. What is being tested is the choreography —
 * containers before data, a fixed order, per-block failure, and four ways out.
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('drill=meeting:evt-1'),
}))

interface Deferred {
  promise: Promise<{ title?: string; action?: { label: string; href: string | null }; block: DrillBlock<unknown> }>
  settle: (block: Partial<DrillBlock<unknown>>) => Promise<void>
}

function harness() {
  const calls: DrillBlockId[] = []
  const deferreds = {} as Record<DrillBlockId, Deferred>

  for (const id of [...MEETING_BLOCK_ORDER, ...ISSUE_BLOCK_ORDER]) {
    let resolve!: (value: unknown) => void
    const promise = new Promise((r) => {
      resolve = r
    })
    deferreds[id] = {
      promise: promise as Deferred['promise'],
      settle: async (block) => {
        await act(async () => {
          resolve({
            title: 'Acme migration sync',
            action: { label: 'Open in Outlook', href: 'https://outlook.office.com/evt-1' },
            block: { id, title: BLOCK_TITLES[id], status: 'ok', elapsedMs: 120, ...block },
          })
          await Promise.resolve()
        })
      },
    }
  }

  const fetcher: DrillFetcher = (_type, _id, blockId) => {
    calls.push(blockId)
    return deferreds[blockId].promise
  }

  return { fetcher, calls, deferreds }
}

const blockIds = () =>
  screen.getAllByTestId(TID.panelBlock).map((el) => el.getAttribute('data-block-id'))

const blockEl = (id: DrillBlockId) =>
  screen.getAllByTestId(TID.panelBlock).find((el) => el.getAttribute('data-block-id') === id)!

beforeEach(() => {
  window.history.replaceState(null, '', '/?drill=meeting:evt-1')
})

describe('DrillPanel', () => {
  it('lays out all five blocks immediately, before any data arrives (PRD §8)', () => {
    const { fetcher } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    expect(blockIds()).toEqual([...BLOCK_ORDER])
    // Titled containers with skeletons — nothing appears only once its data lands.
    expect(screen.getAllByTestId(TID.skeleton)).toHaveLength(BLOCK_ORDER.length)
    expect(screen.getAllByTestId(TID.panelBlockStatus)).toHaveLength(BLOCK_ORDER.length)
    expect(screen.getByText('Attendees')).toBeInTheDocument()
    expect(screen.getByText('Unresolved')).toBeInTheDocument()
  })

  it('names the source it is waiting on in each header', () => {
    const { fetcher } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    expect(blockEl('account')).toHaveTextContent(/checking crm/i)
    expect(blockEl('last-time')).toHaveTextContent(/checking omni/i)
  })

  it('starts every block at once, so none waits on another', () => {
    const { fetcher, calls } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    expect([...calls].sort()).toEqual([...BLOCK_ORDER].sort())
  })

  it('does not reorder when results arrive out of order (PRD §8)', async () => {
    const { fetcher, deferreds } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    const before = blockIds()
    // Deliberately backwards: the slowest block in the design lands first.
    await deferreds.unresolved.settle({ data: { prose: 'Nobody owns DNS.', inferred: true } })
    await deferreds.attendees.settle({
      data: [
        {
          email: 'jorien@acme.nl',
          name: 'Jorien',
          role: null,
          company: 'Acme',
          isInternal: false,
          isOrganizer: false,
          lastContact: null,
        },
      ],
    })

    expect(blockIds()).toEqual(before)
    expect(blockIds()).toEqual([...BLOCK_ORDER])
    expect(blockEl('attendees')).toHaveTextContent('Jorien')
    expect(blockEl('unresolved')).toHaveTextContent('Nobody owns DNS.')
  })

  it('renders a failed block with a working Retry and keeps the other four', async () => {
    const { fetcher, deferreds, calls } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    await deferreds['last-time'].settle({
      status: 'failed',
      error: 'Could not reach Omni',
      elapsedMs: 40,
    })

    const failed = blockEl('last-time')
    expect(failed).toHaveAttribute('data-block-status', 'failed')
    expect(failed).toHaveTextContent(/could not reach omni/i)
    expect(failed).toHaveTextContent(/retry/i)

    // One block failing never takes the panel down.
    expect(blockIds()).toEqual([...BLOCK_ORDER])
    expect(screen.getByTestId(TID.panel)).toBeInTheDocument()

    const before = calls.filter((id) => id === 'last-time').length
    fireEvent.click(failed.querySelector('button')!)
    expect(calls.filter((id) => id === 'last-time').length).toBe(before + 1)
    expect(blockEl('last-time')).toHaveAttribute('data-block-status', 'loading')
  })

  it('says Nothing found for an empty block rather than showing an error', async () => {
    const { fetcher, deferreds } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    await deferreds['action-items'].settle({ status: 'empty', elapsedMs: 15 })

    const empty = blockEl('action-items')
    expect(empty).toHaveAttribute('data-block-status', 'empty')
    expect(empty).toHaveTextContent(/nothing found/i)
    expect(empty).not.toHaveTextContent(/retry/i)
  })

  it('shows a timing once a block has resolved', async () => {
    const { fetcher, deferreds } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    await deferreds.attendees.settle({ elapsedMs: 2400, data: [] })
    // An empty list is Nothing found; a populated one carries its timing.
    await deferreds.account.settle({
      elapsedMs: 2400,
      data: {
        companyId: 'c1',
        companyName: 'Acme',
        stage: 'Active',
        health: null,
        openOpportunities: [],
        lastInvoice: null,
        partial: [],
      },
    })

    expect(blockEl('account')).toHaveTextContent('2.4s')
  })

  it('dismisses on Escape', async () => {
    const { fetcher } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    expect(screen.getByTestId(TID.panel)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId(TID.panel)).not.toBeInTheDocument())
  })

  it('dismisses on the close control', async () => {
    const { fetcher } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    fireEvent.click(screen.getByTestId(TID.panelClose))

    await waitFor(() => expect(screen.queryByTestId(TID.panel)).not.toBeInTheDocument())
  })

  it('dismisses on a backdrop click', async () => {
    const { fetcher } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    fireEvent.click(screen.getByLabelText('Close drill-in'))

    await waitFor(() => expect(screen.queryByTestId(TID.panel)).not.toBeInTheDocument())
  })

  it('ends with exactly one action, in the same place, whatever the state', async () => {
    const { fetcher, deferreds } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    // Present before anything has arrived…
    expect(screen.getAllByTestId(TID.panelAction)).toHaveLength(1)
    expect(screen.getByTestId(TID.panelAction).textContent ?? '').toMatch(
      /open in (linear|outlook|brain)/i,
    )

    await deferreds.attendees.settle({ data: [] })

    // …and still exactly one afterwards.
    const actions = screen.getAllByTestId(TID.panelAction)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toHaveAttribute('href', 'https://outlook.office.com/evt-1')
  })

  it('drills from within the panel without ever opening a second one (PRD §8)', async () => {
    const { fetcher, deferreds } = harness()
    render(<DrillPanel fetcher={fetcher} />)

    await deferreds['action-items'].settle({
      data: [
        {
          identifier: 'RW-214',
          title: 'Acme migration cutover',
          state: 'In Progress',
          owner: null,
          dueDate: null,
          url: 'https://linear.app/rw/issue/RW-214',
        },
      ],
    })

    await act(async () => {
      fireEvent.click(screen.getByText(/RW-214/))
    })

    // One panel, always — the hop pushes onto the trail inside it.
    expect(screen.getAllByTestId(TID.panel)).toHaveLength(1)
    expect(screen.getAllByTestId(TID.panelCrumb).length).toBeGreaterThan(1)
    // And it is now an ISSUE panel, so it lays out the issue's five rather than the
    // meeting's — same discipline, different vocabulary (PRD §8).
    expect(blockIds()).toEqual([...ISSUE_BLOCK_ORDER])
  })
})

describe('the trail in the URL', () => {
  it('round-trips a stack, including ids that need escaping', () => {
    const trail = [
      { type: 'meeting' as const, id: 'AAMkAD=,weird/id' },
      { type: 'issue' as const, id: 'RW-214' },
    ]
    expect(parseTrail(serialiseTrail(trail))).toEqual(trail)
  })

  it('ignores segments it cannot read rather than failing to open', () => {
    expect(parseTrail('nonsense,issue:RW-1,:')).toEqual([{ type: 'issue', id: 'RW-1' }])
    expect(parseTrail(null)).toEqual([])
  })
})
