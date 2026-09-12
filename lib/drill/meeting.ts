// Shared, client-safe vocabulary lives in ./blocks so the panel can import it
// without pulling this server-only module into the browser bundle.
export { BLOCK_ORDER, BLOCK_TITLES, BLOCK_SOURCE_LABELS } from './blocks'
export type { DrillBlockId, DrillType } from './blocks'
import { BLOCK_ORDER, BLOCK_TITLES, BLOCK_SOURCE_LABELS } from './blocks'
import type { DrillBlockId, DrillType } from './blocks'
import 'server-only'

import { GRAPH_USER_PRINCIPAL_NAME } from '../config'
import { fetchEventsForDay, fetchEventsForWeek } from '../graph/calendar'
import { fetchIssues } from '../linear/client'
import { searchByAttendees } from '../omni/client'
import type { OmniSearchResult } from '../omni/client'
import { accountStatus, type BrainAccountStatus, type BrainResult } from '../brain/client'
import { lastTime as lastTimeSynthesis, unresolved as unresolvedSynthesis } from '../ai/synthesis'
import { toDateKey, weekdaysOf } from '../time'
import type {
  BlockStatus,
  CalendarEvent,
  DrillBlock,
  LinearIssue,
  OmniDocument,
  SourceRef,
  TaskState,
} from '../types'

/**
 * The meeting drill-in (PRD §8) — five blocks, fixed order.
 *
 * "The order *is* the design: it runs from what you can verify instantly to what the AI
 * had to go and find." Attendees are already in the calendar payload; *Unresolved* needs a
 * retrieval sweep and a synthesis pass.
 *
 * The hard rule of this module is **independence**. Every block is resolved by
 * {@link runBlock}, which owns its own try/catch, its own clock and its own status. One
 * source being down produces one block reading *Could not reach Omni · Retry* and four
 * blocks reading normally — never a whole-panel error, never a thrown exception. Nothing
 * in here rejects: {@link buildMeetingDrill} always resolves with five blocks in order.
 *
 * Omni has no API key on this machine, so blocks 2 and 5 legitimately fail today. That is
 * the common path, and it is a rendered state, not an incident.
 */

// ---------------------------------------------------------------------------
// Block identity and order
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Block payloads
// ---------------------------------------------------------------------------

export interface AttendeeRow {
  email: string
  name: string
  role: string | null
  company: string | null
  /** Same mail domain as the single identity this product reads for. */
  isInternal: boolean
  isOrganizer: boolean
  /** Human phrase, e.g. "in this meeting" — null when we genuinely do not know. */
  lastContact: string | null
}

export interface ActionItemRow {
  identifier: string
  title: string
  state: TaskState
  owner: string | null
  dueDate: string | null
  url: string
}

/** Blocks 2 and 5 — prose, because their meaning lives in the connective tissue (PRD §8). */
export interface ProseData {
  prose: string
  /** Marked *inferred* rather than dropped when the model could not source it. */
  inferred: boolean
}

export type AccountData = BrainAccountStatus

export interface DrillAction {
  /** Always one of "Open in Linear" / "Open in Outlook" / "Open in Brain". */
  label: string
  href: string | null
}

export interface DrillPayload {
  type: DrillType
  id: string
  title: string
  subtitle: string | null
  action: DrillAction
  blocks: DrillBlock<unknown>[]
}

// ---------------------------------------------------------------------------
// The synthesis seam — lib/ai/synthesis
// ---------------------------------------------------------------------------

export interface SynthesisResult {
  prose: string
  sources: SourceRef[]
  inferred: boolean
}

export type SynthesisFn = (
  event: CalendarEvent,
  omniDocs: OmniDocument[],
) => Promise<SynthesisResult>

/**
 * The two synthesised blocks come from `lib/ai/synthesis`, which returns the agreed
 * `{ prose, sources, inferred }` shape. Both are injectable through {@link MeetingDrillDeps}
 * so tests never reach the gateway.
 */
