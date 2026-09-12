import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `lib/config` is a server module. Vitest runs outside the React Server Components
// graph, so the marker package has to be neutralised here.
vi.mock('server-only', () => ({}))

import { invalidate } from '../cache'
import { resetEnvCache } from '../config'
import { LINEAR_API_URL, LINEAR_CACHE_KEY, fetchAllIssues, fetchIssues, mapIssue } from './client'
import type { FetchLike } from './client'
import type { LinearIssueNode } from './queries'

const API_KEY = 'lin_api_test_key'

/** A node shaped exactly like the live API returns one. */
function node(partial: Partial<LinearIssueNode> & { identifier: string }): LinearIssueNode {
  return {
    title: 'Untitled',
    dueDate: null,
    priority: 0,
    url: `https://linear.app/rw/issue/${partial.identifier}`,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    state: { name: 'Planned', type: 'unstarted' },
    labels: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...partial,
  }
}

function page(nodes: LinearIssueNode[], next?: string) {
  return {
    data: {
      issues: {
        pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null },
        nodes,
      },
    },
  }
}

/** Replays the given payloads in order, recording every request. */
function fakeFetch(payloads: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = []
  let index = 0
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const payload = payloads[Math.min(index++, payloads.length - 1)]
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { impl, calls }
}

function bodyOf(call: { init: RequestInit }): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(call.init.body))
}

