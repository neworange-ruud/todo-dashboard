/**
 * The drill-in's shared vocabulary.
 *
 * Deliberately free of any server import so the panel — a Client Component — can read the
 * block order and labels without dragging the Graph, Linear and Omni clients into the
 * browser bundle. `lib/drill/meeting.ts` is server-only and re-exports these.
 *
 * **Blocks belong to a drill type.** A meeting and an issue are different questions and
 * want different answers, so each type names its own five (PRD §8, "Other drill-in
 * types"). What they share is the discipline: a fixed count, a fixed order, laid out from
 * these arrays and never from the order responses happen to arrive in.
 */

export type DrillType = 'meeting' | 'issue' | 'person' | 'account'

/** Blocks of the meeting drill-in — PRD §8's five, unchanged. */
export type MeetingBlockId = 'attendees' | 'last-time' | 'action-items' | 'account' | 'unresolved'

/**
 * Blocks of the issue drill-in.
 *
 * Deliberately parallel to the meeting's: something you can read instantly, then the thing
 * the AI had to go and find, then the fast structured neighbours, then two retrieval
 * blocks. *What was said* sits second for the same reason *Last time* does — it is the
 * block you opened the panel for, and burying it under three lists would be a filing
 * decision pretending to be a design.
 */
export type IssueBlockId = 'issue-detail' | 'said' | 'related-issues' | 'meetings' | 'email'

export type DrillBlockId = MeetingBlockId | IssueBlockId

export const MEETING_BLOCK_ORDER: readonly MeetingBlockId[] = [
  'attendees',
  'last-time',
  'action-items',
  'account',
  'unresolved',
] as const

export const ISSUE_BLOCK_ORDER: readonly IssueBlockId[] = [
  'issue-detail',
  'said',
  'related-issues',
  'meetings',
  'email',
] as const

/**
 * The fixed order for a drill type. The panel lays containers out from this array, which
 * is what stops a late block from shuffling the page under the reader's eyes (PRD §8).
 *
 * Person and account drill-ins are specified but not built; they borrow the meeting's
 * order so their five empty containers still read as a panel rather than as a dead end.
 */
export function blockOrderFor(type: DrillType): readonly DrillBlockId[] {
  return type === 'issue' ? ISSUE_BLOCK_ORDER : MEETING_BLOCK_ORDER
}

/** Kept for callers that only ever speak about meetings. */
export const BLOCK_ORDER = MEETING_BLOCK_ORDER

export const BLOCK_TITLES: Record<DrillBlockId, string> = {
  // Meeting
  attendees: 'Attendees',
  'last-time': 'Last time',
  'action-items': 'Open action items',
  account: 'Account status',
  unresolved: 'Unresolved',
  // Issue
  'issue-detail': 'The task',
  said: 'What was said',
  'related-issues': 'Related tasks',
  meetings: 'Meetings',
  email: 'Email',
}

/** Which system a block is waiting on — rendered as *Checking Omni…* / *Could not reach CRM*. */
export const BLOCK_SOURCE_LABELS: Record<DrillBlockId, string> = {
  attendees: 'Outlook',
  'last-time': 'Omni',
  'action-items': 'Linear',
  account: 'CRM',
  unresolved: 'Omni',
  'issue-detail': 'Linear',
  said: 'Fireflies',
  'related-issues': 'Linear',
  meetings: 'Outlook',
  email: 'Outlook',
}

/** Whether `id` is a block of `type`'s panel. Used to validate a request parameter. */
export function isBlockOf(type: DrillType, id: string): id is DrillBlockId {
  return (blockOrderFor(type) as readonly string[]).includes(id)
}
