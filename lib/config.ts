import 'server-only'
import { z } from 'zod'
import { TIMEZONE, LINEAR_TEAM_KEY, STALE_AFTER_MS } from './constants'

// Re-exported so existing server-side imports keep working. Client Components must
// import these from './constants' directly — this module is server-only.
export { TIMEZONE, LINEAR_TEAM_KEY, STALE_AFTER_MS }

/**
 * Configuration and environment validation.
 *
 * Fails fast at boot with a message naming the missing key, rather than producing
 * a confusing 500 on first request.
 */

// ---------------------------------------------------------------------------
// The single-identity constraint — PRD §17.8
// ---------------------------------------------------------------------------

/**
 * The one mailbox Task Desk is ever allowed to read.
 *
 * SECURITY: the Graph credential holds `Calendars.Read.All`, a tenant-wide application
 * permission, so this constant is the *only* thing preventing Task Desk from reading
 * another person's calendar. It is deliberately a hard-coded constant:
 *
 *   - it MUST NOT become a function parameter,
 *   - it MUST NOT be read from the environment,
 *   - it MUST NOT be derived from request input, headers, query or body.
 *
 * `tests/identity.test.ts` asserts these properties. Read PRD §17.8 before changing this.
 */
export const GRAPH_USER_PRINCIPAL_NAME = 'ruud.vanfalier@neworange.agency' as const

/**
 * Output language for generated prose. The source data is largely Dutch, but the
 * voice specification in PRD §4 is written in English, so we pin it explicitly
 * rather than letting the model follow the input language.
 */
export const SENTENCE_LOCALE = (process.env.SENTENCE_LOCALE ?? 'en') as 'en' | 'nl'

/** Omni runs behind Caddy on loopback (PRD §12.3). */
export const OMNI_BASE_URL = process.env.OMNI_BASE_URL ?? 'http://127.0.0.1:41435'

// ---------------------------------------------------------------------------
// Model selection — PRD §17 round 3
// ---------------------------------------------------------------------------

export const MODELS = {
  /** Runs on a schedule; short output. */
  sentence: process.env.AI_MODEL_SENTENCE ?? 'gpt-5.6-terra',
  /** Runs on demand; quality matters most. */
  synthesis: process.env.AI_MODEL_SYNTHESIS ?? 'gpt-5.6-terra',
} as const

// ---------------------------------------------------------------------------
// Cache TTLs (PRD §15.2, §17.7)
// ---------------------------------------------------------------------------

export const TTL = {
  /** Linear is fetched on request and cached briefly. */
  linear: 60_000,
  graph: 120_000,
  omni: 300_000,
  brain: 300_000,
  /** Drill-in synthesis is cached per meeting per day. */
  synthesis: 12 * 60 * 60_000,
  /** The sentence is regenerated on a schedule; this is only a floor. */
  sentence: 15 * 60_000,
} as const


// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const schema = z.object({
  LINEAR_API_KEY: z.string().min(1),
  GRAPH_TENANT_ID: z.string().min(1),
  GRAPH_CLIENT_ID: z.string().min(1),
  GRAPH_SECRET: z.string().min(1),
  AI_API_KEY: z.string().min(1),
  AI_API_URL: z.string().url(),
  BRAIN_API_KEY: z.string().min(1).optional(),
  BRAIN_MCP_URL: z.string().url().optional(),
})

export type Env = z.infer<typeof schema>

let cached: Env | null = null

export function getEnv(): Env {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(
      `Task Desk cannot start: missing or invalid environment variables: ${missing}. ` +
        `Add them to .env — see PRD.md §12.5.`,
    )
  }
  cached = parsed.data
  return cached
}

/** Whether the optional Brain integration is configured. */
export function hasBrain(): boolean {
  const env = getEnv()
  return Boolean(env.BRAIN_API_KEY && env.BRAIN_MCP_URL)
}

/** Test seam. */
export function resetEnvCache(): void {
  cached = null
}
