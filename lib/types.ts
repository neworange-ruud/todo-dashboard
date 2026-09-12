// `lib/drill/blocks.ts` imports nothing, so this dependency cannot cycle. The block
// vocabulary lives there because both the server builders and the client panel read it.
import type { DrillBlockId } from './drill/blocks'

/**
 * Shared domain types for Task Desk.
 *
 * This file is the contract between the data layer, the domain logic and the UI.
 * Everything crossing a module boundary is typed here so the parallel workstreams agree.
 * See PRD.md §6 (state model), §5 (timeline), §17.2 (ranking).
 */

// ---------------------------------------------------------------------------
// Calendar — from Microsoft Graph (PRD §17.8)
// ---------------------------------------------------------------------------

export interface Attendee {
  email: string
  name: string | null
  /** Organiser is folded into the attendee list by Graph; flagged rather than separated. */
  isOrganizer: boolean
}

export interface CalendarEvent {
  id: string
  subject: string
  /** ISO 8601 in Europe/Amsterdam. Graph is asked for this timezone explicitly. */
  start: string
  end: string
  /** All-day events carry 00:00–00:00 and must never be drawn in the timeline (PRD §17.9). */
  isAllDay: boolean
  isCancelled: boolean
  location: string | null
  organizer: Attendee | null
  attendees: Attendee[]
  webLink: string | null
}

// ---------------------------------------------------------------------------
// Linear (PRD §16, §17.3)
// ---------------------------------------------------------------------------

/** The five states Task Desk reads. Backlog / Done / Canceled / Duplicate are excluded upstream. */
export type TaskState = 'In Progress' | 'Waiting' | 'Planned' | 'Ready' | 'Inbox'

/** Committed work answers "what do I do"; uncommitted answers "what have I not decided". */
export const COMMITTED_STATES: readonly TaskState[] = ['In Progress', 'Waiting', 'Planned']
export const UNCOMMITTED_STATES: readonly TaskState[] = ['Ready', 'Inbox']

/** Linear states that never reach the product. */
export const EXCLUDED_STATE_NAMES: readonly string[] = [
  'Backlog',
  'Done',
  'Canceled',
  'Duplicate',
]

/** Labels that mark a machine-extracted issue and give it provenance (PRD §17.6). */
export type ProvenanceLabel = 'Email' | 'Transcript'

