/**
 * Brain client tests.
 *
 * No live network and no MCP server: `setClientFactory` substitutes the transport. The
 * emphasis is containment — PRD §8 gives the Account status block its own failure state, so
 * a Brain outage must never surface as an exception.
 */

// lib/config imports `server-only`, which refuses to load outside a Server Component.
vi.mock('server-only', () => ({}))

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidate } from '../cache'
import { resetEnvCache } from '../config'
import {
  accountStatus,
  listTools,
  setClientFactory,
  whoami,
  type BrainClientLike,
  type BrainToolResult,
} from './client'

/** The core env `getEnv()` insists on, so `hasBrain()` can be exercised in isolation. */
const CORE_ENV = {
  LINEAR_API_KEY: 'lin_test',
  GRAPH_TENANT_ID: 'tenant',
  GRAPH_CLIENT_ID: 'client',
  GRAPH_SECRET: 'secret',
  AI_API_KEY: 'sk-test',
  AI_API_URL: 'https://gateway.example.test/v1',
}

type ToolHandler = (args: Record<string, unknown>) => Promise<BrainToolResult> | BrainToolResult

function text(value: unknown): BrainToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  }
}

/** A fake MCP client plus the spies needed to assert connection reuse. */
function fakeBrain(tools: Record<string, ToolHandler>, toolList: string[] = Object.keys(tools)) {
  const callTool = vi.fn(async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
    const handler = tools[name]
    if (!handler) throw new Error(`unexpected tool ${name}`)
    return handler(args ?? {})
  })
  const close = vi.fn(async () => {})
  const listToolsSpy = vi.fn(async () => ({ tools: toolList.map((name) => ({ name })) }))
  const client: BrainClientLike = { callTool, listTools: listToolsSpy, close }
  const factory = vi.fn(async () => client)
  setClientFactory(factory)
  return { factory, callTool, close, listTools: listToolsSpy }
}

beforeEach(() => {
  invalidate()
  resetEnvCache()
  Object.assign(process.env, CORE_ENV)
  process.env.BRAIN_MCP_URL = 'https://brain.example.test/mcp'
  process.env.BRAIN_API_KEY = 'brain-test-key'
})

afterEach(() => {
  setClientFactory(null)
  resetEnvCache()
})

describe('configuration', () => {
  it('returns unconfigured without throwing when Brain is absent', async () => {
    delete process.env.BRAIN_MCP_URL
    delete process.env.BRAIN_API_KEY
    resetEnvCache()
    const { factory } = fakeBrain({})

    const result = await whoami()

    expect(result).toEqual({
      ok: false,
      reason: 'unconfigured',
      message: expect.stringContaining('BRAIN_MCP_URL'),
    })
    expect(factory).not.toHaveBeenCalled()
  })

  it('reports unconfigured when only one of the two variables is set', async () => {
    delete process.env.BRAIN_API_KEY
    resetEnvCache()
    fakeBrain({})

    const account = await accountStatus('Acme')
    expect(account.ok === false && account.reason).toBe('unconfigured')
  })

  it('does not throw when the core environment is incomplete either', async () => {
    delete process.env.LINEAR_API_KEY
    resetEnvCache()

    const result = await whoami()

    expect(result.ok).toBe(false)
    process.env.LINEAR_API_KEY = CORE_ENV.LINEAR_API_KEY
  })
})

describe('whoami', () => {
  it('confirms the connection and returns Brain identity text', async () => {
    const { callTool } = fakeBrain({
      whoami: () => text('Ruud van Falier — admin, NL office'),
    })

    const result = await whoami()

    expect(result).toEqual({ ok: true, data: 'Ruud van Falier — admin, NL office' })
    expect(callTool).toHaveBeenCalledWith({ name: 'whoami', arguments: {} })
  })

  it('falls back to structured content when the tool returns no prose', async () => {
    fakeBrain({
      whoami: () => ({ structuredContent: { name: 'Ruud van Falier' } }),
    })

    const result = await whoami()
    expect(result).toEqual({ ok: true, data: 'Ruud van Falier' })
  })

  it('reuses one connection and caches the answer', async () => {
    const { factory, callTool } = fakeBrain({ whoami: () => text('ok') })

    await whoami()
    await whoami()

    expect(factory).toHaveBeenCalledTimes(1)
    expect(callTool).toHaveBeenCalledTimes(1)
  })
})

