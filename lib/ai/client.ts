/**
 * AI gateway client — PRD §12.4.
 *
 * OpenAI-compatible chat completions through a user-supplied gateway. Verified working
 * against this deployment:
 *
 *   - `AI_API_URL` already ends in `/v1`, so the endpoint is `${AI_API_URL}/chat/completions`.
 *   - `Authorization: Bearer ${AI_API_KEY}` + `Content-Type: application/json`.
 *   - `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`
 *     works and returns the JSON as a string in `choices[0].message.content`.
 *   - Typical latency ~3s.
 *
 * Used for the daily sentence (§4) and the synthesised drill-in blocks (§8).
 *
 * SECURITY: the API key is never logged and never reaches an error message. Every message
 * this module throws goes through {@link redact} first — `lib/ai/client.test.ts` asserts it.
 */

import { toJSONSchema } from 'zod'

import { getEnv, MODELS, SENTENCE_LOCALE } from '../config'

// ---------------------------------------------------------------------------
// Locale — PRD §4
// ---------------------------------------------------------------------------

/**
 * Prepended to *every* system prompt this module sends.
 *
 * This is not decoration. The source material — Outlook mail, Fireflies transcripts, Slack —
 * is largely Dutch, and the model will answer in Dutch if left to follow its input. PRD §4's
 * voice specification is written in English, and `SENTENCE_LOCALE` pins the output language
 * explicitly rather than letting the data decide.
 */
export const LOCALE_INSTRUCTION: string =
  SENTENCE_LOCALE === 'nl'
    ? 'Schrijf je volledige antwoord in het Nederlands. Het bronmateriaal is deels Engels: ' +
      'vertaal wat je citeert of parafraseert naar het Nederlands. Laat eigennamen — mensen, ' +
      'bedrijven, vergadertitels, issue-identifiers zoals RW-214 — exact staan zoals ze zijn ' +
      'geschreven. Antwoord nooit in het Engels.'
    : 'Write your entire answer in English. The source material — mail, meeting transcripts, ' +
      'Slack — is largely Dutch: translate anything you quote or paraphrase into English ' +
      'rather than echoing the source language. Leave proper nouns — people, companies, ' +
      'meeting titles, issue identifiers such as RW-214 — exactly as written. Never answer ' +
      'in Dutch.'

/** Every system prompt is the locale rule plus the caller's instructions. */
function buildSystemPrompt(system: string): string {
  return `${LOCALE_INSTRUCTION}\n\n${system.trim()}`
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface AiDeps {
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Overrides `AI_API_KEY`. Tests pass this so they never touch `getEnv()`. */
  apiKey?: string
  /** Overrides `AI_API_URL`. Must already end in `/v1`. */
  baseUrl?: string
  /** Defaults to {@link TIMEOUT_MS}. */
  timeoutMs?: number
}

/** Generous: synthesis over a fat context is slow, and a truncated answer is worse than a wait. */
export const TIMEOUT_MS = 60_000

/** One retry, so exactly two attempts. */
const MAX_ATTEMPTS = 2

export class AiError extends Error {
  constructor(
    message: string,
    /** HTTP status when the gateway answered, else undefined. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

function credentials(deps: AiDeps): { apiKey: string; baseUrl: string } {
  if (deps.apiKey && deps.baseUrl) return { apiKey: deps.apiKey, baseUrl: deps.baseUrl }
  const env = getEnv()
  return { apiKey: deps.apiKey ?? env.AI_API_KEY, baseUrl: deps.baseUrl ?? env.AI_API_URL }
}

/**
 * Strips the credential out of anything we are about to surface.
 *
 * Gateways sometimes echo the presented token back in a 4xx body, so this runs over every
 * message built from a response, not only over messages we compose ourselves.
 */
function redact(message: string, apiKey: string): string {
  if (!apiKey) return message
  return message.split(apiKey).join('«redacted»')
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

interface ChatRequest {
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  max_completion_tokens?: number
  response_format?: {
    type: 'json_schema'
    json_schema: { name: string; strict: true; schema: Record<string, unknown> }
  }
}

/** POSTs one chat completion. Retries once on a 5xx or a network fault; never on a 4xx. */
async function postChat(body: ChatRequest, deps: AiDeps): Promise<unknown> {
  const { apiKey, baseUrl } = credentials(deps)
  const doFetch = deps.fetch ?? (globalThis.fetch as FetchLike)
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  const fail = (message: string, status?: number) => new AiError(redact(message, apiKey), status)

  let lastError: AiError | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS)

    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      const aborted = controller.signal.aborted
      const detail = err instanceof Error ? err.message : String(err)
      lastError = fail(
        aborted
          ? `AI gateway did not answer within ${deps.timeoutMs ?? TIMEOUT_MS}ms`
          : `AI gateway request failed: ${detail}`,
      )
      // A timeout has already spent the budget; retrying only doubles the wait.
      if (aborted || attempt === MAX_ATTEMPTS) throw lastError
      continue
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 500) {
      lastError = fail(`AI gateway returned ${res.status}`, res.status)
      if (attempt === MAX_ATTEMPTS) throw lastError
      continue
    }

    if (!res.ok) {
      // 4xx is a request problem: bad key, bad model, bad schema. Retrying repeats the mistake.
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* body already consumed or unreadable — the status is enough */
      }
      throw fail(
        `AI gateway returned ${res.status}${detail ? `: ${truncate(detail)}` : ''}`,
        res.status,
      )
    }

    try {
      return await res.json()
    } catch {
      throw fail('AI gateway returned a body that is not JSON')
    }
  }

  throw lastError ?? fail('AI gateway request failed')
}

