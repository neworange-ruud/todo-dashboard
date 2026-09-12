/**
 * The two synthesised drill-in blocks — PRD §8, blocks 2 and 5.
 *
 * "Last time" and "Unresolved" are prose because "their meaning lives in the connective
 * tissue". Everything else in the panel is rows; these two are paragraphs, and that is a
 * deliberate asymmetry, not an oversight.
 *
 * The rule that governs this file is PRD §8's sourcing paragraph. Every statement carries the
 * document it came from. A statement the model cannot source is **kept and marked inferred**,
 * never quietly dropped: "a visibly hedged guess is more useful than a confident invention and
 * far more useful than silence." A citation pointing at a document that was not in the input
 * is treated as unsourced — an invented reference is the one failure that cannot be checked by
 * the reader and will therefore be believed.
 *
 * When Omni has nothing — unconfigured, unreachable, or simply no hits — this returns
 * {@link EMPTY_SYNTHESIS} and never calls the model. The block renders *Nothing found*
 * (PRD §8), which is true, instead of a paragraph assembled out of nothing, which is not.
 */

import { completeStructured, type CompleteStructuredRequest } from './client'
import {
  LAST_TIME_SYSTEM_PROMPT,
  UNRESOLVED_SYSTEM_PROMPT,
  WHAT_WAS_SAID_SYSTEM_PROMPT,
} from './prompts'
import { getOrFetch } from '../cache'
import { MODELS, TTL } from '../config'
import { formatDayMonth, formatTime, toDateKey } from '../time'
import type { OmniSearchResult } from '../omni/client'
import { withoutProvenance } from '../domain/provenance'
import type { CalendarEvent, LinearIssue, OmniDocument, SourceRef } from '../types'

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface SynthesisStatement {
  text: string
  /** The document this claim came from, or null when the model could not source it. */
  source: SourceRef | null
  /** True when `source` is null — PRD §8's hedge marker. */
  inferred: boolean
}

export interface SynthesisResult {
  /** The statements as one paragraph, in order. Empty string when there is nothing to say. */
  prose: string
  /** Deduped, in first-mention order, for the `↗ source` affordances beneath the block. */
  sources: SourceRef[]
  /** True when at least one statement could not be sourced. */
  inferred: boolean
  statements: SynthesisStatement[]
  /** Nothing to synthesise. The block header shows *Nothing found*, not an error. */
  empty: boolean
}

/** Sentinel for callers that want to compare rather than inspect. Never returned directly. */
export const EMPTY_SYNTHESIS: Readonly<SynthesisResult> = Object.freeze({
  prose: '',
  sources: [],
  inferred: false,
  statements: [],
  empty: true,
})

/** A fresh empty result, so no two callers share the same arrays. */
export function emptyResult(): SynthesisResult {
  return { prose: '', sources: [], inferred: false, statements: [], empty: true }
}

interface SynthesisDraft {
  statements?: Array<{ text?: unknown; documentId?: unknown }>
}

/** The one AI call these blocks make. Injected by the tests; never stubbed in production. */
export type SynthesisCompleter = (
  req: CompleteStructuredRequest<SynthesisDraft>,
) => Promise<SynthesisDraft>

const defaultCompleter: SynthesisCompleter = (req) => completeStructured(req)

/** Raw JSON Schema, hand-validated afterwards, so a sloppy answer degrades instead of throwing. */
const DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One complete sentence.' },
          documentId: {
            type: 'string',
            description: 'Id of the source document, copied exactly. Empty when unsourceable.',
          },
        },
      },
    },
  },
}

/** Beyond this the prompt stops getting better and starts getting expensive. */
const MAX_DOCUMENTS = 10
/** PRD §8: "two or three sentences". */
const MAX_STATEMENTS = 4

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

/** Accepts either the raw documents or the `{ ok }` result straight from `lib/omni/client`. */
export type OmniInput = OmniSearchResult | OmniDocument[]

function documentsOf(input: OmniInput): OmniDocument[] {
  if (Array.isArray(input)) return input
  return input.ok ? input.documents : []
}

