/**
 * Pure constants, safe in any bundle.
 *
 * Deliberately free of `server-only` and of any Node import, so Client Components can
 * read them. `lib/config.ts` re-exports these alongside the server-only configuration,
 * so existing imports keep working — but anything reachable from a client bundle must
 * import from *here*, not from config.
 */

/** Fixed timezone. Never read from the client (PRD §17.4). */
export const TIMEZONE = 'Europe/Amsterdam' as const

/** The only Linear team. Assignees are not used (PRD §16). */
export const LINEAR_TEAM_KEY = 'RW' as const

/** Data older than this flips the sync marker to the warning hue (PRD §9). */
export const STALE_AFTER_MS = 15 * 60_000

/** Presentation profile query flag (PRD §17.13). */
export const BOARD_QUERY_VALUE = 'board' as const
