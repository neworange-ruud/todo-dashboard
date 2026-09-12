import 'server-only'

import { ISSUE_BLOCK_ORDER, BLOCK_TITLES } from './blocks'
import type { IssueBlockId } from './blocks'
import { runBlock, blockFailure, type BlockOutcome } from './run'
import { fetchIssues } from '../linear/client'
import { fetchEventsForWeek } from '../graph/calendar'
import {
  SOURCE_TYPES,
  fetchDocument,
  search,
  type OmniSearchResult,
  type OmniDocumentResult,
} from '../omni/client'
import { toSourceRef, whatWasSaid } from '../ai/synthesis'
import {
  describeSections,
  parseProvenance,
  type DescriptionSection,
  type Provenance,
} from '../domain/provenance'
import { toDateKey, weekdaysOf } from '../time'
import type { DrillBlock, LinearIssue, OmniDocument, SourceRef, TaskState } from '../types'

/**
 * The issue drill-in (PRD §8, "Other drill-in types").
 *
 * Five blocks, fixed order, same discipline as the meeting panel: every block owns its own
 * try/catch and its own clock, and one source being down produces one block reading
 * *Could not reach Omni · Retry* and four blocks reading normally.
 *
 * **What makes this panel worth opening is block 2.** A task on this board is usually not
 * something Ruud typed — it was extracted from a meeting or a mail thread, and its Linear
 * description ends with a pointer at the exact Omni document it came from:
 *
 * ```
 * Provenance: Omni fireflies/01M27T2KN8ENXYZD57Q43E1MM0; evidence 2026-09-11
 * ```
 *
 * So *What was said* is not a search. It is a fetch of one transcript by id, read in full,
 * synthesised into two or three sentences about what was actually discussed, cited back to
 * the recording. The searches below exist for the tasks that carry no pointer, and to find
 * the *other* places a task was discussed — which is the second half of what a task's
 * history is.
 */

// ---------------------------------------------------------------------------
// Block payloads
// ---------------------------------------------------------------------------

export interface IssueDetail {
  identifier: string
  title: string
  state: TaskState
  dueDate: string | null
  labels: string[]
  priority: number
  hasRelations: boolean
  createdAt: string
  updatedAt: string
  /**
   * The description, provenance stripped and split into its labelled parts.
   *
   * The extraction pipeline writes an outcome and a completion criterion; run together
   * they read as one long sentence, which is what PRD §8 rules out.
   */
  sections: DescriptionSection[]
  /** Where this task came from, when it says. Rendered as the block's one source link. */
  origin: IssueOrigin | null
}

export interface IssueOrigin {
  /** `fireflies` → "a meeting recording", `outlook` → "an email". */
  sourceType: string
  documentId: string
  evidenceDate: string | null
  /** Filled once the document is resolved; null when Omni could not produce it. */
  title: string | null
  url: string | null
}

/** A meeting this task was discussed in, or is scheduled to be discussed in. */
export interface MeetingRow {
  title: string
  /** ISO instant when known. Sorted on this, most recent first. */
  date: string | null
  /** The Graph event id, when Omni carried one — it makes the row a real drill target. */
  eventId: string | null
  url: string | null
  /** True when the meeting is still to come. */
  upcoming: boolean
  /** Everyone Omni recorded in the room. */
  participants: string[]
}

export interface MailRow {
  subject: string
  date: string | null
  url: string | null
  from: string | null
  /** One or two lines of the body — enough to know whether to open it. */
  excerpt: string
}

export interface ActionItemRow {
  identifier: string
  title: string
  state: TaskState
  owner: string | null
  dueDate: string | null
  url: string
}

export interface ProseData {
  prose: string
  inferred: boolean
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface IssueDrillDeps {
  loadIssues?: () => Promise<LinearIssue[]>
  loadDocument?: (id: string) => Promise<OmniDocumentResult>
  omniSearch?: (query: string, sourceTypes: string[], limit: number) => Promise<OmniSearchResult>
  synthesise?: typeof whatWasSaid
  /** The day the dashboard is showing, so "upcoming" means upcoming from there. */
  dateKey?: string
  now?: () => number
}

/** How many rows a list block will show before it stops being a list and becomes a wall. */
const MAX_ROWS = 6

/** Words too common on this board to retrieve on. */
const STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'from', 'over', 'this', 'that', 'into', 'onto',
  'een', 'van', 'der', 'het', 'ook', 'naar', 'voor', 'door', 'meer', 'zijn', 'wordt',
  'worden', 'bespreken', 'delen', 'maken', 'tijdens', 'samen', 'aan',
])

