import type { DrillBlock } from '../types'

/**
 * The drill-in's shared vocabulary.
 *
 * Deliberately free of any server import so the panel — a Client Component — can read
 * the block order and labels without dragging the Graph and Linear clients into the
 * browser bundle. `lib/drill/meeting.ts` is server-only and re-exports these.
 */

export type DrillBlockId = DrillBlock<unknown>['id']
export type DrillType = 'meeting' | 'issue' | 'person' | 'account'

/**
 * The fixed order. The panel lays containers out from this array, never from the order
 * results arrive in, which is what stops a late block from shuffling the page under the
 * reader's eyes (PRD §8).
 */
export const BLOCK_ORDER: readonly DrillBlockId[] = [
  'attendees',
  'last-time',
  'action-items',
  'account',
  'unresolved',
] as const

export const BLOCK_TITLES: Record<DrillBlockId, string> = {
  attendees: 'Attendees',
  'last-time': 'Last time',
  'action-items': 'Open action items',
  account: 'Account status',
  unresolved: 'Unresolved',
}

/** Which system a block is waiting on — rendered as *Checking Omni…* / *Could not reach CRM*. */
export const BLOCK_SOURCE_LABELS: Record<DrillBlockId, string> = {
  attendees: 'Outlook',
  'last-time': 'Omni',
  'action-items': 'Linear',
  account: 'CRM',
  unresolved: 'Omni',
}
