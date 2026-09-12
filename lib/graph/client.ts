import 'server-only'
import { getEnv, TIMEZONE } from '../config'

/**
 * Microsoft Graph transport — token acquisition and authenticated GETs.
 *
 * Client-credentials flow, verified working 11 Sep 2026 (PRD §17.8). The credential holds
 * the tenant-wide `Calendars.Read.All` application permission, so nothing in this module
 * may ever accept an identity: it knows how to talk to Graph, not *whose* data to ask for.
 * The single-identity rule lives in `lib/graph/calendar.ts`, sourced from the
 * `GRAPH_USER_PRINCIPAL_NAME` constant in `lib/config.ts`.
 */

/** Injection seam so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0' as const
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default' as const

/** Renew this far before the stated expiry so an in-flight request never races it. */
const TOKEN_RENEW_SKEW_MS = 60_000
/** Used when Graph omits `expires_in`; the real value is ~3600. */
const TOKEN_FALLBACK_TTL_S = 3600

interface CachedToken {
  token: string
  /** Epoch ms at which the token stops being valid. */
  expiresAt: number
}

/**
 * Process-local, deliberately not in `lib/cache.ts`: a bearer token is a secret and has no
 * business sitting in the same store as renderable data.
 */
let cachedToken: CachedToken | null = null

/** In-flight request, so a burst of parallel calls mints exactly one token. */
let inFlight: Promise<string> | null = null

/** Test seam. */
export function resetGraphToken(): void {
  cachedToken = null
  inFlight = null
}

export function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
}

async function requestToken(fetchImpl: FetchLike): Promise<string> {
  const env = getEnv()
  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_SECRET,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials',
  })

  const res = await fetchImpl(tokenEndpoint(env.GRAPH_TENANT_ID), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    throw new Error(
      `Graph token request failed: ${res.status} ${res.statusText}. ` +
        `Check GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_SECRET — see PRD.md §17.8.`,
    )
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) {
    throw new Error('Graph token response contained no access_token.')
  }

  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? TOKEN_FALLBACK_TTL_S) * 1000,
  }
  return cachedToken.token
}

/** A valid bearer token, minted only when the cached one is gone or about to expire. */
export async function getGraphToken(fetchImpl: FetchLike = fetch): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_RENEW_SKEW_MS > Date.now()) {
    return cachedToken.token
  }
  if (inFlight) return inFlight

  inFlight = requestToken(fetchImpl).finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Authenticated GET against Graph.
 *
 * `path` is either absolute (an `@odata.nextLink`) or rooted at {@link GRAPH_BASE_URL}.
 * The `Prefer` header pins Graph's response times to Europe/Amsterdam (PRD §17.4) so the
 * wall-clock we render is the wall-clock Outlook shows.
 */
export async function graphGet<T>(path: string, fetchImpl: FetchLike = fetch): Promise<T> {
  const token = await getGraphToken(fetchImpl)
  const url = path.startsWith('http') ? path : `${GRAPH_BASE_URL}${path}`

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Prefer: `outlook.timezone="${TIMEZONE}"`,
    },
  })

  if (!res.ok) {
    // A 401 after a cached token means the token was revoked; drop it so the next call retries.
    if (res.status === 401) resetGraphToken()
    throw new Error(`Graph request failed: ${res.status} ${res.statusText} for ${url}`)
  }

  return (await res.json()) as T
}
