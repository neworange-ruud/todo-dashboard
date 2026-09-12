/**
 * Omni client — PRD §12.3, §15.1 path C.
 *
 * Omni is the local context platform that aggregates Outlook mail, Fireflies transcripts,
 * files/notes and Slack behind one retrieval API. It fronts Docker on loopback via Caddy
 * (`OMNI_BASE_URL`, default `http://127.0.0.1:41435`).
 *
 * Verified on this machine (12 Sep 2026, **with a working key**):
 *   - `GET  /api/v1/health`         → 200, unauthenticated, per-service status.
 *   - `POST /api/v1/search`         → 200. Indexed: ~1520 outlook, 831 outlook_calendar,
 *                                     795 jira, 609 fireflies, 96 confluence, 9 slack.
 *   - `GET  /api/v1/documents/{id}` → 200, and it carries the **whole body** in `content`
 *                                     for documents up to roughly 100KB. Above that
 *                                     `content` comes back null and search highlights are
 *                                     the only text available — see {@link fetchDocument}.
 *
 * `OMNI_API_KEY` stays optional and is read straight from the environment rather than
 * through `getEnv()` (which fails fast on missing *required* keys): the product must keep
 * working on a machine without it. Without the key every authenticated call returns
 * `{ ok: false, reason: 'unconfigured' }` and the affected block renders
 * *Could not reach Omni · Retry* — PRD §8: "one block failing never blocks the others".
 *
 * Nothing here throws into a page. Every exported function returns a discriminated result.
 *
 * The request and response shapes are taken from the New Orange MCP adapter
 * (`neworange-context-platform`, ADR 0003), which already talks to this instance:
 *   request  { query, source_types[], content_types[], attribute_filters{}, mode, limit, offset }
 *   response { results: [{ document, score, match_type, highlights[], source_type }],
 *              total_count, has_more, query_time_ms, query, facets, active_filters }
 * The tolerant parsing below is kept as belt-and-braces for additive upstream
 * changes — Omni's own models are declared `extra="allow"`. Still unverified: the
 * `source_type` vocabulary. Parsing is deliberately tolerant — see {@link toDocument} and
 * {@link extractList} — so a shape we guessed slightly wrong degrades to fewer fields
 * rather than a crash. The auth scheme is `Authorization: Bearer <key>`; if Omni turns out
 * to want `X-API-Key`, that is a one-line change in {@link authHeaders}.
 */

import { OMNI_BASE_URL, TTL } from '../config'
import { getOrFetch } from '../cache'
import type { OmniDocument } from '../types'

// ---------------------------------------------------------------------------
// Result type — PRD §8
// ---------------------------------------------------------------------------

export type OmniFailureReason =
  /** No `OMNI_API_KEY` in the environment. Not an error; the feature is simply off. */
  | 'unconfigured'
  /** The request never got an answer — Omni down, connection refused, timed out. */
  | 'unreachable'
  /** Omni answered, but not with what we asked for — 401, 500, unparseable body. */
  | 'error'

export interface OmniFailure {
  ok: false
  reason: OmniFailureReason
  /** Safe to render. Never contains the API key. */
  message: string
}

export type OmniSearchResult = { ok: true; documents: OmniDocument[] } | OmniFailure
export type OmniDocumentResult = { ok: true; document: OmniDocument } | OmniFailure
export type OmniHealthResult = { ok: true; health: OmniHealth } | OmniFailure

export interface OmniHealth {
  /** Omni's own word for it — typically `"healthy"`. */
  status: string
  /** `postgres`, `redis`, `searcher`, `indexer`, `connector_manager` → `"ok"` etc. */
  services: Record<string, string>
}

/**
 * Best-known `attributes.source_type` values (PRD §15.5 confirms `outlook_calendar`).
 * The rest are inferred from the running connector set and should be re-checked once
 * we can list real documents.
 */
/**
 * Omni's supported `source_types`, taken from the New Orange MCP adapter's own
 * allowlist (`neworange-context-platform`, ADR 0003) — the reference implementation
 * that already talks to this instance. These are names, not guesses.
 *
 * OneDrive, SharePoint, Teams and the legacy vault are deliberately absent upstream.
 */
