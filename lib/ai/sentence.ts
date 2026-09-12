/**
 * The daily sentence — PRD §4.
 *
 * "The most important component, and the one most likely to be got wrong. It is the
 * difference between a dashboard and something that feels written for you this morning."
 *
 * Three defences, in order:
 *
 *  1. **The prompt** (`lib/ai/prompts.ts`) states the voice contract as prohibitions.
 *  2. **{@link violatesVoice}** re-checks the answer against the same rules in code, because a
 *     prompt is a request and this is a guarantee. One breach buys exactly one retry, with the
 *     breach named back to the model.
 *  3. **{@link deterministicSentence}** is a written-by-hand fallback. A second breach, a
 *     gateway failure, a malformed answer — all land here. PRD §9 is unambiguous that the zone
 *     always renders something honest; silence is never an acceptable rendering.
 *
 * Cached on a hash of the material facts (PRD §15.3), which doubles as the `inputHash` the UI
 * uses to decide whether to animate: same facts, same string, no motion.
 */

import { completeStructured, type CompleteStructuredRequest } from './client'
import { sentenceRetryPrompt, sentenceSystemPrompt } from './prompts'
import { getOrFetch } from '../cache'
import { GRAPH_USER_PRINCIPAL_NAME, MODELS, TIMEZONE, TTL } from '../config'
import { formatDuration, formatTime, sentenceWindow, isWeekend, startOfLocalDay } from '../time'
import type { DashboardModel } from '../view-model'
import type { DailySentence, EntityKind, SentenceEntity, TimelineRow } from '../types'

// ---------------------------------------------------------------------------
// Shape of the model's answer
// ---------------------------------------------------------------------------

export type SentenceWindow = DailySentence['window']

export interface SentenceDraft {
  sentence: string
  entities: Array<{ text: string; kind: string; ref: string }>
}

/** The one AI call this module makes. Injected by the tests; never stubbed in production. */
export type SentenceCompleter = (
  req: CompleteStructuredRequest<SentenceDraft>,
) => Promise<SentenceDraft>

const ENTITY_KINDS: readonly EntityKind[] = ['meeting', 'issue', 'person', 'timerange', 'account']

/**
 * Sent as a raw JSON Schema rather than a zod schema: a malformed answer should fall through
 * to {@link violatesVoice} and the fallback, not throw out of a validator on the way.
 */
const DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    sentence: { type: 'string' },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Exact substring of the sentence.' },
          kind: { type: 'string', enum: ENTITY_KINDS as unknown as string[] },
          ref: { type: 'string', description: 'Id from the facts. Never invented.' },
        },
      },
    },
  },
}

const defaultCompleter: SentenceCompleter = (req) => completeStructured(req)

// ---------------------------------------------------------------------------
// The voice checker — PRD §4, "Rules"
// ---------------------------------------------------------------------------

/** Hard cap from PRD §4. The wall monitor caps at two lines; this is what two lines holds. */
export const MAX_WORDS = 50

/** "Two to three sentences." Only the upper bound is enforced — see {@link violatesVoice}. */
export const MAX_SENTENCES = 3

const GREETING = /\b(good\s+(morning|afternoon|evening|day)|hello|greetings|welcome\s+back)\b/i
const LEADING_GREETING = /^\s*(hi|hey|hello|morning|afternoon|evening)\b\s*[,.!:—-]/i

/** Exported so the list is reviewable rather than buried in a regex. */
export const ENCOURAGEMENT_PATTERNS: readonly RegExp[] = [
  /you'?(ve|’ve)?\s+got\s+this/i,
  /you\s+can\s+do\s+(this|it)/i,
  /let'?(s|’s)\s+(make|have|get|do|go|crush|smash)/i,
  /make\s+it\s+a\s+\w+\s+(one|day)/i,
  /(productive|great|good|strong)\s+day\s+ahead/i,
  /go\s+get\s+(it|them)/i,
  /(crush|smash|nail)\s+it/i,
  /keep\s+(it\s+up|going|pushing)/i,
  /good\s+luck/i,
  /stay\s+(strong|focused|positive)/i,
  /you'?(ve|’ve)?\s+(got|have)\s+a\s+great/i,
  /happy\s+\w+ing/i,
  /!/,
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
]