function messageContent(payload: unknown, apiKey: string): string {
  const choices = (payload as { choices?: unknown })?.choices
  const first = Array.isArray(choices) ? choices[0] : undefined
  const content = (first as { message?: { content?: unknown } })?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new AiError(redact('AI gateway returned no message content', apiKey))
  }
  return content
}

// ---------------------------------------------------------------------------
// Free-text completion
// ---------------------------------------------------------------------------

export interface CompleteRequest {
  /** Task instructions. {@link LOCALE_INSTRUCTION} is prepended automatically. */
  system: string
  user: string
  /** Defaults to {@link MODELS.synthesis}. Pass `MODELS.sentence` for the daily sentence. */
  model?: string
  maxTokens?: number
}

/** One completion, returned as the raw assistant string. */
export async function complete(req: CompleteRequest, deps: AiDeps = {}): Promise<string> {
  const { apiKey } = credentials(deps)
  const payload = await postChat(
    {
      model: req.model ?? MODELS.synthesis,
      messages: [
        { role: 'system', content: buildSystemPrompt(req.system) },
        { role: 'user', content: req.user },
      ],
      ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
    },
    deps,
  )
  return messageContent(payload, apiKey)
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/** Anything with a zod-shaped `safeParse`. Kept structural so zod stays a runtime detail. */
interface ParserLike<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }
}

function isParser<T>(schema: unknown): schema is ParserLike<T> {
  return typeof (schema as ParserLike<T> | null)?.safeParse === 'function'
}

/**
 * Schema accepted by {@link completeStructured}.
 *
 * Either **a zod schema** — converted with `z.toJSONSchema` and then used a second time to
 * validate the parsed response, so the `T` you get back is checked and not merely asserted —
 * or **a raw JSON Schema object**, which is sent as-is and returned unvalidated.
 *
 * For zod schemas prefer `.nullable()` over `.optional()`: OpenAI's `strict: true` mode
 * requires every property to appear in `required`, so {@link toStrictJsonSchema} marks them
 * all required and an optional field would simply come back as `null` anyway.
 */
export type StructuredSchema<T> = ParserLike<T> | Record<string, unknown>

export interface CompleteStructuredRequest<T> {
  system: string
  user: string
  schema: StructuredSchema<T>
  /** `^[A-Za-z0-9_-]+$`; other characters are replaced. */
  schemaName: string
  model?: string
  maxTokens?: number
}

/** Deep-clones and forces the `strict: true` contract onto every object node. */
export function toStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  delete clone.$schema
  harden(clone)
  return clone
}

function harden(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) harden(child)
    return
  }
  if (node === null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>

  const properties = obj.properties
  if (properties && typeof properties === 'object') {
    obj.type ??= 'object'
    obj.additionalProperties = false
    obj.required = Object.keys(properties as Record<string, unknown>)
    for (const child of Object.values(properties as Record<string, unknown>)) harden(child)
  }

  for (const key of ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf', '$defs', 'definitions']) {
    const child = obj[key]
    if (!child) continue
    if (key === '$defs' || key === 'definitions') {
      for (const def of Object.values(child as Record<string, unknown>)) harden(def)
    } else {
      harden(child)
    }
  }
}

function jsonSchemaFor<T>(schema: StructuredSchema<T>): Record<string, unknown> {
  if (!isParser<T>(schema)) return toStrictJsonSchema(schema)
  // zod v4 exports the JSON Schema converter directly; `io: 'output'` describes what the
  // model must produce, and `unrepresentable: 'any'` keeps a stray `z.date()` from throwing.
  const converted = toJSONSchema(schema as unknown as Parameters<typeof toJSONSchema>[0], {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return toStrictJsonSchema(converted)
}

/**
 * One completion constrained to a JSON Schema, parsed and — for zod schemas — validated.
 *
 * Verified: the gateway honours `response_format.json_schema` with `strict: true` and puts
 * the JSON in `message.content` as a string.
 */
export async function completeStructured<T>(
  req: CompleteStructuredRequest<T>,
  deps: AiDeps = {},
): Promise<T> {
  const { apiKey } = credentials(deps)
  const payload = await postChat(
    {
      model: req.model ?? MODELS.synthesis,
      messages: [
        { role: 'system', content: buildSystemPrompt(req.system) },
        { role: 'user', content: req.user },
      ],
      ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: req.schemaName.replace(/[^A-Za-z0-9_-]/g, '_'),
          strict: true,
          schema: jsonSchemaFor(req.schema),
        },
      },
    },
    deps,
  )

  const content = messageContent(payload, apiKey)

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new AiError(
      redact(`AI gateway returned invalid JSON for ${req.schemaName}: ${truncate(content)}`, apiKey),
    )
  }

  if (isParser<T>(req.schema)) {
    const result = req.schema.safeParse(parsed)
    if (!result.success) {
      throw new AiError(
        redact(`AI response did not match schema ${req.schemaName}`, apiKey),
      )
    }
    return result.data
  }

  return parsed as T
}