export const SOURCE_TYPES = {
  calendar: 'outlook_calendar',
  mail: 'outlook',
  transcript: 'fireflies',
  slack: 'slack',
  file: 'local_files',
  github: 'github',
  confluence: 'confluence',
  jira: 'jira',
  brain: 'brain',
} as const

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface OmniDeps {
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Per-request timeout. */
  timeoutMs?: number
}

/** How long we wait on a local service before calling it unreachable. */
const DEFAULT_TIMEOUT_MS = 10_000

/** Snippets are capped so a ten-document search cannot blow the synthesis prompt budget. */
const SNIPPET_MAX = 1_200

/**
 * A whole document is allowed far more room than a search snippet.
 *
 * One transcript read in full is the input to *What was said*, and a meeting of any length
 * runs to tens of thousands of characters. This is the ceiling on a single body, not on a
 * batch of them — {@link fetchDocument} is only ever called for documents a task actually
 * points at.
 */
export const CONTENT_MAX = 40_000

/** Whether the optional Omni credential is present. */
export function isConfigured(): boolean {
  return Boolean(process.env.OMNI_API_KEY)
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

class OmniRequestError extends Error {
  constructor(
    readonly reason: OmniFailureReason,
    message: string,
    /** The HTTP status, when there was one. Read by the retry rule, never rendered. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OmniRequestError'
  }
}

function authHeaders(): Record<string, string> {
  const key = process.env.OMNI_API_KEY
  return key ? { Authorization: `Bearer ${key}` } : {}
}

function unconfigured(): OmniFailure {
  return {
    ok: false,
    reason: 'unconfigured',
    message: 'Omni is not configured — set OMNI_API_KEY in .env.',
  }
}

function toFailure(err: unknown): OmniFailure {
  if (err instanceof OmniRequestError) {
    return { ok: false, reason: err.reason, message: err.message }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, reason: 'error', message: `Omni request failed: ${message}` }
}

/**
 * Statuses worth trying again.
 *
 * Omni's search service intermittently answers **502** and **429** under load — a burst of
 * eight identical searches returns 200 eight times, and then the same request 502s a minute
 * later. The panel handled this correctly (*Could not reach Omni · Retry*) and the retry
 * always worked, which is the definition of a failure the reader should never have been
 * shown. Retrying here removes it rather than delegating it to the reader's patience.
 *
 * 401 and 404 are absent on purpose: they are answers, not weather.
 */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])

/** Two retries, ~250ms then ~500ms. Enough for a service blip, short of a stall. */
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 250

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One Omni call, retried through transient failures. Throws {@link OmniRequestError};
 * callers convert to a result.
 *
 * A retried request is still contained: after the last attempt the error is the one the
 * block renders, so an Omni that is genuinely down still reads as down rather than hanging.
 */
async function request(
  path: string,
  init: RequestInit,
  deps: OmniDeps,
  authenticate = true,
): Promise<unknown> {
  let last: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptRequest(path, init, deps, authenticate)
    } catch (err) {
      last = err
      const retryable =
        err instanceof OmniRequestError &&
        (err.reason === 'unreachable' || RETRY_STATUSES.has(err.status ?? 0))
      if (!retryable || attempt === MAX_ATTEMPTS) throw err
      await sleep(RETRY_BASE_MS * attempt)
    }
  }
  throw last
}

/**
 * A single attempt.
 *
 * `authenticate: false` is used by {@link health}, which Omni serves without a key.
 */
async function attemptRequest(
  path: string,
  init: RequestInit,
  deps: OmniDeps,
  authenticate = true,
): Promise<unknown> {
  const doFetch = deps.fetch ?? (globalThis.fetch as FetchLike)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let res: Response
  try {
    res = await doFetch(`${OMNI_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(authenticate ? authHeaders() : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new OmniRequestError(
      'unreachable',
      `Could not reach Omni at ${OMNI_BASE_URL}: ${message}`,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new OmniRequestError(
      'error',
      `Omni ${path} returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
      res.status,
    )
  }

  try {
    return await res.json()
  } catch {
    throw new OmniRequestError('error', `Omni ${path} returned a body that is not JSON`)
  }
}