beforeEach(() => {
  invalidate('linear:')
  resetEnvCache()
  vi.stubEnv('LINEAR_API_KEY', API_KEY)
  vi.stubEnv('GRAPH_TENANT_ID', 'tenant')
  vi.stubEnv('GRAPH_CLIENT_ID', 'client')
  vi.stubEnv('GRAPH_SECRET', 'secret')
  vi.stubEnv('AI_API_KEY', 'ai-key')
  vi.stubEnv('AI_API_URL', 'https://example.invalid/v1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvCache()
  invalidate('linear:')
})

describe('the request', () => {
  it('POSTs to the Linear GraphQL endpoint with the raw key — never a Bearer token', async () => {
    const { impl, calls } = fakeFetch([page([])])
    await fetchAllIssues(impl)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(LINEAR_API_URL)
    expect(calls[0].init.method).toBe('POST')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(API_KEY)
    expect(headers.Authorization).not.toMatch(/^Bearer/)
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('filters server-side to team RW', async () => {
    const { impl, calls } = fakeFetch([page([])])
    await fetchAllIssues(impl)

    const { variables } = bodyOf(calls[0])
    expect(variables.filter).toMatchObject({ team: { key: { eq: 'RW' } } })
  })

  it('excludes Backlog, Done, Canceled and Duplicate by name', async () => {
    const { impl, calls } = fakeFetch([page([])])
    await fetchAllIssues(impl)

    const { variables } = bodyOf(calls[0])
    const excluded = (variables.filter as { state: { name: { nin: string[] } } }).state.name.nin
    expect([...excluded].sort()).toEqual(['Backlog', 'Canceled', 'Done', 'Duplicate'])
  })

  it('never filters by assignee — assignees are not used on this board', async () => {
    const { impl, calls } = fakeFetch([page([])])
    await fetchAllIssues(impl)

    expect(JSON.stringify(bodyOf(calls[0]).variables)).not.toContain('assignee')
  })

  it('follows pagination until the last page', async () => {
    const { impl, calls } = fakeFetch([
      page([node({ identifier: 'RW-1' })], 'cursor-1'),
      page([node({ identifier: 'RW-2' })]),
    ])

    const issues = await fetchAllIssues(impl)

    expect(issues.map((i) => i.identifier)).toEqual(['RW-1', 'RW-2'])
    expect(bodyOf(calls[0]).variables.after).toBeNull()
    expect(bodyOf(calls[1]).variables.after).toBe('cursor-1')
  })
})

describe('mapping', () => {
  it('maps every field of a real-looking issue', async () => {
    const { impl } = fakeFetch([
      page([
        node({
          identifier: 'RW-339',
          title: 'De Agentic Engineering-presentatie afmaken',
          dueDate: '2026-07-22',
          priority: 2,
          url: 'https://linear.app/rw/issue/RW-339',
          createdAt: '2026-06-30T08:15:00.000Z',
          updatedAt: '2026-09-02T14:02:00.000Z',
          state: { name: 'In Progress', type: 'started' },
          labels: { nodes: [{ name: 'Transcript' }, { name: 'Technische governance' }] },
        }),
      ]),
    ])

    const [issue] = await fetchAllIssues(impl)

    expect(issue).toEqual({
      identifier: 'RW-339',
      title: 'De Agentic Engineering-presentatie afmaken',
      dueDate: '2026-07-22',
      priority: 2,
      state: 'In Progress',
      labels: ['Transcript', 'Technische governance'],
      url: 'https://linear.app/rw/issue/RW-339',
      hasRelations: false,
      createdAt: '2026-06-30T08:15:00.000Z',
      updatedAt: '2026-09-02T14:02:00.000Z',
    })
  })

  it('sets hasRelations from relations and inverseRelations alike', () => {
    expect(mapIssue(node({ identifier: 'RW-1' }))?.hasRelations).toBe(false)
    expect(
      mapIssue(node({ identifier: 'RW-2', relations: { nodes: [{ id: 'rel-1' }] } }))?.hasRelations,
    ).toBe(true)
    expect(
      mapIssue(node({ identifier: 'RW-3', inverseRelations: { nodes: [{ id: 'rel-2' }] } }))
        ?.hasRelations,
    ).toBe(true)
  })

  it('normalises a missing priority, title, url and label set', () => {
    const sparse = mapIssue({
      identifier: 'RW-4',
      title: null,
      dueDate: null,
      priority: null,
      url: null,
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
      state: { name: 'Inbox', type: 'backlog' },
    })

    expect(sparse).toMatchObject({ title: '', priority: 0, url: '', labels: [], state: 'Inbox' })
  })

  it('trims a datetime due date to a date key', () => {
    expect(mapIssue(node({ identifier: 'RW-5', dueDate: '2026-07-22T00:00:00.000Z' }))?.dueDate).toBe(
      '2026-07-22',
    )
  })

  it('drops any state outside the five the product reads', async () => {
    const { impl } = fakeFetch([
      page([
        node({ identifier: 'RW-dup', state: { name: 'Duplicate', type: 'duplicate' } }),
        node({ identifier: 'RW-new', state: { name: 'Under Review', type: 'started' } }),
        node({ identifier: 'RW-none', state: null }),
        node({ identifier: 'RW-ok', state: { name: 'Waiting', type: 'started' } }),
      ]),
    ])

    expect((await fetchAllIssues(impl)).map((i) => i.identifier)).toEqual(['RW-ok'])
  })
})

describe('caching and failure', () => {
  it('caches under linear:issues and does not re-fetch inside the TTL', async () => {
    const { impl, calls } = fakeFetch([page([node({ identifier: 'RW-1' })])])

    const first = await fetchIssues(impl)
    const second = await fetchIssues(impl)

    expect(LINEAR_CACHE_KEY).toBe('linear:issues')
    expect(calls).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('falls back to cached data when Linear goes down', async () => {
    const { impl } = fakeFetch([page([node({ identifier: 'RW-1', title: 'Last good' })])])
    await fetchIssues(impl)

    const failing: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }

    // The zone keeps rendering the last good answer rather than blanking (PRD §9).
    const issues = await fetchIssues(failing)
    expect(issues.map((i) => i.title)).toEqual(['Last good'])
  })

  it('rejects when Linear fails and nothing has ever been cached', async () => {
    const failing: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }

    await expect(fetchIssues(failing)).rejects.toThrow('ECONNREFUSED')
  })

  it('reports an HTTP failure with its status', async () => {
    const impl: FetchLike = async () => new Response('nope', { status: 401, statusText: 'Unauthorized' })

    await expect(fetchAllIssues(impl)).rejects.toThrow(/401/)
  })

  it('reports GraphQL errors returned with a 200', async () => {
    const { impl } = fakeFetch([{ errors: [{ message: 'Entity not found: Team' }] }])

    await expect(fetchAllIssues(impl)).rejects.toThrow(/Entity not found: Team/)
  })

  it('fails loudly when the environment has no Linear key', async () => {
    vi.stubEnv('LINEAR_API_KEY', '')
    resetEnvCache()
    const { impl } = fakeFetch([page([])])

    await expect(fetchAllIssues(impl)).rejects.toThrow(/LINEAR_API_KEY/)
  })
})
