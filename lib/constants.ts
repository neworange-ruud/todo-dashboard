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

/**
 * How often the page re-reads its sources (PRD §9, §15.3).
 *
 * The dashboard is a live reading of systems that change while nobody is looking at it,
 * so leaving it on the render it was born with is the one failure mode it cannot be
 * allowed to have: a meeting that has finished, or a task that has been closed, must
 * not still be on screen. One minute is the shortest interval the source TTLs can
 * actually honour — Linear is cached for 60s and Graph for 120s — so polling faster
 * would only redraw the same numbers.
 */
export const POLL_MS = 60_000

/** How often the *relative* labels ("Synced 2m ago") are recomputed between polls. */
export const CLOCK_TICK_MS = 30_000