/** Nouns the reader can literally count in the lists below the sentence. */
const COUNTABLE =
  '(?:meetings?|tasks?|issues?|items?|events?|calls?|appointments?|to-?dos?|tickets?|deadlines?|blocks?)'
const NUMBER = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'
/** "four meetings", "3 open tasks" — up to two adjectives between the number and the noun. */
const COUNT_PAIR = new RegExp(`\\b${NUMBER}\\s+(?:[\\w-]+\\s+){0,2}?${COUNTABLE}\\b`, 'gi')
const YOU_HAVE_N = new RegExp(`\\byou(?:\\s+have|'?(?:ve|’ve)\\s+got|\\s+got)\\s+${NUMBER}\\b`, 'i')

/** Name tokens derived from the single identity (PRD §17.8) — never hard-coded twice. */
export const READER_NAME_TOKENS: readonly string[] = GRAPH_USER_PRINCIPAL_NAME.split('@')[0]
  .split(/[._-]+/)
  .filter((t) => t.length >= 3)

const READER_NAME = new RegExp(`\\b(?:${READER_NAME_TOKENS.join('|')})\\b`, 'i')

export interface VoiceCheckOptions {
  /**
   * Issue identifiers that must not be recommended — the Inbox list (PRD §6). Unvalidated
   * machine output must not be the thing the product tells you to do.
   */
  forbiddenIdentifiers?: readonly string[]
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function countSentences(text: string): number {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean).length
}

/**
 * Which PRD §4 rules a candidate sentence breaks. Empty array means it may ship.
 *
 * Two deliberate calibrations:
 *
 * - **Sentence count** is checked only at the top. PRD §4 says "two to three sentences", but a
 *   single true sentence is a good sentence; padding it to reach a floor is exactly the
 *   behaviour this file exists to prevent.
 * - **Restating counts** fires on the *inventory* construction — two or more count-plus-noun
 *   pairs, or "you have N …" — rather than on any number at all. PRD's own approved examples
 *   contain "Two people are waiting on it" and "Two meetings down"; one count carrying a
 *   judgement is prose, two counts in a row is the dashboard read aloud.
 */