// ---------------------------------------------------------------------------
// Response mapping — tolerant by design (see the file header)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

/** Finds the document array wherever Omni chose to put it. */
function extractList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const root = asRecord(payload)
  for (const key of ['results', 'documents', 'hits', 'items', 'data']) {
    const value = root[key]
    if (Array.isArray(value)) return value
  }
  // Some envelopes nest one level: { data: { results: [...] } }
  const nested = asRecord(root.data)
  for (const key of ['results', 'documents', 'hits', 'items']) {
    const value = nested[key]
    if (Array.isArray(value)) return value
  }
  return []
}

/** Joined with a separator that survives being read aloud in a prompt. */
function joinHighlights(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const parts = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  return parts.length ? parts.join('\n\n…\n\n') : null
}

/** Email addresses out of whatever shape Omni recorded them in. */
function toParticipants(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue
    const out = value.filter((v): v is string => typeof v === 'string' && v.includes('@'))
    if (out.length) return out
  }
  return undefined
}

/**
 * Maps one raw hit onto {@link OmniDocument}, or null when it carries no usable id.
 *
 * Two corrections verified against the live instance (12 Sep 2026), both of which failed
 * silently rather than loudly:
 *
 *  1. **Text arrives as `highlights`, an array on the hit.** Nothing Omni returns is
 *     called `snippet`, `excerpt` or `text`, so every document reaching the synthesiser
 *     carried `content: (none indexed)` and both prose blocks were being written from
 *     titles alone. That is the difference between "Last time" saying something and
 *     "Last time" saying something plausible.
 *  2. **`attributes` is empty on every document.** The real metadata — author, the
 *     document's own date, the Fireflies participant list, the Graph event id — lives
 *     under `metadata` and `metadata.extra.<connector>`. The attribute lookups are kept
 *     below only as a fallback, in case the field is ever populated upstream.
 */
export function toDocument(raw: unknown, maxChars: number = SNIPPET_MAX): OmniDocument | null {
  const row = asRecord(raw)
  // A search hit wraps the record: { document, score, match_type, highlights, source_type }.
  const wrapped = Object.keys(row).length > 0 && row.document !== undefined
  const source = wrapped ? asRecord(row.document) : row
  const attributes = asRecord(source.attributes)
  const metadata = asRecord(source.metadata)
  const extra = asRecord(metadata.extra)
  // VERIFIED: Omni puts `source_type` on the HIT, not inside the document — reading only
  // the document leaves almost every result typed "unknown", which silently disables
  // anything keyed on source (series collapse, per-source labelling).
  const hitSourceType = wrapped ? row.source_type : undefined

  const id = firstString(source.id, source.document_id, source.documentId, source.external_id)
  if (!id) return null

  const snippet =
    firstString(source.content, row.snippet, row.highlight) ??
    joinHighlights(row.highlights) ??
    firstString(source.snippet, source.excerpt, source.text) ??
    ''

  const sourceType =
    firstString(
      hitSourceType,
      source.sourceType,
      source.source_type,
      attributes.source_type,
      attributes.sourceType,
      source.source,
    ) ?? 'unknown'

  /*
   * Connector extras are shaped **two different ways**, verified live on 12 Sep 2026:
   *
   *   fireflies        → metadata.extra.fireflies.{ participants, transcript_url, … }
   *   outlook_calendar → metadata.extra.{ event_id, is_all_day, is_cancelled }
   *
   * Reading only the nested form left `eventId` null on every calendar document, which
   * silently cost the issue panel its best affordance: `event_id` is the Graph event id
   * verbatim (both are base64url — the `_` that looks like mangling is not), so a calendar
   * document is openable as a real meeting drill-in rather than as a line of text.
   */
  const connector = { ...extra, ...asRecord(extra[sourceType]) }

  return {
    id,
    title: firstString(source.title, metadata.title) ?? '(untitled)',
    url: firstString(source.url, metadata.url, connector.transcript_url),
    snippet: snippet.length > maxChars ? `${snippet.slice(0, maxChars)}…` : snippet,
    sourceType,
    date: firstString(
      source.date,
      attributes.date,
      // `metadata.created_at` is when the meeting happened or the mail was sent; the
      // document's own `created_at` is when Omni indexed it, which is a different fact
      // and nearly always today.
      metadata.created_at,
      source.created_at,
      source.createdAt,
    ),
    ...(firstString(source.content_type, metadata.content_type)
      ? { contentType: firstString(source.content_type, metadata.content_type)! }
      : {}),
    ...(toParticipants(connector.participants, connector.attendees, metadata.participants)
      ? { participants: toParticipants(connector.participants, connector.attendees, metadata.participants) }
      : {}),
    ...(firstString(connector.event_id) ? { eventId: firstString(connector.event_id)! } : {}),
  }
}