describe('failure containment', () => {
  it('contains a tool-level error and keeps the connection', async () => {
    const { factory } = fakeBrain({
      whoami: () => ({ isError: true, content: [{ type: 'text', text: '[FORBIDDEN] no access' }] }),
    })

    const result = await whoami()

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('error')
    expect(result.ok === false && result.message).toContain('[FORBIDDEN]')

    invalidate()
    await whoami()
    // The transport was fine, so it was not thrown away.
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('maps a transport fault to unreachable and reconnects next time', async () => {
    const { factory, close } = fakeBrain({
      whoami: () => {
        throw new Error('fetch failed')
      },
    })

    const first = await whoami()
    expect(first.ok === false && first.reason).toBe('unreachable')
    expect(close).toHaveBeenCalledTimes(1)

    invalidate()
    await whoami()
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('contains a failure to connect at all', async () => {
    const factory = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:443')
    })
    setClientFactory(factory as never)

    const result = await whoami()

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('unreachable')
  })

  it('maps an unrecognised fault to error rather than unreachable', async () => {
    fakeBrain({
      whoami: () => {
        throw new Error('protocol violation')
      },
    })

    const result = await whoami()
    expect(result.ok === false && result.reason).toBe('error')
  })
})

describe('listTools', () => {
  it('reports what Brain exposes to this key', async () => {
    fakeBrain({}, ['whoami', 'search_companies', 'list_invoices'])

    const result = await listTools()

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.map((t) => t.name)).toEqual([
      'whoami',
      'search_companies',
      'list_invoices',
    ])
  })
})

describe('accountStatus', () => {
  const company = {
    id: 'cmp_1',
    name: 'Acme B.V.',
    domain: 'acme.nl',
    stage: 'Customer',
    health: 'green',
  }

  function brainWithAccount(overrides: Record<string, ToolHandler> = {}) {
    return fakeBrain({
      search_companies: () => text({ companies: [company] }),
      list_opportunities: () =>
        text({
          quotes: [
            {
              id: 'q_1',
              title: 'Migration phase 2',
              status: 'SENT_TO_CLIENT',
              total: '42000',
              statusChangedAt: '2026-09-02T10:00:00Z',
            },
          ],
        }),
      list_invoices: () =>
        text({
          invoices: [
            {
              number: '2026-0481',
              status: 'PAID',
              total: '12500',
              currency: 'EUR',
              sentAt: '2026-08-14',
            },
          ],
        }),
      ...overrides,
    })
  }

  it('resolves the company and fans out to opportunities and invoices', async () => {
    const { callTool } = brainWithAccount()

    const result = await accountStatus('Acme B.V.')

    expect(result.ok).toBe(true)
    expect(result.ok && result.data).toEqual({
      companyId: 'cmp_1',
      companyName: 'Acme B.V.',
      stage: 'Customer',
      health: 'green',
      openOpportunities: [
        {
          id: 'q_1',
          title: 'Migration phase 2',
          status: 'SENT_TO_CLIENT',
          amount: '42000',
          changedAt: '2026-09-02T10:00:00Z',
        },
      ],
      lastInvoice: {
        number: '2026-0481',
        status: 'PAID',
        total: '12500',
        currency: 'EUR',
        date: '2026-08-14',
      },
      partial: [],
    })

    expect(callTool).toHaveBeenCalledWith({
      name: 'search_companies',
      arguments: { query: 'Acme B.V.', limit: 5 },
    })
    expect(callTool).toHaveBeenCalledWith({
      name: 'list_opportunities',
      arguments: { companyId: 'cmp_1', limit: 10 },
    })
    expect(callTool).toHaveBeenCalledWith({
      name: 'list_invoices',
      arguments: { companyId: 'cmp_1', limit: 1 },
    })
  })

  it('resolves by domain as well as by name', async () => {
    fakeBrain({
      search_companies: () => text([{ id: 'cmp_2', name: 'Something Else' }, company]),
      list_opportunities: () => text({ quotes: [] }),
      list_invoices: () => text({ invoices: [] }),
    })

    const result = await accountStatus('acme.nl')
    expect(result.ok && result.data?.companyId).toBe('cmp_1')
  })

  it('keeps the block when only the finance leg fails', async () => {
    brainWithAccount({
      list_invoices: () => ({ isError: true, content: [{ type: 'text', text: '[FORBIDDEN]' }] }),
    })

    const result = await accountStatus('Acme B.V.')

    expect(result.ok).toBe(true)
    expect(result.ok && result.data?.partial).toEqual(['invoices'])
    expect(result.ok && result.data?.lastInvoice).toBeNull()
    expect(result.ok && result.data?.openOpportunities).toHaveLength(1)
  })

  it('returns null — not an error — when no company matches', async () => {
    fakeBrain({ search_companies: () => text({ companies: [] }) })

    const result = await accountStatus('Nonexistent Ltd')

    expect(result).toEqual({ ok: true, data: null })
  })

  it('short-circuits an empty query without touching Brain', async () => {
    const { factory } = fakeBrain({})

    expect(await accountStatus('   ')).toEqual({ ok: true, data: null })
    expect(factory).not.toHaveBeenCalled()
  })

  it('contains a failure in the company lookup itself', async () => {
    fakeBrain({
      search_companies: () => {
        throw new Error('fetch failed')
      },
    })

    const result = await accountStatus('Acme B.V.')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('unreachable')
  })
})
