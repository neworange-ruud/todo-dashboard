/**
 * Brain client — PRD §17.10.
 *
 * Brain is the New Orange CRM, exposed as an MCP server over HTTP. `BRAIN_MCP_URL` and
 * `BRAIN_API_KEY` are both optional (`hasBrain()`); when either is missing every call here
 * returns `{ ok: false, reason: 'unconfigured' }` and the Account status block renders
 * *Nothing found* rather than an error. PRD §8: "one block failing never blocks the others".
 *
 * Transport: `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` v1.30, with the
 * bearer token supplied through `requestInit.headers` — the SDK merges that into every HTTP
 * request it makes (POST, the SSE GET and the session DELETE), which is what we want for a
 * static API key. `authProvider` is the OAuth path and is deliberately not used.
 *
 * Exact import paths, verified against node_modules (they move between SDK versions):
 *   `@modelcontextprotocol/sdk/client/index.js`         → `Client`
 *   `@modelcontextprotocol/sdk/client/streamableHttp.js` → `StreamableHTTPClientTransport`
 *
 * Connection lifecycle: one client is reused across calls (MCP initialise is a round-trip we
 * do not want per block). Any transport-level failure drops the cached client so the next
 * call reconnects.
 *
 * Nothing here throws into a page.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { getEnv, hasBrain, TTL } from '../config'
import { getOrFetch } from '../cache'

// ---------------------------------------------------------------------------
// Result type — mirrors lib/omni/client.ts (PRD §8)
// ---------------------------------------------------------------------------

export type BrainFailureReason =
  /** `BRAIN_MCP_URL` / `BRAIN_API_KEY` absent. The integration is simply off. */
  | 'unconfigured'
  /** Could not open or keep the MCP connection. */
  | 'unreachable'
  /** Brain answered, but with a refusal, a tool error, or something unparseable. */
  | 'error'

export interface BrainFailure {
  ok: false
  reason: BrainFailureReason
  /** Safe to render. Never contains the bearer token. */
  message: string
}

export type BrainResult<T> = { ok: true; data: T } | BrainFailure

// ---------------------------------------------------------------------------
// Injection seam
// ---------------------------------------------------------------------------

export interface BrainToolResult {
  content?: unknown[]
  isError?: boolean
  structuredContent?: unknown
}

export interface BrainToolInfo {
  name: string
  description?: string
}

/**
 * The slice of the MCP `Client` this module uses. Narrow on purpose: it keeps the SDK's
 * very wide generic return types out of our surface, and it is what tests substitute.
 */
export interface BrainClientLike {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<BrainToolResult>
  listTools(): Promise<{ tools: BrainToolInfo[] }>
  close(): Promise<void>
}

export type BrainClientFactory = () => Promise<BrainClientLike>

