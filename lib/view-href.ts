import type { DisplayMode } from './types'

/**
 * Link composition for the dashboard's own addresses.
 *
 * The page carries two flags that outlive a click — `?display=board` (PRD §17.13) and
 * `?date=` (PRD §17.14) — and every drill-in link is written as a bare `?drill=…`. A
 * query-only relative URL **replaces the whole query string**, so each of those links
 * silently dropped board mode, and would have dropped the viewed date: open a meeting from
 * a preview of Monday and the dashboard behind the panel would quietly snap back to today.
 *
 * So links are composed rather than concatenated. Client-safe on purpose — the components
 * that render these links are a mix of server and client, and both need the same answer.
 */

export interface ViewParams {
  display?: DisplayMode
  /** The viewed day, and only when it is not today — today needs no parameter. */
  date?: string | null
}

/**
 * Merges the view's flags into a dashboard link.
 *
 * `href` is expected in the `?drill=…` form the zones already write. Its own parameters
 * win, so a link that deliberately sets one of these keeps it.
 *
 * **The existing query is appended to, never re-serialised.** Round-tripping it through
 * `URLSearchParams` would percent-encode the colon in `drill=issue:RW-339`, and
 * `parseTrail` splits a trail segment on exactly that colon — so a re-encoded link opens
 * an empty panel. The values added here are a fixed enum and a date key, neither of which
 * needs escaping.
 */
export function withView(href: string, view: ViewParams = {}): string {
  const at = href.indexOf('?')
  const query = at >= 0 ? href.slice(at + 1) : ''
  const has = (key: string) => new RegExp(`(^|&)${key}=`).test(query)

  const additions: string[] = []
  if (view.display === 'board' && !has('display')) additions.push('display=board')
  if (view.date && !has('date')) additions.push(`date=${encodeURIComponent(view.date)}`)
  if (additions.length === 0) return href

  const path = at >= 0 ? href.slice(0, at) : href
  return `${path}?${[query, ...additions].filter(Boolean).join('&')}`
}

/**
 * `?drill=meeting:evt-1`, with the view's flags carried along.
 *
 * The id is escaped but the separating colon is not: `parseTrail` splits on it, and it is
 * legal unencoded in a query string.
 */
export function drillHref(type: string, id: string, view: ViewParams = {}): string {
  return withView(`?drill=${type}:${encodeURIComponent(id)}`, view)
}