function mapDocuments(payload: unknown): OmniDocument[] {
  return extractList(payload)
    // Called with an arrow, not passed by reference: `.map` would hand `toDocument` the
    // element index as its second argument, which is the character budget.
    .map((raw) => toDocument(raw))
    .filter((doc): doc is OmniDocument => doc !== null)
}

/** Milliseconds for sorting. Undated documents sort last. */
function dateValue(doc: OmniDocument): number {
  if (!doc.date) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(doc.date)
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Liveness probe. Unauthenticated, so this works before we have a key and is the honest
 * input to the sync marker (PRD §9) when everything else reports `unconfigured`.
 *
 * Not cached — it is the thing you call precisely when you doubt the cache.
 */
export async function health(deps: OmniDeps = {}): Promise<OmniHealthResult> {
  try {
    const payload = await request('/api/v1/health', { method: 'GET' }, deps, false)
    const root = asRecord(payload)
    const rawServices = asRecord(root.services ?? root.checks ?? root.components)
    const services: Record<string, string> = {}
    for (const [name, value] of Object.entries(rawServices)) {
      services[name] =
        typeof value === 'string' ? value : (firstString(asRecord(value).status) ?? 'unknown')
    }
    return {
      ok: true,
      health: { status: firstString(root.status, root.state) ?? 'unknown', services },
    }
  } catch (err) {
    return toFailure(err)
  }
}

export type SearchMode = 'fulltext' | 'semantic' | 'hybrid'

export interface OmniSearchParams {
  query: string
  /** Filter on source. See {@link SOURCE_TYPES}. */
  sourceTypes?: string[]
  contentTypes?: string[]
  /**
   * Structured filters over a document's `attributes` JSONB.
   *
   * VERIFIED CONSTRAINT: Omni accepts **exact scalar match only** — `{ date: '2026-09-11' }`.
   * A range object (`{ date: { gte: … } }`) or an array (`{ date: ['…'] }`) does not 400;
   * it takes the search service down with a **502**, which is indistinguishable from Omni
   * being unreachable. Never construct one. Narrow by date client-side instead — see
   * {@link withinDays}.
   */
  attributeFilters?: Record<string, string | number | boolean>
  mode?: SearchMode
  /** 1–100. Omni rejects anything outside that range. */
  limit?: number
  offset?: number
}

/** Omni's limit is a hard 1–100 (ADR 0003 / the adapter's SearchRequest model). */
export const MAX_LIMIT = 100

function searchBody(params: OmniSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: params.query,
    mode: params.mode ?? 'hybrid',
    limit: Math.min(Math.max(params.limit ?? 10, 1), MAX_LIMIT),
    offset: params.offset ?? 0,
  }
  if (params.sourceTypes?.length) body.source_types = [...params.sourceTypes].sort()
  if (params.contentTypes?.length) body.content_types = [...params.contentTypes].sort()
  if (params.attributeFilters) body.attribute_filters = params.attributeFilters
  return body
}