export function violatesVoice(text: string, opts: VoiceCheckOptions = {}): string[] {
  const broken = new Set<string>()
  const candidate = text ?? ''

  if (GREETING.test(candidate) || LEADING_GREETING.test(candidate)) broken.add('greeting')
  if (READER_NAME_TOKENS.length && READER_NAME.test(candidate)) broken.add('name')
  if (ENCOURAGEMENT_PATTERNS.some((p) => p.test(candidate))) broken.add('encouragement')
  if (countWords(candidate) > MAX_WORDS) broken.add('word-count')
  if (countSentences(candidate) > MAX_SENTENCES) broken.add('too-many-sentences')

  const pairs = candidate.match(COUNT_PAIR) ?? []
  if (pairs.length >= 2 || YOU_HAVE_N.test(candidate)) broken.add('restates-counts')

  for (const id of opts.forbiddenIdentifiers ?? []) {
    if (id && new RegExp(`\\b${escapeRegExp(id)}\\b`, 'i').test(candidate)) {
      broken.add('inbox-recommendation')
      break
    }
  }

  return [...broken]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Facts — what the model is allowed to know
// ---------------------------------------------------------------------------

type EventRow = Extract<TimelineRow, { kind: 'event' }>
type GapRow = Extract<TimelineRow, { kind: 'gap' }>

function eventRows(model: DashboardModel): EventRow[] {
  return model.timeline.rows.filter((r): r is EventRow => r.kind === 'event')
}

function gapRows(model: DashboardModel): GapRow[] {
  return model.timeline.rows.filter((r): r is GapRow => r.kind === 'gap')
}

/** Nothing on the calendar at all — PRD §4's fourth register. */
export function isEmptyDay(model: DashboardModel): boolean {
  return eventRows(model).length === 0 && model.timeline.allDay.length === 0
}

/**
 * Which §4 register applies.
 *
 * Every question here is asked of the **day being shown**, not of the clock. On a preview
 * of another date (PRD §17.14) the clock is still ticking through this afternoon, and a
 * sentence that opened "the rest of the afternoon is open" while describing next Monday
 * would be fluent, confident and about the wrong day.
 */
export function windowFor(model: DashboardModel): SentenceWindow {
  const day = model.isToday ? model.now : startOfLocalDay(model.todayKey)
  // The weekend register wins over the clock: on a Saturday, "the afternoon is open"
  // is technically true and completely wrong (PRD §9, weekend / out of office).
  if (isWeekend(day)) return 'weekend'
  if (isEmptyDay(model)) return 'empty'
  // A day you are looking ahead to has no time of day yet. The morning register is the
  // one that describes a day whole rather than from somewhere inside it.
  return model.isToday ? sentenceWindow(model.now) : 'morning'
}

/** Issue identifiers the sentence must never point at (PRD §6, §4). */
export function inboxIdentifiers(model: DashboardModel): string[] {
  return model.planning.filter((i) => i.state === 'Inbox').map((i) => i.identifier)
}

function firstName(name: string | null, email: string): string {
  const source = name?.trim() || email.split('@')[0].replace(/[._-]+/g, ' ')
  return source.split(/\s+/)[0]
}

/**
 * The facts block. Compact on purpose: every line the model reads is a line it might decide
 * to repeat, and PRD §4's failure mode is a sentence that recites its input.
 */
export function describeModel(model: DashboardModel): string {
  const lines: string[] = []
  const events = eventRows(model)
  const forbidden = new Set(inboxIdentifiers(model))

  // A preview is described as the day it is, with no clock at all — handing the model a
  // live time alongside another date is the shortest route to a confidently wrong tense.
  lines.push(
    model.isToday
      ? `Today is ${model.todayKey}. The local time is ${formatTime(model.now)}.`
      : `This is a look ahead to ${model.todayKey}, which is not today. Describe that day as a whole; do not refer to the current time.`,
  )

  if (events.length === 0 && model.timeline.allDay.length === 0) {
    lines.push('CALENDAR: nothing scheduled today.')
  } else {
    lines.push('CALENDAR (id | time | subject | with | state):')
    for (const row of events) {
      const who = row.event.attendees
        .slice(0, 4)
        .map((a) => firstName(a.name, a.email))
        .join(', ')
      const state = row.isNow ? 'happening now' : row.isPast ? 'done' : 'still to come'
      lines.push(
        `- ${row.event.id} | ${formatTime(row.event.start)}-${formatTime(row.event.end)} | ` +
          `${row.event.subject} | ${who || 'no attendees listed'} | ${state}`,
      )
    }
    for (const allDay of model.timeline.allDay) {
      lines.push(`- ${allDay.id} | all day | ${allDay.subject} | (not a meeting, a marker)`)
    }
    lines.push(
      `Booked ${formatDuration(model.timeline.bookedMinutes)}, ` +
        `free ${formatDuration(model.timeline.freeMinutes)}.`,
    )
  }

  const gaps = gapRows(model).filter((g) => g.endMinutes - g.startMinutes >= 45)
  if (gaps.length) {
    lines.push('OPEN BLOCKS (ref | length):')
    for (const gap of gaps) {
      lines.push(
        `- ${clockRange(gap)} | ${formatDuration(gap.endMinutes - gap.startMinutes)}`,
      )
    }
  }

  if (model.ranked.length) {
    lines.push('WORK, ranked, highest first (identifier | state | reason | due):')
    for (const task of model.ranked.slice(0, 5)) {
      lines.push(
        `- ${task.issue.identifier} | ${task.issue.state} | ${task.reason.text} | ` +
          `${task.issue.dueDate ?? 'no due date'} | ${task.issue.title}`,
      )
    }
  }

  if (forbidden.size) {
    lines.push(
      `INBOX - unvalidated, NOT recommendable, listed only so you avoid them: ${[...forbidden].join(', ')}.`,
    )
  }

  if (model.attention.length) {
    lines.push('ALREADY SHOWN IN THE ATTENTION STRIP above you - refer, never explain:')
    for (const item of model.attention) lines.push(`- ${item.text}`)
  }

  const heavy = model.week.filter((d) => d.isHeavy && !d.isToday).map((d) => d.label)
  if (heavy.length) lines.push(`REST OF WEEK: heavily booked on ${heavy.join(', ')}.`)

  lines.push('PEOPLE (email is the ref):')
  const seen = new Set<string>()
  for (const row of events) {
    for (const attendee of row.event.attendees) {
      const key = attendee.email.toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      lines.push(`- ${firstName(attendee.name, attendee.email)} | ${attendee.email}`)
    }
  }
  if (seen.size === 0) lines.pop()

  return lines.join('\n')
}

function clockRange(gap: GapRow): string {
  return `${minutesToClock(gap.startMinutes)}-${minutesToClock(gap.endMinutes)}`
}

function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Input hash — PRD §4, "only animates when the text has actually changed"
// ---------------------------------------------------------------------------

/**
 * FNV-1a over the material facts only.
 *
 * Deliberately *not* over the whole model: `now` advances every second and would defeat both
 * the cache and the animation guard. What changes the sentence is which meetings exist and
 * when, which work is ranked, and what the attention strip says.
 */
export function inputHash(model: DashboardModel): string {
  const material = [
    model.todayKey,
    windowFor(model),
    ...eventRows(model).map((r) => `${r.event.id}@${r.event.start}-${r.event.end}`),
    ...model.timeline.allDay.map((e) => `allday:${e.id}`),
    ...model.ranked.map((t) => `${t.rank}:${t.issue.identifier}:${t.issue.state}`),
    ...model.attention.map((a) => `!${a.text}`),
  ].join('|')

  let hash = 0x811c9dc5
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// The deterministic fallback
// ---------------------------------------------------------------------------

const NUMBER_WORDS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
]

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n)
}