/**
 * The words worth retrieving on, longest first.
 *
 * Long tokens carry the subject ("bitwarden", "starterscheck", "verbruikskosten"); short
 * ones carry grammar. Dutch compounds make this unusually effective on this board — a
 * single word is frequently the whole topic.
 */
export function issueTokens(issue: LinearIssue): string[] {
  const words = issue.title
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w))
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 6)
}

function defaultSearch(query: string, sourceTypes: string[], limit: number) {
  return search({ query, sourceTypes, limit, mode: 'hybrid' })
}

// ---------------------------------------------------------------------------
// Block 1 — The task (Linear, instant)
// ---------------------------------------------------------------------------

export function toDetail(issue: LinearIssue, provenance: Provenance | null): IssueDetail {
  return {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state,
    dueDate: issue.dueDate,
    labels: issue.labels,
    priority: issue.priority,
    hasRelations: issue.hasRelations,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    sections: describeSections(issue.description),
    origin: provenance
      ? {
          sourceType: provenance.sourceType,
          documentId: provenance.documentId,
          evidenceDate: provenance.evidenceDate,
          title: null,
          url: null,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Block 3 — Related tasks (Linear, fast)
// ---------------------------------------------------------------------------

export function relatedIssues(issue: LinearIssue, all: LinearIssue[]): LinearIssue[] {
  const tokens = issueTokens(issue)
  if (tokens.length === 0) return []

  return all
    .filter((other) => other.identifier !== issue.identifier)
    .map((other) => {
      const haystack = `${other.title} ${other.labels.join(' ')}`.toLowerCase()
      return { issue: other, score: tokens.reduce((n, t) => (haystack.includes(t) ? n + 1 : n), 0) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.issue.identifier.localeCompare(b.issue.identifier))
    .slice(0, MAX_ROWS)
    .map((x) => x.issue)
}

function toActionItem(issue: LinearIssue): ActionItemRow {
  return {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state,
    // Team RW is single-assignee by construction (PRD §16); owner stays honest at null.
    owner: null,
    dueDate: issue.dueDate,
    url: issue.url,
  }
}

// ---------------------------------------------------------------------------
// Block 4 — Meetings (Omni's calendar index + Graph)
// ---------------------------------------------------------------------------

function instantOf(doc: OmniDocument): number {
  const parsed = doc.date ? Date.parse(doc.date) : NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

export function toMeetingRow(doc: OmniDocument, reference: number): MeetingRow {
  const at = instantOf(doc)
  return {
    title: doc.title,
    date: doc.date,
    eventId: doc.eventId ?? null,
    url: doc.url,
    upcoming: at > reference,
    participants: doc.participants ?? [],
  }
}

/**
 * Calendar documents, newest first, deduped by title.
 *
 * A weekly series indexes one document per occurrence, so an unfiltered list of "meetings
 * about this task" is the same recurring sync eight times over. Collapsing by title keeps
 * the most recent occurrence, which is the one a reader means.
 */
export function toMeetingRows(docs: OmniDocument[], reference: number): MeetingRow[] {
  const seen = new Set<string>()
  const rows: MeetingRow[] = []
  for (const doc of [...docs].sort((a, b) => instantOf(b) - instantOf(a))) {
    const key = doc.title.trim().toLowerCase()
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    rows.push(toMeetingRow(doc, reference))
  }
  return rows.slice(0, MAX_ROWS)
}

// ---------------------------------------------------------------------------
// Block 5 — Email (Omni's Outlook index)
// ---------------------------------------------------------------------------

/** `From: Ruud van Falier <…>` out of the indexed mail body, when it is there. */
export function senderOf(snippet: string): string | null {
  const match = /^\s*From:\s*(.+)$/im.exec(snippet)
  if (!match) return null
  const raw = match[1].trim()
  const named = /^(.*?)\s*<[^>]+>$/.exec(raw)
  return (named ? named[1].trim() : raw) || null
}

/** The body with the indexed mail header block removed, trimmed to a readable excerpt. */
export function excerptOf(snippet: string, maxChars = 240): string {
  const body = snippet.replace(/^\s*(Subject|From|To|Cc|Date):.*$/gim, '').trim()
  const flat = body.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars).trimEnd()}…` : flat
}

/**
 * Subjects Outlook generates when somebody answers an invitation.
 *
 * These are not correspondence. A meeting with eight invitees produces eight of them, all
 * carrying the meeting's subject and therefore all matching the same search as the real
 * thread — on the first live run they took four of the six rows in this block and pushed
 * the actual conversation out of it. Dutch and English, because the tenant is both.
 */
const INVITE_REPLY_RE =
  /^\s*(accepted|declined|tentative|tentatively accepted|canceled|cancelled|updated|geaccepteerd|afgewezen|voorlopig geaccepteerd|geannuleerd|bijgewerkt|afgezegd)\s*:/i

export function isInviteReply(subject: string): boolean {
  return INVITE_REPLY_RE.test(subject)
}

export function toMailRows(docs: OmniDocument[]): MailRow[] {
  const seen = new Set<string>()
  const rows: MailRow[] = []
  for (const doc of [...docs]
    .filter((d) => !isInviteReply(d.title))
    .sort((a, b) => instantOf(b) - instantOf(a))) {
    // One thread, many replies: the subject repeats and the newest carries the state of it.
    const key = doc.title.trim().toLowerCase().replace(/^(re|fw|fwd):\s*/i, '')
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    rows.push({
      subject: doc.title,
      date: doc.date,
      url: doc.url,
      from: senderOf(doc.snippet),
      excerpt: excerptOf(doc.snippet),
    })
  }
  return rows.slice(0, MAX_ROWS)
}

// ---------------------------------------------------------------------------
// Sourcing
// ---------------------------------------------------------------------------

/**
 * `↗ Bijpraten BOVAG, 11 Sep` — the sourcing affordance PRD §8 asks of every claim.
 *
 * Shared with the synthesis rather than reimplemented: the two labels sit in the same
 * panel, frequently in the same block, and any drift between them shows.
 */
const sourceRefFor = toSourceRef

// ---------------------------------------------------------------------------
// buildIssueDrill
// ---------------------------------------------------------------------------

export interface DrillAction {
  label: string
  href: string | null
}

export interface IssueDrillPayload {
  type: 'issue'
  id: string
  title: string
  subtitle: string | null
  action: DrillAction
  blocks: DrillBlock<unknown>[]
}

/** Memoises a promise without starting it until the first block asks. */
function lazy<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => (pending ??= fn())
}

function emptyBlocks(): DrillBlock<unknown>[] {
  return ISSUE_BLOCK_ORDER.map((id) => ({
    id,
    title: BLOCK_TITLES[id],
    status: 'empty' as const,
    elapsedMs: 0,
  }))
}

/**
 * Assembles the five blocks for one task.
 *
 * Every block starts at once and is awaited together, so the slowest sets the total and
 * none waits on another. `Promise.all` is safe here precisely because {@link runBlock}
 * never rejects.
 */
export async function buildIssueDrill(
  identifier: string,
  deps: IssueDrillDeps = {},
): Promise<IssueDrillPayload> {
  const now = deps.now ?? Date.now
  const key = identifier.trim().toUpperCase()

  const issues = await (deps.loadIssues ?? fetchIssues)().catch((): LinearIssue[] => [])
  const issue = issues.find((i) => i.identifier.toUpperCase() === key)

  if (!issue) {
    return {
      type: 'issue',
      id: key,
      title: key,
      subtitle: null,
      action: { label: 'Open in Linear', href: null },
      blocks: emptyBlocks(),
    }
  }

  const provenance = parseProvenance(issue.description)
  const runSearch = deps.omniSearch ?? defaultSearch
  const tokens = issueTokens(issue)
  const query = tokens.join(' ')

  // One fetch of the document this task points at, shared by blocks 1 and 2: block 1 wants
  // its title and link, block 2 wants its contents. Lazy, so a task with no pointer never
  // makes the call at all.
  const origin = lazy(async (): Promise<OmniDocument | null> => {
    if (!provenance) return null
    const result = await (deps.loadDocument ?? fetchDocument)(provenance.documentId)
    return result.ok ? result.document : null
  })

  const reference = deps.dateKey ? Date.parse(`${deps.dateKey}T00:00:00Z`) : now()

  /*
   * One search serves both the meetings block and the email block.
   *
   * They ask the same question of the same index and differ only by source type, so
   * issuing them separately bought nothing and cost a request. That mattered: Omni
   * rate-limits bursts with a 429, and a panel that fired three searches at once tripped
   * it whenever two panels were opened in quick succession — which rendered as three
   * blocks saying *Could not reach Omni* for no reason the reader could see.
   *
   * Both blocks still resolve independently: they await the same lazy promise, and each
   * one fails, empties or fills on its own terms.
   */
  const correspondence = lazy(() =>
    query
      ? runSearch(query, [SOURCE_TYPES.calendar, SOURCE_TYPES.mail], 40)
      : Promise.resolve({ ok: true as const, documents: [] }),
  )

  const ofType = (docs: OmniDocument[], sourceType: string) =>
    docs.filter((d) => d.sourceType === sourceType)

  const blocks = await Promise.all([
    runBlock<IssueDetail>(
      'issue-detail',
      async () => {
        const detail = toDetail(issue, provenance)
        // Naming the recording is worth one lookup; failing to reach it is not worth
        // failing the block, which is otherwise pure Linear and always available.
        const doc = await origin().catch(() => null)
        if (detail.origin && doc) {
          detail.origin.title = doc.title
          detail.origin.url = doc.url
        }
        return { data: detail, sources: doc ? [sourceRefFor(doc)] : [] }
      },
      now,
    ),

    runBlock<ProseData>('said', () => saidBlock(issue, provenance, origin, runSearch, deps), now),

    runBlock<ActionItemRow[]>(
      'related-issues',
      async () => ({ data: relatedIssues(issue, issues).map(toActionItem) }),
      now,
    ),

    runBlock<MeetingRow[]>(
      'meetings',
      async () => {
        if (!query) return { empty: true }
        const result = await correspondence()
        if (!result.ok) return blockFailure(result.message)
        return { data: toMeetingRows(ofType(result.documents, SOURCE_TYPES.calendar), reference) }
      },
      now,
    ),

    runBlock<MailRow[]>(
      'email',
      async () => {
        if (!query) return { empty: true }
        const result = await correspondence()
        if (!result.ok) return blockFailure(result.message)
        return { data: toMailRows(ofType(result.documents, SOURCE_TYPES.mail)) }
      },
      now,
    ),
  ])

  return {
    type: 'issue',
    id: issue.identifier,
    title: `${issue.identifier} · ${issue.title}`,
    subtitle: subtitleFor(issue),
    action: { label: 'Open in Linear', href: issue.url || null },
    blocks,
  }
}

function subtitleFor(issue: LinearIssue): string {
  const parts: string[] = [issue.state]
  if (issue.dueDate) parts.push(`due ${issue.dueDate}`)
  if (issue.labels.length) parts.push(issue.labels.join(', '))
  return parts.join(' · ')
}

/**
 * Block 2 — *What was said*.
 *
 * Two routes to the same block, and the difference between them matters:
 *
 *  1. **The task points at a recording.** One document, fetched by id, read in full. The
 *     block then says what was discussed in *that* meeting, cited to it. This is the good
 *     case and, on this board, the common one for anything extracted from a call.
 *  2. **It points nowhere.** Fall back to a keyword search over transcripts — weaker, and
 *     honest about it: the synthesis is handed several candidate documents rather than the
 *     one true one, and anything it cannot source comes back marked *inferred* (PRD §8).
 *
 * A pointer that Omni cannot resolve falls through to route 2 rather than failing: a dead
 * id is a reason to look elsewhere, not a reason to show an error.
 */
async function saidBlock(
  issue: LinearIssue,
  provenance: Provenance | null,
  origin: () => Promise<OmniDocument | null>,
  runSearch: (query: string, sourceTypes: string[], limit: number) => Promise<OmniSearchResult>,
  deps: IssueDrillDeps,
): Promise<BlockOutcome<ProseData>> {
  const docs: OmniDocument[] = []

  // Kept whether or not it turned out to be readable: it is the thing the reader wants to
  // open, and a 67KB transcript comes back from Omni with a title and no content at all.
  const originDoc = provenance ? await origin() : null

  if (provenance) {
    const doc = originDoc
    // Only a document with text in it is worth synthesising from. Omni returns `content`
    // for bodies up to roughly 100KB and null above that, and a two-hour transcript is
    // exactly the document most likely to be too big — so an empty body falls through to
    // the search, which returns highlights for it instead of nothing.
    if (doc && doc.snippet.trim()) docs.push(doc)
  }

  const tokens = issueTokens(issue)
  if (docs.length === 0 && tokens.length > 0) {
    const result = await runSearch(tokens.join(' '), [SOURCE_TYPES.transcript], 6)
    if (!result.ok) return blockFailure(result.message)
    docs.push(...result.documents.filter((d) => d.snippet.trim()))
  }

  if (docs.length === 0 && !originDoc) return { empty: true }

  const synth =
    docs.length > 0
      ? await (deps.synthesise ?? whatWasSaid)(issue, docs)
      : { prose: '', sources: [] as SourceRef[], inferred: false }
  const prose = synth.prose?.trim() ?? ''

  /*
   * The recording is always linked, whether or not the model could cite it.
   *
   * `sources` carries only what the synthesis attributed statement by statement, and a
   * statement it could not attribute comes back marked *inferred* with no citation — the
   * correct hedge (PRD §8), but it left the block with nothing to click. The reader's next
   * move after reading a summary of a meeting is to go and listen to it, so the recording
   * this task was written down from leads the list, deduped against anything already cited.
   *
   * Only *cited* documents follow it. Appending every candidate the fallback search
   * returned put six links to unrelated Daily NVM calls under a sentence saying nothing was
   * discussed — six invitations to check a claim against documents that do not support it.
   */
  const cited = new Set((synth.sources ?? []).map((s) => s.documentId).filter(Boolean))
  const sources: SourceRef[] = [
    ...(originDoc && !cited.has(originDoc.id) ? [sourceRefFor(originDoc)] : []),
    ...(synth.sources ?? []),
  ]

  // A recording we could name but never read. Saying so is more useful than *Nothing
  // found*, and far more useful than a blank block beside a link (PRD §9).
  if (!prose) {
    if (!originDoc) return { empty: true }
    return {
      data: {
        prose: `This task was written down from ${describeOrigin(provenance)}, but its text could not be read back — the recording is linked below.`,
        inferred: true,
      },
      sources,
    }
  }

  return { data: { prose, inferred: synth.inferred === true }, sources }
}

/** "a meeting recording" / "an email" — the phrase the *What was said* fallback uses. */
function describeOrigin(provenance: Provenance | null): string {
  if (provenance?.sourceType === 'fireflies') return 'a meeting recording'
  if (provenance?.sourceType === 'outlook') return 'an email'
  if (provenance?.sourceType === 'outlook_calendar') return 'a calendar item'
  return 'another system'
}

/**
 * Calendar events on the viewed week that mention this task's words.
 *
 * Kept for the caller that wants Graph rather than Omni's index — Omni's calendar coverage
 * is historical and complete, but Graph is authoritative for what is actually scheduled.
 */
export async function upcomingMeetingsFor(
  issue: LinearIssue,
  dateKey: string = toDateKey(new Date()),
): Promise<MeetingRow[]> {
  const tokens = issueTokens(issue)
  if (tokens.length === 0) return []
  const week = await fetchEventsForWeek(weekdaysOf(dateKey)).catch(() => ({}))
  const reference = Date.parse(`${dateKey}T00:00:00Z`)

  const rows: MeetingRow[] = []
  const seen = new Set<string>()
  for (const events of Object.values(week)) {
    for (const event of events) {
      const haystack = event.subject.toLowerCase()
      if (!tokens.some((t) => haystack.includes(t))) continue
      if (seen.has(event.id)) continue
      seen.add(event.id)
      rows.push({
        title: event.subject,
        date: event.start,
        eventId: event.id,
        url: event.webLink,
        upcoming: Date.parse(event.start) > reference,
        participants: event.attendees.map((a) => a.email),
      })
    }
  }
  return rows.slice(0, MAX_ROWS)
}

export type { IssueBlockId }