class BrainError extends Error {
  constructor(
    readonly reason: BrainFailureReason,
    message: string,
  ) {
    super(message)
    this.name = 'BrainError'
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function connectOverHttp(): Promise<BrainClientLike> {
  const env = getEnv()
  if (!env.BRAIN_MCP_URL || !env.BRAIN_API_KEY) {
    throw new BrainError('unconfigured', 'Brain is not configured.')
  }

  const transport = new StreamableHTTPClientTransport(new URL(env.BRAIN_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${env.BRAIN_API_KEY}` } },
  })
  const client = new Client({ name: 'task-desk', version: '0.1.0' })
  await client.connect(transport)

  // Adapter rather than a cast: the SDK's inferred result types are enormous and we only
  // ever read three fields off them.
  return {
    // The SDK's `callTool` return type is a union that also covers the legacy
    // `{ toolResult }` shape, so it is narrowed here rather than at every call site.
    callTool: (params) => client.callTool(params) as Promise<BrainToolResult>,
    listTools: () => client.listTools(),
    close: () => client.close(),
  }
}

let factory: BrainClientFactory = connectOverHttp
let connected: BrainClientLike | null = null
let connecting: Promise<BrainClientLike> | null = null

/**
 * Swaps the transport. Primarily a test seam — pass `null` to restore the real MCP client
 * and drop any cached connection.
 */
export function setClientFactory(next: BrainClientFactory | null): void {
  factory = next ?? connectOverHttp
  connected = null
  connecting = null
}

async function getClient(): Promise<BrainClientLike> {
  if (connected) return connected
  if (connecting) return connecting
  connecting = factory()
    .then((client) => {
      connected = client
      connecting = null
      return client
    })
    .catch((err: unknown) => {
      connecting = null
      throw err
    })
  return connecting
}

/** Forgets the connection so the next call reconnects. Never throws. */
async function dropClient(): Promise<void> {
  const client = connected
  connected = null
  connecting = null
  if (!client) return
  try {
    await client.close()
  } catch {
    /* the connection is already broken — that is why we are here */
  }
}

const UNREACHABLE = /fetch failed|econnrefused|enotfound|eai_again|socket|network|timeout|abort/i

function toFailure(err: unknown): BrainFailure {
  if (err instanceof BrainError) return { ok: false, reason: err.reason, message: err.message }
  const message = err instanceof Error ? err.message : String(err)
  return {
    ok: false,
    reason: UNREACHABLE.test(message) ? 'unreachable' : 'error',
    message: `Brain request failed: ${message}`,
  }
}

function unconfigured(): BrainFailure {
  return {
    ok: false,
    reason: 'unconfigured',
    message: 'Brain is not configured — set BRAIN_MCP_URL and BRAIN_API_KEY in .env.',
  }
}

/** `hasBrain()` reads `getEnv()`, which throws when the *core* env is incomplete. */
function configured(): boolean {
  try {
    return hasBrain()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Tool-call plumbing
// ---------------------------------------------------------------------------

/** Concatenated text content of a tool result. Brain puts readable messages here. */
function textOf(result: BrainToolResult): string {
  const parts: string[] = []
  for (const block of result.content ?? []) {
    const record = block as { type?: unknown; text?: unknown }
    if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}

/**
 * Structured payload of a tool result: `structuredContent` when present, otherwise the text
 * content parsed as JSON. Returns `null` when the result is prose.
 */
function payloadOf(result: BrainToolResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent
  }
  const text = textOf(result)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/** Finds the row array in a tool payload, whatever Brain called the envelope. */
function rowsOf(payload: unknown, ...keys: string[]): Record<string, unknown>[] {
  const candidates: unknown[] = [payload]
  const root = asRecord(payload)
  for (const key of [...keys, 'results', 'items', 'rows', 'data']) candidates.push(root[key])
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(asRecord)
  }
  return []
}

/**
 * Calls one Brain tool. Transport failures drop the connection so the next call reconnects;
 * a tool-level `isError` does not, because the connection is fine — the request was not.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<BrainToolResult> {
  let client: BrainClientLike
  try {
    client = await getClient()
  } catch (err) {
    await dropClient()
    throw err
  }

  let result: BrainToolResult
  try {
    result = await client.callTool({ name, arguments: args })
  } catch (err) {
    await dropClient()
    throw err
  }

  if (result.isError) {
    throw new BrainError('error', `Brain tool ${name} failed: ${textOf(result) || 'no detail'}`)
  }
  return result
}

/** Runs `fn` and contains every failure mode in a {@link BrainResult}. */
async function guarded<T>(fn: () => Promise<T>): Promise<BrainResult<T>> {
  if (!configured()) return unconfigured()
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    return toFailure(err)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Confirms the connection, per Brain's own setup instructions ("start with `whoami`").
 * Returns the readable identity summary Brain sends back.
 */
export async function whoami(): Promise<BrainResult<string>> {
  return guarded(() =>
    getOrFetch('brain:whoami', TTL.brain, async () => {
      const result = await callTool('whoami', {})
      const text = textOf(result)
      if (text) return text
      const payload = payloadOf(result)
      return (
        firstString(asRecord(payload).name, asRecord(payload).email, asRecord(payload).user) ??
        'connected'
      )
    }),
  )
}

/** What Brain actually exposes to this key — useful when a tool name stops resolving. */
export async function listTools(): Promise<BrainResult<BrainToolInfo[]>> {
  return guarded(() =>
    getOrFetch('brain:tools', TTL.brain, async () => {
      let client: BrainClientLike
      try {
        client = await getClient()
      } catch (err) {
        await dropClient()
        throw err
      }
      try {
        const { tools } = await client.listTools()
        return tools.map((tool) => ({ name: tool.name, description: tool.description }))
      } catch (err) {
        await dropClient()
        throw err
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// Account status — drill-in block 4 (PRD §8)
// ---------------------------------------------------------------------------

export interface BrainOpportunity {
  id: string | null
  title: string
  status: string | null
  amount: string | null
  /** ISO timestamp of the last status move, when Brain reports one. */
  changedAt: string | null
}

export interface BrainInvoice {
  /** DRAFT / PENDING invoices come back as "Concept" — a number is allocated on send. */
  number: string
  status: string | null
  total: string | null
  currency: string | null
  date: string | null
}

export interface BrainAccountStatus {
  companyId: string | null
  companyName: string
  /** Pipeline stage, when the company record carries one. */
  stage: string | null
  /** Health marker, when the company record carries one. */
  health: string | null
  openOpportunities: BrainOpportunity[]
  lastInvoice: BrainInvoice | null
  /**
   * Sub-queries that failed on their own — most often invoices, which need finance access.
   * The block still renders; these name what is missing rather than pretending it is empty.
   */
  partial: string[]
}

/**
 * Stage, open opportunities, last invoice and health for one account.
 *
 * Resolves the company first (`search_companies` is Brain's documented way in), then fans
 * out. Each fan-out leg is contained independently: a key without finance access loses the
 * invoice line, not the block. Resolves to `{ ok: true, data: null }` when no company
 * matches, so the UI can show *Nothing found* rather than an error (PRD §8).
 */
export async function accountStatus(
  companyNameOrDomain: string,
): Promise<BrainResult<BrainAccountStatus | null>> {
  const query = companyNameOrDomain.trim()
  if (!query) return { ok: true, data: null }

  return guarded(() =>
    getOrFetch(`brain:account:${query.toLowerCase()}`, TTL.brain, async () => {
      const matches = rowsOf(
        payloadOf(await callTool('search_companies', { query, limit: 5 })),
        'companies',
      )
      const company = pickCompany(matches, query)
      if (!company) return null

      const companyId = firstString(company.id, company.companyId, company.company_id)
      const partial: string[] = []

      const openOpportunities = companyId
        ? await safely('opportunities', partial, async () => {
            const payload = payloadOf(
              await callTool('list_opportunities', { companyId, limit: 10 }),
            )
            return rowsOf(payload, 'opportunities', 'quotes').map(toOpportunity)
          }, [] as BrainOpportunity[])
        : []

      const lastInvoice = companyId
        ? await safely('invoices', partial, async () => {
            const payload = payloadOf(await callTool('list_invoices', { companyId, limit: 1 }))
            const [row] = rowsOf(payload, 'invoices')
            return row ? toInvoice(row) : null
          }, null as BrainInvoice | null)
        : null

      return {
        companyId,
        companyName:
          firstString(company.name, company.legalName, company.legal_name) ?? query,
        stage: firstString(company.stage, company.pipelineStage, company.status),
        health: firstString(company.health, company.healthStatus, company.healthScore),
        openOpportunities,
        lastInvoice,
        partial,
      }
    }),
  )
}

/** Runs a fan-out leg; on failure records the label and returns the fallback. */
async function safely<T>(
  label: string,
  partial: string[],
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn()
  } catch {
    partial.push(label)
    return fallback
  }
}

/** Prefers an exact name match, then a domain match, then Brain's own first result. */
function pickCompany(
  rows: Record<string, unknown>[],
  query: string,
): Record<string, unknown> | null {
  if (!rows.length) return null
  const needle = query.toLowerCase()
  const exact = rows.find(
    (row) => (firstString(row.name, row.legalName) ?? '').toLowerCase() === needle,
  )
  if (exact) return exact
  const byDomain = rows.find((row) =>
    (firstString(row.domain, row.website, row.url) ?? '').toLowerCase().includes(needle),
  )
  return byDomain ?? rows[0]
}

function toOpportunity(row: Record<string, unknown>): BrainOpportunity {
  return {
    id: firstString(row.id, row.quoteId, row.number),
    title: firstString(row.title, row.name, row.subject, row.number) ?? 'Untitled opportunity',
    status: firstString(row.status, row.stage),
    amount: firstString(row.amount, row.total, row.value),
    changedAt: firstString(row.statusChangedAt, row.updatedAt, row.createdAt),
  }
}

function toInvoice(row: Record<string, unknown>): BrainInvoice {
  return {
    number: firstString(row.number, row.invoiceNumber, row.id) ?? 'Concept',
    status: firstString(row.status),
    total: firstString(row.total, row.amount),
    currency: firstString(row.currency),
    date: firstString(row.sentAt, row.issuedAt, row.createdAt, row.date),
  }
}