/**
 * The word the sentence uses for the day it is describing.
 *
 * "today" on a preview of next Wednesday is fluent and wrong, and PRD §4's whole point is
 * that this zone reads as written rather than generated — so it names the day instead.
 */
function dayWord(model: DashboardModel): string {
  if (model.isToday) return 'today'
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'long' }).format(
    startOfLocalDay(model.todayKey),
  )
}

function partOfDay(startMinutes: number): string {
  if (startMinutes < 12 * 60) return 'this morning'
  if (startMinutes < 17 * 60) return 'this afternoon'
  return 'this evening'
}

/**
 * Written by hand, assembled from counted facts, and therefore always true.
 *
 * It is the one place allowed to state a count: PRD §4's prohibition is aimed at a model that
 * pads a sentence with the dashboard's own contents instead of judging it. When the model has
 * failed twice, a plain true statement of shape is the honest thing left, and it beats both a
 * blank zone and a sentence that broke the voice.
 */
export function deterministicSentence(
  model: DashboardModel,
  window: SentenceWindow = windowFor(model),
): { text: string; entities: SentenceEntity[] } {
  const entities: SentenceEntity[] = []
  const top = model.ranked.find((t) => t.issue.state !== 'Inbox')
  const tail = top ? ` ${top.issue.identifier} is the one that matters.` : ''
  if (top) {
    entities.push({ text: top.issue.identifier, kind: 'issue', ref: top.issue.identifier })
  }

  if (window === 'weekend') {
    const head = model.due.length
      ? 'It is the weekend. Nothing here is owed until Monday.'
      : 'It is the weekend.'
    return { text: head + tail, entities }
  }

  if (window === 'empty') {
    const day = dayWord(model)
    const head = model.week.some((d) => d.isHeavy && !d.isToday)
      ? `Nothing on the calendar ${day}, and the rest of the week is where the load sits.`
      : `Nothing on the calendar ${day}.`
    return { text: head + tail, entities }
  }

  const events = eventRows(model)
  const remaining = events.filter((r) => !r.isPast)
  const longest = gapRows(model)
    .filter((g) => g.endMinutes - g.startMinutes >= 45)
    .sort((a, b) => b.endMinutes - b.startMinutes - (a.endMinutes - a.startMinutes))[0]

  if (window === 'evening' && remaining.length === 0) {
    return { text: `The calendar is done for today.${tail}`, entities }
  }

  const count = window === 'morning' ? events.length : remaining.length
  const noun = count === 1 ? 'meeting' : 'meetings'
  // "left today" only makes sense from inside the day; a preview gets the plain name.
  const when = window === 'morning' ? dayWord(model) : `left ${dayWord(model)}`
  const block = longest
    ? `, and ${formatDuration(longest.endMinutes - longest.startMinutes)} clear ${partOfDay(longest.startMinutes)}`
    : ''

  return { text: `${numberWord(count)} ${noun} ${when}${block}.${tail}`, entities }
}