/**
 * Omni accepts an empty query only when a filter narrows it. Sending one without
 * either is a 4xx, so we catch it here rather than burning a round trip.
 */
export function isSearchable(params: OmniSearchParams): boolean {
  return (
    params.query.trim().length > 0 ||
    Boolean(params.sourceTypes?.length) ||
    params.attributeFilters !== undefined
  )
}

/**
 * Retrieval over everything that is neither Linear nor Calendar (PRD §15.1 path C).
 *
 * Successes are cached for {@link TTL.omni}; failures are not, so *Retry* actually retries.
 * A failure with a warm entry still returns the last good documents — `getOrFetch` keeps the
 * stale value rather than blanking the block (PRD §9, "never lie about state").
 */
export async function search(
  params: OmniSearchParams,
  deps: OmniDeps = {},
): Promise<OmniSearchResult> {
  if (!isConfigured()) return unconfigured()
  if (!isSearchable(params)) return { ok: true, documents: [] }
  const body = searchBody(params)
  try {
    const documents = await getOrFetch(`omni:search:${JSON.stringify(body)}`, TTL.omni, async () =>
      mapDocuments(
        await request('/api/v1/search', { method: 'POST', body: JSON.stringify(body) }, deps),
      ),
    )
    return { ok: true, documents }
  } catch (err) {
    return toFailure(err)
  }
}

/** One document by Omni id — the target of a `↗ source` affordance (PRD §8). */
export async function getDocument(
  id: string,
  deps: OmniDeps = {},
): Promise<OmniDocumentResult> {
  if (!isConfigured()) return unconfigured()
  try {
    const document = await getOrFetch(`omni:doc:${id}`, TTL.omni, async () => {
      const payload = await request(
        `/api/v1/documents/${encodeURIComponent(id)}`,
        { method: 'GET' },
        deps,
      )
      const root = asRecord(payload)
      const doc = toDocument(root.document ?? root.data ?? payload)
      if (!doc) throw new OmniRequestError('error', `Omni returned no usable document for ${id}`)
      return doc
    })
    return { ok: true, document }
  } catch (err) {
    return toFailure(err)
  }
}

/**
 * One document, read in full.
 *
 * This is the retrieval that makes a task's *What was said* block possible: a Linear
 * description points at exactly one Omni document (see `lib/domain/provenance.ts`), and
 * this fetches its whole transcript rather than a query-shaped excerpt of it.
 *
 * **`content` can legitimately be null.** Omni returns it for documents up to roughly
 * 100KB and omits it above that; a two-hour transcript is one of the documents most worth
 * reading and one of the most likely to exceed it. The caller is told which it got through
 * `snippet` simply being empty, and falls back to a search — never to a failure, and never
 * to an empty block presented as "nothing found".
 */
export async function fetchDocument(
  id: string,
  deps: OmniDeps = {},
): Promise<OmniDocumentResult> {
  if (!isConfigured()) return unconfigured()
  try {
    const document = await getOrFetch(`omni:content:${id}`, TTL.omni, async () => {
      const payload = await request(
        `/api/v1/documents/${encodeURIComponent(id)}?include_content=true`,
        { method: 'GET' },
        deps,
      )
      const root = asRecord(payload)
      const doc = toDocument(root.document ?? root.data ?? payload, CONTENT_MAX)
      if (!doc) throw new OmniRequestError('error', `Omni returned no usable document for ${id}`)
      return doc
    })
    return { ok: true, document }
  } catch (err) {
    return toFailure(err)
  }
}

export interface AttendeeSearchOptions {
  /**
   * Subject or topic words for the second pass. Round-2 answer 6: attendee overlap alone
   * misses "we last spoke about this in a *different* meeting", so the topic gets its own
   * sweep over recent transcripts.
   */
  keywords?: string
  /** Cap on the combined, deduped result. Also the per-pass request limit. */
  limit?: number
  /** ISO lower bound for both passes. Defaults to {@link DEFAULT_LOOKBACK_DAYS} ago. */
  since?: string
  /** Overrides the attendee pass's source filter. */
  sourceTypes?: string[]
}

