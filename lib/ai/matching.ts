/**
 * Matching open issues to today's meetings — PRD §17.2, ranking input 3 (round 2, answer 5d).
 *
 * Linear holds no link to the calendar and never will: there is no field for it, no project
 * structure to infer one from, and the board is small enough that a heuristic on shared words
 * would fire constantly ("sync", "review", "update"). So the link is produced by the model
 * from subjects, attendees and titles.
 *
 * The stakes are calibrated: a match is worth `MOD_MEETING` (500) in `lib/domain/ranking.ts`,
 * a modifier that settles ties between issues in the same due-date band and can never promote
 * one past a real deadline. A false positive therefore costs one wrong reason line; a missed
 * match costs nothing at all. Everything here is biased towards silence — the confidence floor,
 * the prompt, and the tolerant parser that drops anything it cannot verify against the inputs.
 *
 * Nothing in this module throws. An empty calendar, an empty backlog, a gateway fault or a
 * malformed answer all produce an empty map, and the ranking simply runs without the signal.
 */

import { completeStructured, type CompleteStructuredRequest } from './client'
import { MATCHING_SYSTEM_PROMPT } from './prompts'
import { getOrFetch } from '../cache'
import { MODELS, TTL } from '../config'
import { formatTime } from '../time'
import type { CalendarEvent, LinearIssue } from '../types'

/**
 * One matched pair. Structurally a `MeetingLink` from `lib/domain/ranking.ts` plus the evidence
 * for it, so the map can be handed to `rankTasks` directly.
 */
export interface MeetingMatch {
  eventId: string
  eventSubject: string
  /** The model's own probability that this issue comes up in that meeting, 0–1. */
  confidence: number
  /** One clause, rendered wherever the match needs explaining. */
  reason: string
}

/**
 * Below this, a pair is not evidence of anything. Chosen high: the model is being asked for a
 * judgement it cannot verify, and a hedged match is a guess wearing a number.
 */
export const MIN_CONFIDENCE = 0.6

/** Prompt budget. The board holds ~22 open issues and a day holds ~8 meetings (PRD §16.2). */
const MAX_EVENTS = 12
const MAX_ISSUES = 30

interface MatchDraft {
  pairs?: Array<{
    issueIdentifier?: unknown
    eventId?: unknown
    confidence?: unknown
    reason?: unknown
  }>
}

/** The one AI call this module makes. Injected by the tests; never stubbed in production. */
export type MatchCompleter = (req: CompleteStructuredRequest<MatchDraft>) => Promise<MatchDraft>

const defaultCompleter: MatchCompleter = (req) => completeStructured(req)

const DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issueIdentifier: { type: 'string', description: 'Exactly as given, e.g. RW-214.' },
          eventId: { type: 'string', description: 'Exactly as given.' },
          confidence: { type: 'number', description: '0 to 1.' },
          reason: { type: 'string', description: 'One clause naming what they share.' },
        },
      },
    },
  },
}

function describeEvents(events: CalendarEvent[]): string {
  return events
    .map((event) => {
      const who = event.attendees
        .slice(0, 6)
        .map((a) => a.name?.trim() || a.email)
        .join(', ')
      return (
        `- eventId: ${event.id} | ${formatTime(event.start)} | ${event.subject}` +
        ` | with: ${who || 'no attendees listed'}`
      )
    })
    .join('\n')
}

function describeIssues(issues: LinearIssue[]): string {
  return issues
    .map((issue) => `- ${issue.identifier} | ${issue.state} | ${issue.title}`)
    .join('\n')
}

function inputKey(events: CalendarEvent[], issues: LinearIssue[]): string {
  return [
    events.map((e) => `${e.id}:${e.subject}`).join(','),
    issues.map((i) => `${i.identifier}:${i.title}`).join(','),
  ].join('||')
}

/**
 * Keeps only pairs that name inputs we actually supplied and clear {@link MIN_CONFIDENCE}.
 *
 * Exported because this, not the prompt, is what makes the guarantee: an identifier the model
 * invented, a confidence that is not a number, a second match for an issue already matched —
 * all are dropped here rather than reaching the ranking.
 */
export function collectMatches(
  draft: MatchDraft | null | undefined,
  events: CalendarEvent[],
  issues: LinearIssue[],
): Map<string, MeetingMatch> {
  const byEvent = new Map(events.map((e) => [e.id, e]))
  const identifiers = new Set(issues.map((i) => i.identifier))
  const matches = new Map<string, MeetingMatch>()

  const pairs = Array.isArray(draft?.pairs) ? draft.pairs : []
  for (const pair of pairs) {
    const identifier = typeof pair?.issueIdentifier === 'string' ? pair.issueIdentifier.trim() : ''
    const eventId = typeof pair?.eventId === 'string' ? pair.eventId.trim() : ''
    const confidence = typeof pair?.confidence === 'number' ? pair.confidence : NaN
    const reason = typeof pair?.reason === 'string' ? pair.reason.trim() : ''

    if (!identifiers.has(identifier)) continue
    const event = byEvent.get(eventId)
    if (!event) continue
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) continue

    const existing = matches.get(identifier)
    // "Pair each issue at most once": if the model ignored that, keep its own best answer.
    if (existing && existing.confidence >= confidence) continue

    matches.set(identifier, {
      eventId: event.id,
      eventSubject: event.subject,
      confidence: Math.min(1, confidence),
      reason: reason || `related to ${event.subject}`,
    })
  }

  return matches
}

/**
 * Issues matched to today's meetings, keyed by issue identifier.
 *
 * Cached on the inputs themselves, so the map is content-addressed and a re-render never pays
 * for a second call. The AI call is the last parameter so the tests can pass a fake.
 */
export async function matchIssuesToMeetings(
  events: CalendarEvent[],
  issues: LinearIssue[],
  complete: MatchCompleter = defaultCompleter,
): Promise<Map<string, MeetingMatch>> {
  const candidateEvents = (events ?? [])
    .filter((e) => e && !e.isAllDay && !e.isCancelled && e.subject?.trim())
    .slice(0, MAX_EVENTS)
  const candidateIssues = (issues ?? []).filter((i) => i?.identifier).slice(0, MAX_ISSUES)

  // Nothing to correlate. Not a failure, and not worth a round trip.
  if (candidateEvents.length === 0 || candidateIssues.length === 0) {
    return new Map()
  }

  try {
    return await getOrFetch(
      `ai:match:${inputKey(candidateEvents, candidateIssues)}`,
      TTL.synthesis,
      async () => {
        const draft = await complete({
          system: MATCHING_SYSTEM_PROMPT,
          user:
            `TODAY'S MEETINGS\n${describeEvents(candidateEvents)}\n\n` +
            `OPEN ISSUES\n${describeIssues(candidateIssues)}`,
          schema: DRAFT_SCHEMA,
          schemaName: 'meeting_issue_matches',
          model: MODELS.synthesis,
          maxTokens: 800,
        })
        return collectMatches(draft, candidateEvents, candidateIssues)
      },
    )
  } catch {
    // The signal is a tiebreaker. Losing it degrades the reason line, nothing else.
    return new Map()
  }
}