/**
 * `"28 Aug"` — the form PRD §8 shows in `↗ Meeting notes, 28 Aug`, with the year added
 * once it is not this one.
 *
 * Delegated to `lib/time.formatDayMonth`, which owns the hand-fixed month abbreviations:
 * `Intl`'s en-GB `month: 'short'` spells September "Sept", and this label sits in the same
 * panel as the drill-in's own date stamps.
 */
const shortDate = (iso: string | null) => formatDayMonth(iso)

/**
 * Fireflies' own name for a recording nobody titled: `Sep 04, 01:04 PM`.
 *
 * Such a title already *is* a date, so the usual ", 4 Sep" suffix produces
 * "Sep 04, 01:04 PM, 4 Sep" — the same day said twice, in two different formats.
 */
const TIMESTAMP_TITLE = /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{1,2}:\d{2}\s*(?:AM|PM)$/

/** `↗ Meeting notes, 28 Aug` — the form PRD §8 asks of every sourced claim. */
export function toSourceRef(doc: OmniDocument): SourceRef {
  const title = doc.title.trim()
  const when = shortDate(doc.date)
  const label = when && !TIMESTAMP_TITLE.test(title) ? `${title}, ${when}` : title
  return {
    label,
    ...(doc.url ? { url: doc.url } : {}),
    documentId: doc.id,
  }
}

function describeDocuments(docs: OmniDocument[]): string {
  return docs
    .map((doc) => {
      const when = shortDate(doc.date) ?? 'undated'
      return [
        `documentId: ${doc.id}`,
        `type: ${doc.sourceType} | date: ${when}`,
        `title: ${doc.title}`,
        doc.snippet ? `content: ${doc.snippet}` : 'content: (none indexed)',
      ].join('\n')
    })
    .join('\n\n---\n\n')
}

