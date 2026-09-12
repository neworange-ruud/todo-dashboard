/**
 * Linear GraphQL client.
 *
 * Read-only. Task Desk never writes to Linear (PRD §1). The result is cached in-process
 * for {@link TTL.linear}; if the cache still holds a fresh page the API is not touched at
 * all, which is what keeps a Linear outage from blanking the board (PRD §9, §15.2).
 */

import { getOrFetch } from '../cache'
import { LINEAR_TEAM_KEY, TTL, getEnv } from '../config'
import {
  COMMITTED_STATES,
  UNCOMMITTED_STATES,
  type LinearIssue,
  type TaskState,
} from '../types'
import {
  ISSUES_QUERY,
  PAGE_SIZE,
  buildIssuesFilter,
  type GraphQLResponse,
  type IssuesResponse,
  type LinearIssueNode,
} from './queries'

export const LINEAR_API_URL = 'https://api.linear.app/graphql'

/** Cache key for the whole open-issue set. Invalidate with `cache.invalidate('linear:')`. */
export const LINEAR_CACHE_KEY = 'linear:issues'

/** The injectable seam. Narrower than `fetch` so tests can supply a plain function. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** The five states the product reads. Anything else is dropped during mapping. */
const READ_STATES: readonly string[] = [...COMMITTED_STATES, ...UNCOMMITTED_STATES]

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/**
 * Every open issue on team RW, in the five states Task Desk reads.
 *
 * Cached under {@link LINEAR_CACHE_KEY}. Pass `fetchImpl` in tests; production uses
 * the global `fetch`.
 */
export function fetchIssues(fetchImpl: FetchLike = defaultFetch): Promise<LinearIssue[]> {
  return getOrFetch(LINEAR_CACHE_KEY, TTL.linear, () => fetchAllIssues(fetchImpl))
}

/** Uncached fetch of every page. Exported for tests and for a forced refresh. */
export async function fetchAllIssues(fetchImpl: FetchLike = defaultFetch): Promise<LinearIssue[]> {
  const filter = buildIssuesFilter(LINEAR_TEAM_KEY)
  const issues: LinearIssue[] = []
  let after: string | null = null

  // Bounded: the board holds 22 open issues, so this loop runs once. The cap is a
  // guard against a malformed `pageInfo` spinning forever, not an expected path.
  for (let page = 0; page < 20; page++) {
    const data: IssuesResponse = await request<IssuesResponse>(
      fetchImpl,
      ISSUES_QUERY,
      { filter, first: PAGE_SIZE, after },
    )
    for (const node of data.issues.nodes) {
      const mapped = mapIssue(node)
      if (mapped) issues.push(mapped)
    }
    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break
    after = data.issues.pageInfo.endCursor
  }

  return issues
}

/**
 * Maps a wire node to the domain type.
 *
 * Returns null for any state outside the five (PRD §17.3). The server-side filter
 * already excludes the four known ones by name; this second gate means a *new* state
 * added in Linear tomorrow cannot silently widen {@link TaskState}.
 */
export function mapIssue(node: LinearIssueNode): LinearIssue | null {
  const stateName = node.state?.name
  if (!stateName || !READ_STATES.includes(stateName)) return null

  const relations = node.relations?.nodes?.length ?? 0
  const inverse = node.inverseRelations?.nodes?.length ?? 0

  return {
    identifier: node.identifier,
    title: node.title ?? '',
    description: node.description ?? null,
    dueDate: node.dueDate ? node.dueDate.slice(0, 10) : null,
    priority: node.priority ?? 0,
    state: stateName as TaskState,
    labels: node.labels?.nodes?.map((l) => l.name) ?? [],
    url: node.url ?? '',
    hasRelations: relations + inverse > 0,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  }
}

async function request<T>(
  fetchImpl: FetchLike,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const { LINEAR_API_KEY } = getEnv()

  const response = await fetchImpl(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      // Linear personal API keys are sent raw — NOT as a Bearer token.
      Authorization: LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`Linear API returned ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as GraphQLResponse<T>
  if (payload.errors?.length) {
    throw new Error(`Linear API error: ${payload.errors.map((e) => e.message).join('; ')}`)
  }
  if (!payload.data) {
    throw new Error('Linear API returned no data')
  }
  return payload.data
}