// ---------------------------------------------------------------------------
// Entity validation
// ---------------------------------------------------------------------------

/**
 * Keeps only entities the interface can actually render.
 *
 * An entity whose `text` is not in the sentence produces a link over nothing — the UI would
 * either drop it silently or, worse, highlight the wrong span. Dropping the entity costs one
 * underline; shipping it costs the reader's trust in every underline.
 */
export function validateEntities(
  sentence: string,
  raw: SentenceDraft['entities'] | undefined,
  forbidden: readonly string[] = [],
): SentenceEntity[] {
  const blocked = new Set(forbidden.map((f) => f.toLowerCase()))
  const seen = new Set<string>()
  const out: SentenceEntity[] = []

  for (const entity of raw ?? []) {
    const text = typeof entity?.text === 'string' ? entity.text.trim() : ''
    const ref = typeof entity?.ref === 'string' ? entity.ref.trim() : ''
    if (!text || !ref) continue
    if (!sentence.includes(text)) continue
    if (blocked.has(ref.toLowerCase())) continue
    const kind = (ENTITY_KINDS as readonly string[]).includes(entity.kind)
      ? (entity.kind as EntityKind)
      : null
    if (!kind) continue
    const key = `${text}|${kind}|${ref}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ text, kind, ref })
  }

  return out
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * The sentence for this dashboard, cached on {@link inputHash} for {@link TTL.sentence}.
 *
 * Never throws and never returns an empty string. The AI call is the last parameter so the
 * tests can pass a fake; production callers pass nothing.
 */
export async function generateSentence(
  model: DashboardModel,
  complete: SentenceCompleter = defaultCompleter,
): Promise<DailySentence> {
  const window = windowFor(model)
  const hash = inputHash(model)

  return getOrFetch(`sentence:${model.todayKey}:${window}:${hash}`, TTL.sentence, async () => {
    const forbidden = inboxIdentifiers(model)
    const facts = describeModel(model)
    const system = sentenceSystemPrompt(window)

    const attempt = async (user: string): Promise<SentenceDraft | null> => {
      try {
        return await complete({
          system,
          user,
          schema: DRAFT_SCHEMA,
          schemaName: 'daily_sentence',
          model: MODELS.sentence,
          maxTokens: 400,
        })
      } catch {
        // A gateway fault is not a voice problem; it goes straight to the fallback.
        return null
      }
    }

    const fallback = () => {
      const written = deterministicSentence(model, window)
      return finish(written.text, written.entities, window, hash, model.now)
    }

    let draft = await attempt(facts)
    // A transport fault is not a voice problem: retrying the prompt cannot fix it, and
    // `postChat` has already retried the request itself.
    if (!draft) return fallback()

    let text = draft.sentence?.trim() ?? ''
    let violations = text ? violatesVoice(text, { forbiddenIdentifiers: forbidden }) : ['empty']

    if (violations.length) {
      // Exactly one retry, with the breach named back (PRD §4 is a contract, not a preference).
      const retry = await attempt(`${facts}\n\n${sentenceRetryPrompt(text, violations)}`)
      if (!retry) return fallback()
      draft = retry
      text = retry.sentence?.trim() ?? ''
      violations = text ? violatesVoice(text, { forbiddenIdentifiers: forbidden }) : ['empty']
    }

    if (violations.length) return fallback()

    return finish(text, validateEntities(text, draft.entities, forbidden), window, hash, model.now)
  })
}

function finish(
  text: string,
  entities: SentenceEntity[],
  window: SentenceWindow,
  hash: string,
  now: Date,
): DailySentence {
  return { text, entities, window, generatedAt: now.toISOString(), inputHash: hash }
}
