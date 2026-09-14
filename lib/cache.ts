/**
 * In-process TTL cache.
 *
 * Task Desk runs as a permanently-running local server (PRD §12.1), so an in-process
 * cache is effectively durable; a restart simply re-warms it. PRD §15.2 and §17.7 rule
 * out a database in v1, and explicitly forbid writing to Omni's Postgres or the archive.
 */

interface Entry<T> {
  value: T
  expiresAt: number
  storedAt: number
}

const store = new Map<string, Entry<unknown>>()

export function get<T>(key: string): T | undefined {
  const hit = store.get(key)
  if (!hit) return undefined
  if (Date.now() > hit.expiresAt) {
    store.delete(key)
    return undefined
  }
  return hit.value as T
}

export function set<T>(key: string, value: T, ttlMs: number): T {
  store.set(key, { value, expiresAt: Date.now() + ttlMs, storedAt: Date.now() })
  return value
}

/**
 * Returns the cached value, or fetches and caches it.
 *
 * On failure, a *stale* entry is returned if one exists, so a source going down keeps
 * rendering the last good data behind an inline notice rather than blanking the zone
 * (PRD §9, "never lie about state"). The staleness is reported via {@link storedAt}.
 */
export async function getOrFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  // Read the raw entry rather than going through get(), which evicts on expiry and
  // would leave nothing to fall back to when the refetch then fails.
  const entry = store.get(key) as Entry<T> | undefined
  if (entry && Date.now() <= entry.expiresAt) return entry.value
  try {
    return set(key, await fetcher(), ttlMs)
  } catch (err) {
    // Serve expired-but-known data so a source going down keeps the zone rendering
    // behind an inline notice, rather than blanking it (PRD §9, "never lie about state").
    // Callers read storedAt() to label it, e.g. "showing data from 08:12".
    if (entry) return entry.value
    throw err
  }
}

/** When this key was last successfully written, or null. Drives the sync marker. */
export function storedAt(key: string): number | null {
  return store.get(key)?.storedAt ?? null
}

/** Most recent successful write across the given keys. */
export function newestStoredAt(keys: string[]): number | null {
  const times = keys.map(storedAt).filter((t): t is number => t !== null)
  return times.length ? Math.max(...times) : null
}

/**
 * Most recent successful write under `prefix`.
 *
 * The sync marker asks about a *source*, not about one key: Graph writes a different
 * entry per day and per week range, and with `?date=` in play the day that was actually
 * fetched is not today's. Naming the family rather than enumerating it is what keeps the
 * marker honest when the question moves.
 */
export function newestStoredAtPrefix(prefix: string): number | null {
  let newest: number | null = null
  for (const [key, entry] of store) {
    if (!key.startsWith(prefix)) continue
    if (newest === null || entry.storedAt > newest) newest = entry.storedAt
  }
  return newest
}

export function invalidate(prefix?: string): void {
  if (!prefix) return store.clear()
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key)
}

export function size(): number {
  return store.size
}