export interface LinearIssue {
  /** e.g. "RW-214" */
  identifier: string
  title: string
  /** Markdown body. Carries the `Provenance:` line on machine-extracted issues (§17.6). */
  description: string | null
  /** ISO date (YYYY-MM-DD) or null. */
  dueDate: string | null
  /** Linear priority: 0 = none. Weak tiebreaker only — 21 of 22 are unset (PRD §16.3). */
  priority: number
  state: TaskState
  labels: string[]
  url: string
  /** True when something blocks this issue or it blocks something else. */
  hasRelations: boolean
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Ranking (PRD §17.2)
// ---------------------------------------------------------------------------

/** Why an item earned its position. Rendered verbatim as the italic reason line. */
export interface ReasonClause {
  text: string
  /** Present when the clause came from Omni context rather than a Linear field. */
  source?: SourceRef
  /** Set when the model could not source the claim (PRD §8). */
  inferred?: boolean
}

export interface RankedTask {
  issue: LinearIssue
  rank: number
  /** Signals that fired, strongest first. Drives the reason line and is testable. */
  signals: RankSignal[]
  reason: ReasonClause
}

export type RankSignal =
  | { kind: 'overdue'; daysOver: number }
  | { kind: 'due'; daysUntil: number }
  | { kind: 'meeting-linked'; eventId: string; eventSubject: string }
  | { kind: 'blocked' }
  | { kind: 'in-progress' }
  | { kind: 'priority'; value: number }

// ---------------------------------------------------------------------------
// Timeline layout (PRD §5)
// ---------------------------------------------------------------------------

/**
 * What an empty band means. Rendered as the band's label and exposed as `data-tone`.
 *
 * `clear` is time deliberately kept free of meetings (the *Vrij houden* block); `offwork`
 * is outside working hours. Both are ordinary free time as far as layout is concerned —
 * the distinction is what the band is allowed to say (PRD §17.9, round 4).
 */
export type GapTone = 'free' | 'clear' | 'offwork'

export type TimelineRow =
  | {
      kind: 'event'
      event: CalendarEvent
      heightPx: number
      isPast: boolean
      isNow: boolean
      /** True when this meeting sits inside a non-work block — real, but out of hours. */
      outsideHours?: boolean
    }
  | {
      kind: 'gap'
      startMinutes: number
      endMinutes: number
      label: string
      heightPx: number
      tone: GapTone
    }
  | { kind: 'now'; atMinutes: number; label: string }

export interface TimelineLayout {
  /** All-day events render as a header band above the timeline, never inside it. */
  allDay: CalendarEvent[]
  rows: TimelineRow[]
  /** Total minutes of booked time, excluding all-day events and framing blocks. */
  bookedMinutes: number
  freeMinutes: number
  /** The nominal workday less any non-work block — what load should be measured against. */
  availableMinutes: number
}

// ---------------------------------------------------------------------------
// Week (PRD §7)
// ---------------------------------------------------------------------------

export interface DayLoad {
  /** 'MON' … 'FRI' */
  label: string
  date: string
  bookedMinutes: number
  workdayMinutes: number
  isToday: boolean
  /** True above ~70% booked — the only colour in the zone. */
  isHeavy: boolean
}

// ---------------------------------------------------------------------------
// Omni / enrichment (PRD §15.1)
// ---------------------------------------------------------------------------

export interface SourceRef {
  /** Rendered as "↗ {label}" in accent mono. */
  label: string
  url?: string
  documentId?: string
}

export interface OmniDocument {
  id: string
  title: string
  url: string | null
  /**
   * The best text Omni gave for this document.
   *
   * From a search hit that is the joined `highlights` — query-driven excerpts, which for a
   * Fireflies transcript routinely include the summary and the action-item list. From
   * {@link fetchDocument} it is the whole body.
   */
  snippet: string
  sourceType: string
  date: string | null
  /** Omni's own content classification, e.g. `meeting_transcript`, `email`, `event`. */
  contentType?: string
  /** Everyone Omni recorded on the document — transcript speakers, mail recipients. */
  participants?: string[]
  /**
   * The Graph event id, for a calendar document. Omni carries it verbatim, which is what
   * makes a task's related meetings openable as real meeting drill-ins rather than as text.
   */
  eventId?: string
}

// ---------------------------------------------------------------------------
// Drill-in (PRD §8)
// ---------------------------------------------------------------------------

export type BlockStatus = 'pending' | 'loading' | 'ok' | 'empty' | 'failed'

export interface DrillBlock<T> {
  /** See `lib/drill/blocks.ts`: a meeting block id or an issue block id. */
  id: DrillBlockId
  title: string
  status: BlockStatus
  /** Milliseconds, shown in the header once resolved. */
  elapsedMs?: number
  error?: string
  data?: T
  sources?: SourceRef[]
}

// ---------------------------------------------------------------------------
// The daily sentence (PRD §4)
// ---------------------------------------------------------------------------

export type EntityKind = 'meeting' | 'issue' | 'person' | 'timerange' | 'account'

export interface SentenceEntity {
  /** Exact substring of the sentence to linkify. */
  text: string
  kind: EntityKind
  /** Target id — issue identifier, event id, email address, or a time range. */
  ref: string
}

export interface DailySentence {
  text: string
  entities: SentenceEntity[]
  /** Which §4 register produced it. */
  window: 'morning' | 'midday' | 'evening' | 'empty' | 'weekend'
  generatedAt: string
  /** Hash of the inputs, so the UI only animates when the text genuinely changed. */
  inputHash: string
}

// ---------------------------------------------------------------------------
// Attention + sync (PRD §9)
// ---------------------------------------------------------------------------

export interface AttentionItem {
  /** One line, named in full. Never a bare count. */
  text: string
  href: string
}

export type SourceHealth = 'ok' | 'stale' | 'failed'

export interface SyncState {
  lastSyncedAt: string | null
  sources: Record<'linear' | 'graph' | 'omni' | 'brain', SourceHealth>
}

/** Presentation profile, selected by ?display=board — never inferred from viewport (PRD §17.13). */
export type DisplayMode = 'default' | 'board'