const SYNTHESISERS: Record<'lastTime' | 'unresolved', SynthesisFn> = {
  lastTime: lastTimeSynthesis,
  unresolved: unresolvedSynthesis,
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface MeetingDrillDeps {
  loadEvent?: (eventId: string) => Promise<CalendarEvent | null>
  loadIssues?: () => Promise<LinearIssue[]>
  loadOmniDocs?: (event: CalendarEvent) => Promise<OmniSearchResult>
  loadAccount?: (company: string) => Promise<BrainResult<BrainAccountStatus | null>>
  lastTime?: SynthesisFn
  unresolved?: SynthesisFn
  now?: () => number
}

const INTERNAL_DOMAIN = GRAPH_USER_PRINCIPAL_NAME.split('@')[1]?.toLowerCase() ?? ''

// ---------------------------------------------------------------------------
// runBlock — the containment boundary
// ---------------------------------------------------------------------------

interface BlockOutcome<T> {
  data?: T
  sources?: SourceRef[]
  /** Force the *Nothing found* reading even when `data` is present. */
  empty?: boolean
}

class BlockFailure extends Error {}

/** Raised inside a block body to render *Could not reach X · Retry* rather than a crash. */
export function blockFailure(message: string): never {
  throw new BlockFailure(message)
}

/**
 * Runs one block body under its own clock and its own catch.
 *
 * Never rejects. An empty payload becomes `'empty'` (*Nothing found*), a thrown error
 * becomes `'failed'` with a message safe to render — secrets are scrubbed by
 * {@link safeMessage} before they can reach a header.
 */
async function runBlock<T>(
  id: DrillBlockId,
  fn: () => Promise<BlockOutcome<T>>,
  now: () => number,
): Promise<DrillBlock<T>> {
  const started = now()
  const base = { id, title: BLOCK_TITLES[id] } as const

  try {
    const outcome = await fn()
    const empty = outcome.empty === true || isEmpty(outcome.data)
    const status: BlockStatus = empty ? 'empty' : 'ok'
    return {
      ...base,
      status,
      elapsedMs: Math.max(0, now() - started),
      ...(empty ? {} : { data: outcome.data }),
      ...(outcome.sources?.length ? { sources: outcome.sources } : {}),
    }
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      elapsedMs: Math.max(0, now() - started),
      error: safeMessage(err, BLOCK_SOURCE_LABELS[id]),
    }
  }
}

function isEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true
  if (Array.isArray(data)) return data.length === 0
  if (typeof data === 'string') return data.trim().length === 0
  return false
}

/**
 * A message fit to print in a block header.
 *
 * Anything long, key-shaped or bearer-shaped is dropped in favour of the generic line —
 * a header is the last place an API key should be able to surface (PRD §12.5).
 */
export function safeMessage(err: unknown, sourceLabel: string): string {
  const fallback = `Could not reach ${sourceLabel}`
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const text = raw.trim()
  if (!text || text.length > 160) return fallback
  if (/(bearer|api[-_ ]?key|authorization|token|secret|password)/i.test(text)) return fallback
  // A long unbroken run of key-ish characters is a credential, whatever it is called.
  if (/[A-Za-z0-9_-]{28,}/.test(text)) return fallback
  return text
}

// ---------------------------------------------------------------------------
// Block 1 — Attendees (Graph, instant)
// ---------------------------------------------------------------------------