function describeEvent(event: CalendarEvent): string {
  const who = event.attendees
    .map((a) => (a.name?.trim() ? `${a.name} <${a.email}>` : a.email))
    .join(', ')
  return [
    `Meeting: ${event.subject}`,
    `When: ${toDateKey(new Date(event.start))} ${formatTime(event.start)}-${formatTime(event.end)}`,
    `With: ${who || '(no attendees listed)'}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Shared generation
// ---------------------------------------------------------------------------

async function synthesise(
  block: 'last-time' | 'unresolved',
  system: string,
  event: CalendarEvent,
  input: OmniInput,
  complete: SynthesisCompleter,
): Promise<SynthesisResult> {
  const docs = documentsOf(input).slice(0, MAX_DOCUMENTS)
  // No documents means no answer. Not an error, not an invention — PRD §8, *Nothing found*.
  if (docs.length === 0) return emptyResult()

  const dayKey = toDateKey(new Date(event.start))
  const cacheKey = `synthesis:${block}:${event.id}:${dayKey}:${docs.map((d) => d.id).join(',')}`

  return getOrFetch(cacheKey, TTL.synthesis, async () => {
    const draft = await complete({
      system,
      user: `${describeEvent(event)}\n\nDOCUMENTS\n\n${describeDocuments(docs)}`,
      schema: DRAFT_SCHEMA,
      schemaName: `drill_${block.replace(/-/g, '_')}`,
      model: MODELS.synthesis,
      maxTokens: 700,
    })
    return assemble(draft, docs)
  })
}

/**
 * Turns the model's statements into the block.
 *
 * Tolerant by design: a missing array, a non-string claim or a citation to a document that was
 * never supplied all degrade to less content rather than to an exception, because one block
 * failing must never take the panel with it (PRD §8).
 */
export function assemble(draft: SynthesisDraft | null | undefined, docs: OmniDocument[]): SynthesisResult {
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  const statements: SynthesisStatement[] = []
  const sources: SourceRef[] = []
  const citedIds = new Set<string>()

  for (const raw of draft?.statements ?? []) {
    const text = typeof raw?.text === 'string' ? raw.text.trim() : ''
    if (!text) continue

    const id = typeof raw?.documentId === 'string' ? raw.documentId.trim() : ''
    const doc = id ? byId.get(id) : undefined
    // An unknown id is an invented citation. The claim survives; the citation does not.
    const source = doc ? toSourceRef(doc) : null

    if (doc && !citedIds.has(doc.id)) {
      citedIds.add(doc.id)
      sources.push(toSourceRef(doc))
    }

    statements.push({ text, source, inferred: source === null })
    if (statements.length >= MAX_STATEMENTS) break
  }

  if (statements.length === 0) return emptyResult()

  return {
    prose: statements.map((s) => s.text).join(' '),
    sources,
    inferred: statements.some((s) => s.inferred),
    statements,
    empty: false,
  }
}

// ---------------------------------------------------------------------------
// The two blocks
// ---------------------------------------------------------------------------

/**
 * Block 2 — "two or three sentences on the previous meeting with these people".
 *
 * Feed it the output of `searchByAttendees`. Cached per meeting per day (PRD §15.3).
 * Throws only if the gateway does; the caller renders that as *Could not reach…· Retry*,
 * which is honest, where *Nothing found* would not be.
 */
export async function lastTime(
  event: CalendarEvent,
  omniDocs: OmniInput,
  complete: SynthesisCompleter = defaultCompleter,
): Promise<SynthesisResult> {
  return synthesise('last-time', LAST_TIME_SYSTEM_PROMPT, event, omniDocs, complete)
}

/**
 * Block 5 — "questions left open last time, anything promised and not delivered".
 *
 * The slowest block in the panel and the one most worth waiting for. Same contract as
 * {@link lastTime}.
 */
export async function unresolved(
  event: CalendarEvent,
  omniDocs: OmniInput,
  complete: SynthesisCompleter = defaultCompleter,
): Promise<SynthesisResult> {
  return synthesise('unresolved', UNRESOLVED_SYSTEM_PROMPT, event, omniDocs, complete)
}

// ---------------------------------------------------------------------------
// The issue panel — "What was said"
// ---------------------------------------------------------------------------

function describeIssue(issue: LinearIssue): string {
  return [
    `Task: ${issue.identifier} — ${issue.title}`,
    `State: ${issue.state}${issue.dueDate ? ` | due ${issue.dueDate}` : ''}`,
    issue.labels.length ? `Labels: ${issue.labels.join(', ')}` : null,
    // The description is the extraction's own summary of the task. Handing it over lets
    // the model tell the difference between what the transcript says about this task and
    // what it says about the eleven other things discussed in the same hour.
    withoutProvenance(issue.description) ? `Stated outcome: ${withoutProvenance(issue.description)}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Block 2 of the issue drill-in: what was said about this task, in the meeting it came from.
 *
 * Cached per issue per document set, and keyed on `updatedAt` so editing the task in Linear
 * produces a fresh reading rather than yesterday's.
 *
 * Same contract as {@link lastTime} in every other respect: no documents means
 * {@link emptyResult} and no model call, an unsourceable statement is kept and marked
 * inferred, and a citation to a document that was not supplied loses its citation but
 * keeps its claim.
 */
export async function whatWasSaid(
  issue: LinearIssue,
  input: OmniInput,
  complete: SynthesisCompleter = defaultCompleter,
): Promise<SynthesisResult> {
  const docs = documentsOf(input).slice(0, MAX_DOCUMENTS)
  if (docs.length === 0) return emptyResult()

  const cacheKey = `synthesis:said:${issue.identifier}:${issue.updatedAt}:${docs.map((d) => d.id).join(',')}`

  return getOrFetch(cacheKey, TTL.synthesis, async () => {
    const draft = await complete({
      system: WHAT_WAS_SAID_SYSTEM_PROMPT,
      user: `${describeIssue(issue)}\n\nDOCUMENTS\n\n${describeDocuments(docs)}`,
      schema: DRAFT_SCHEMA,
      schemaName: 'drill_what_was_said',
      model: MODELS.synthesis,
      // A whole transcript goes in, so the answer is allowed a little more room than the
      // meeting panel's blocks — but it is still two or three sentences.
      maxTokens: 900,
    })
    return assemble(draft, docs)
  })
}
