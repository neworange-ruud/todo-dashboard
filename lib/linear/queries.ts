/**
 * Linear GraphQL documents and filter construction.
 *
 * Kept separate from the transport in `client.ts` so the query shape is testable
 * without a network, and so the server-side filter (PRD §16.1, §17.3) is stated
 * in one place rather than smeared through the fetch code.
 */

import { LINEAR_TEAM_KEY } from '../config'
import { EXCLUDED_STATE_NAMES } from '../types'

/**
 * One page of open issues for the team.
 *
 * `description` is requested because it carries the machine-extraction provenance line
 * (`lib/domain/provenance.ts`) — the exact pointer from a task to the transcript or mail
 * it came from, and the input to the issue drill-in's *What was said* block.
 *
 * Otherwise only the fields the product actually renders are requested. There are no estimates,
 * projects or cycles on this board (PRD §16.3/§16.4), so none are asked for.
 * `relations`/`inverseRelations` are fetched purely to derive {@link LinearIssue.hasRelations}.
 */
export const ISSUES_QUERY = `query TaskDeskIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      identifier
      title
      description
      dueDate
      priority
      url
      createdAt
      updatedAt
      state {
        name
        type
      }
      labels(first: 20) {
        nodes {
          name
        }
      }
      relations(first: 10) {
        nodes {
          id
        }
      }
      inverseRelations(first: 10) {
        nodes {
          id
        }
      }
    }
  }
}`

/** Linear caps page size at 250; the board holds 22 open issues, so this is one round trip. */
export const PAGE_SIZE = 100

export interface IssuesFilter {
  team: { key: { eq: string } }
  state: { name: { nin: string[] } }
}

/**
 * Server-side filter: one team, and never the four excluded states.
 *
 * Assignee is deliberately absent — assignees are not used on this board (PRD §16).
 * Excluding by state *name* rather than type is required: `Backlog` and `Inbox` share the
 * `backlog` type, and `Ready` and `Planned` share `unstarted`, so filtering by type would
 * throw away two of the five states the product reads.
 */
export function buildIssuesFilter(
  teamKey: string = LINEAR_TEAM_KEY,
  excludedStateNames: readonly string[] = EXCLUDED_STATE_NAMES,
): IssuesFilter {
  return {
    team: { key: { eq: teamKey } },
    state: { name: { nin: [...excludedStateNames] } },
  }
}

// ---------------------------------------------------------------------------
// Raw response shapes — the wire format, before mapping to LinearIssue
// ---------------------------------------------------------------------------

interface Connection<T> {
  nodes: T[]
}

export interface LinearIssueNode {
  identifier: string
  title: string | null
  description?: string | null
  dueDate: string | null
  priority: number | null
  url: string | null
  createdAt: string
  updatedAt: string
  state: { name: string; type: string } | null
  labels?: Connection<{ name: string }> | null
  relations?: Connection<{ id: string }> | null
  inverseRelations?: Connection<{ id: string }> | null
}

export interface IssuesResponse {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: LinearIssueNode[]
  }
}

export interface GraphQLResponse<T> {
  data?: T | null
  errors?: { message: string }[]
}