/** `jorien@acme.nl` → `Acme`. Good enough to name a company; never shown as a fact. */
export function companyFromEmail(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain || domain === INTERNAL_DOMAIN) return null
  const label = domain.split('.')[0]
  if (!label) return null
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function isInternal(email: string): boolean {
  return email.toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`)
}

export function toAttendeeRows(event: CalendarEvent): AttendeeRow[] {
  return event.attendees.map((a) => ({
    email: a.email,
    name: a.name ?? a.email.split('@')[0],
    // Role is a CRM field; without a contact lookup we say nothing rather than guess.
    role: null,
    company: companyFromEmail(a.email),
    isInternal: isInternal(a.email),
    isOrganizer: a.isOrganizer,
    lastContact: null,
  }))
}

/** The external companies in the room, most-represented first. */
export function externalCompanies(event: CalendarEvent): string[] {
  const counts = new Map<string, number>()
  for (const a of event.attendees) {
    const company = companyFromEmail(a.email)
    if (!company) continue
    counts.set(company, (counts.get(company) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
}

// ---------------------------------------------------------------------------
// Block 3 — Open action items (Linear, fast)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'from', 'over', 'call', 'sync', 'meeting', 'weekly', 'daily',
  'standup', 'stand', 'catch', 'review', 'session', 'intro', 'kick', 'off', 'kickoff', 'update',
  'met', 'een', 'van', 'der', 'overleg', 'bespreking',
])

/** Subject and company words worth matching an issue title against. */
export function meetingTokens(event: CalendarEvent): string[] {
  const words = `${event.subject} ${externalCompanies(event).join(' ')}`
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  return [...new Set(words)]
}

/**
 * Issues this meeting is plausibly about.
 *
 * A token match on title or label, strongest first. Deliberately shallow: a wrong row is
 * cheap to ignore, a missing row is the reason you opened the panel. Meeting-linked
 * ranking proper lives in `lib/domain/ranking.ts`.
 */
export function relatedIssues(event: CalendarEvent, issues: LinearIssue[]): LinearIssue[] {
  const tokens = meetingTokens(event)
  if (tokens.length === 0) return []

  return issues
    .map((issue) => {
      const haystack = `${issue.title} ${issue.labels.join(' ')}`.toLowerCase()
      const score = tokens.reduce((n, t) => (haystack.includes(t) ? n + 1 : n), 0)
      return { issue, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.issue.identifier.localeCompare(b.issue.identifier))
    .slice(0, 6)
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
// Defaults
// ---------------------------------------------------------------------------

async function defaultLoadEvent(eventId: string): Promise<CalendarEvent | null> {
  const todayKey = toDateKey(new Date())
  const today = await fetchEventsForDay(todayKey)
  const hit = today.find((e) => e.id === eventId)
  if (hit) return hit

  // A panel can be opened from the week zone or restored from a URL on another day.
  const week = await fetchEventsForWeek(weekdaysOf(todayKey))
  for (const day of Object.values(week)) {
    const match = day.find((e) => e.id === eventId)
    if (match) return match
  }
  return null
}

function defaultLoadOmniDocs(event: CalendarEvent): Promise<OmniSearchResult> {
  return searchByAttendees(
    event.attendees.map((a) => a.email),
    { keywords: event.subject },
  )
}

// ---------------------------------------------------------------------------
// buildMeetingDrill
// ---------------------------------------------------------------------------

/**
 * Assembles the five blocks for one meeting.
 *
 * Every block is started at once and awaited together, so the slowest one sets the total
 * and none of them waits on another. `Promise.all` is safe here precisely because
 * {@link runBlock} never rejects.
 */
export async function buildMeetingDrill(
  eventId: string,
  deps: MeetingDrillDeps = {},
): Promise<DrillPayload> {
  const now = deps.now ?? Date.now
  const event = await (deps.loadEvent ?? defaultLoadEvent)(eventId).catch(() => null)

  if (!event) {
    return {
      type: 'meeting',
      id: eventId,
      title: 'Meeting',
      subtitle: null,
      action: { label: 'Open in Outlook', href: null },
      blocks: BLOCK_ORDER.map((id) => ({
        id,
        title: BLOCK_TITLES[id],
        status: 'empty' as const,
        elapsedMs: 0,
      })),
    }
  }

  // One retrieval sweep feeds both prose blocks; they still resolve independently, and a
  // failed sweep fails each of them on its own terms.
  const omniDocs = lazy(() => (deps.loadOmniDocs ?? defaultLoadOmniDocs)(event))

  const blocks = await Promise.all([
    runBlock<AttendeeRow[]>('attendees', async () => ({ data: toAttendeeRows(event) }), now),

    runBlock<ProseData>(
      'last-time',
      () => proseBlock(event, omniDocs, deps.lastTime, 'lastTime'),
      now,
    ),

    runBlock<ActionItemRow[]>(
      'action-items',
      async () => {
        const issues = await (deps.loadIssues ?? fetchIssues)()
        return { data: relatedIssues(event, issues).map(toActionItem) }
      },
      now,
    ),

    runBlock<AccountData>(
      'account',
      async () => {
        const [company] = externalCompanies(event)
        if (!company) return { empty: true }
        const result = await (deps.loadAccount ?? accountStatus)(company)
        if (!result.ok) {
          if (result.reason === 'unconfigured') return { empty: true }
          return blockFailure(result.message)
        }
        return { data: result.data ?? undefined }
      },
      now,
    ),

    runBlock<ProseData>(
      'unresolved',
      () => proseBlock(event, omniDocs, deps.unresolved, 'unresolved'),
      now,
    ),
  ])

  return {
    type: 'meeting',
    id: event.id,
    title: event.subject,
    subtitle: subtitleFor(event),
    action: { label: 'Open in Outlook', href: event.webLink },
    blocks,
  }
}

/** Memoises a promise without starting it until the first block asks. */
function lazy<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => (pending ??= fn())
}

async function proseBlock(
  event: CalendarEvent,
  omniDocs: () => Promise<OmniSearchResult>,
  injected: SynthesisFn | undefined,
  which: 'lastTime' | 'unresolved',
): Promise<BlockOutcome<ProseData>> {
  const result = await omniDocs()
  if (!result.ok) {
    // No key on this machine is the common path — and it is *Could not reach Omni · Retry*,
    // never a blank and never a crash.
    return blockFailure(result.message)
  }
  if (result.documents.length === 0) return { empty: true }

  const synth = await (injected ?? SYNTHESISERS[which])(event, result.documents)
  const prose = synth.prose?.trim() ?? ''
  if (!prose) return { empty: true }
  return { data: { prose, inferred: synth.inferred === true }, sources: synth.sources ?? [] }
}

function subtitleFor(event: CalendarEvent): string | null {
  const parts: string[] = []
  if (event.location) parts.push(event.location)
  const external = externalCompanies(event)
  if (external.length) parts.push(external.join(', '))
  return parts.length ? parts.join(' · ') : null
}

// ---------------------------------------------------------------------------
// The other drill types (PRD §8, "Other drill-in types")
// ---------------------------------------------------------------------------

export interface GenericDrillDeps {
  loadIssues?: () => Promise<LinearIssue[]>
  now?: () => number
}

/**
 * The issue drill-in, reduced to the block vocabulary the panel already speaks.
 *
 * `lib/types.ts` fixes the five block ids, so an issue reuses *Open action items* for the
 * issue and its neighbours and leaves the rest honestly empty rather than inventing ids.
 * Enough to make the trail real (meeting → issue) without pretending to a full build.
 */
export async function buildIssueDrill(
  identifier: string,
  deps: GenericDrillDeps = {},
): Promise<DrillPayload> {
  const now = deps.now ?? Date.now
  const key = identifier.trim().toUpperCase()

  const items = await runBlock<ActionItemRow[]>(
    'action-items',
    async () => {
      const issues = await (deps.loadIssues ?? fetchIssues)()
      const self = issues.find((i) => i.identifier.toUpperCase() === key)
      if (!self) return { empty: true }
      const tokens = self.title
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
      const neighbours = issues
        .filter((i) => i.identifier !== self.identifier)
        .filter((i) => tokens.some((t) => i.title.toLowerCase().includes(t)))
        .slice(0, 5)
      return { data: [self, ...neighbours].map(toActionItem) }
    },
    now,
  )

  const issue = items.data?.[0]

  return {
    type: 'issue',
    id: key,
    title: issue ? `${issue.identifier} · ${issue.title}` : key,
    subtitle: issue?.state ?? null,
    action: { label: 'Open in Linear', href: issue?.url ?? null },
    blocks: BLOCK_ORDER.map((id) =>
      id === 'action-items'
        ? items
        : { id, title: BLOCK_TITLES[id], status: 'empty' as const, elapsedMs: 0 },
    ),
  }
}

/**
 * Person and account drill-ins are specified (PRD §8) but not built. They render as five
 * empty containers with the right escape hatch rather than a dead end or a lie.
 */
export function buildPlaceholderDrill(type: 'person' | 'account', id: string): DrillPayload {
  return {
    type,
    id,
    title: id,
    subtitle: null,
    action: { label: 'Open in Brain', href: null },
    blocks: BLOCK_ORDER.map((blockId) => ({
      id: blockId,
      title: BLOCK_TITLES[blockId],
      status: 'empty' as const,
      elapsedMs: 0,
    })),
  }
}

/** Routes a drill request to its builder. Never throws. */
export async function buildDrill(
  type: DrillType,
  id: string,
  deps: MeetingDrillDeps = {},
): Promise<DrillPayload> {
  if (type === 'meeting') return buildMeetingDrill(id, deps)
  if (type === 'issue') return buildIssueDrill(id, deps)
  return buildPlaceholderDrill(type, id)
}