/** How far back "last time" looks when the caller does not say. */
export const DEFAULT_LOOKBACK_DAYS = 120

/**
 * Input to the "Last time" block (PRD §8, block 2): what happened previously with these
 * people, on this subject.
 *
 * Two passes, combined:
 *   1. **Attendees** — mail, calendar and transcripts mentioning these addresses.
 *   2. **Keywords** — the meeting's own topic across recent transcripts, regardless of who
 *      was in the room (round-2 answer 6).
 *
 * Deduped by document id, most recent first. If one pass fails and the other succeeds the
 * partial result is returned — a half-full block beats an empty one. Only when both passes
 * fail does this report a failure.
 */
export async function searchByAttendees(
  emails: string[],
  opts: AttendeeSearchOptions = {},
  deps: OmniDeps = {},
): Promise<OmniSearchResult> {
  if (!isConfigured()) return unconfigured()

  const limit = opts.limit ?? 12
  const since = opts.since ?? defaultSince()
  const addresses = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]

  const passes: Promise<OmniSearchResult>[] = []

  if (addresses.length) {
    passes.push(
      search(
        {
          query: addresses.join(' '),
          sourceTypes: opts.sourceTypes ?? [
            SOURCE_TYPES.mail,
            SOURCE_TYPES.calendar,
            SOURCE_TYPES.transcript,
          ],
          limit,
        },
        deps,
      ),
    )
  }

  if (opts.keywords?.trim()) {
    passes.push(
      search(
        {
          query: opts.keywords.trim(),
          sourceTypes: [SOURCE_TYPES.transcript],
          limit,
        },
        deps,
      ),
    )
  }

  if (!passes.length) return { ok: true, documents: [] }

  const results = await Promise.all(passes)
  const succeeded = results.filter((r): r is { ok: true; documents: OmniDocument[] } => r.ok)
  if (!succeeded.length) {
    // Every pass failed; surface the first reason rather than inventing a new one.
    return results[0] as OmniFailure
  }

  const byId = new Map<string, OmniDocument>()
  for (const result of succeeded) {
    for (const doc of result.documents) {
      if (!byId.has(doc.id)) byId.set(doc.id, doc)
    }
  }

  // Narrow by date HERE, not in the request: Omni's attribute_filters are exact-match
  // only, and a range filter 502s the search service (see OmniSearchParams). Undated
  // documents are kept — dropping them would silently hide anything Omni did not stamp.
  const documents = collapseSeries(
    [...byId.values()].filter((doc) => withinDays(doc, since)).sort((a, b) => dateValue(b) - dateValue(a)),
  ).slice(0, limit)
  return { ok: true, documents }
}

/**
 * Collapses recurring-meeting instances to their most recent occurrence.
 *
 * A weekly sync indexes as one document per occurrence, so an attendee search returns
 * the same title four or five times. Feeding those to the synthesis wastes the context
 * budget on near-duplicates and pushes genuinely different material out of the prompt —
 * and "Last time" only ever wants the latest one anyway.
 *
 * Input must already be sorted newest-first; the first occurrence seen is kept.
 */
export function collapseSeries(docs: OmniDocument[]): OmniDocument[] {
  const seen = new Set<string>()
  const out: OmniDocument[] = []
  for (const doc of docs) {
    const key = `${doc.sourceType}::${doc.title.trim().toLowerCase()}`
    // Only calendar and transcript entries recur; mail with a repeated subject is a
    // real thread and each message may say something different.
    const recurring = doc.sourceType === SOURCE_TYPES.calendar || doc.sourceType === SOURCE_TYPES.transcript
    if (recurring && doc.title.trim()) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(doc)
  }
  return out
}

/** Whether a document is dated on or after `since` (`YYYY-MM-DD`). Undated passes. */
export function withinDays(doc: OmniDocument, since: string): boolean {
  if (!doc.date) return true
  const value = dateValue(doc)
  if (!Number.isFinite(value) || value === 0) return true
  return value >= Date.parse(since)
}

function defaultSince(): string {
  const d = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}
