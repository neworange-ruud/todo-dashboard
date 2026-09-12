import { describe, it, expect, beforeEach, vi } from 'vitest'
import { get, set, getOrFetch, storedAt, newestStoredAt, invalidate, size } from './cache'

beforeEach(() => invalidate())

describe('TTL cache', () => {
  it('returns a live value and evicts an expired one', () => {
    set('k', 1, 50)
    expect(get('k')).toBe(1)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 100)
    expect(get('k')).toBeUndefined()
    vi.useRealTimers()
  })

  it('does not call the fetcher while the value is fresh', async () => {
    const f = vi.fn().mockResolvedValue('fresh')
    await getOrFetch('k', 10_000, f)
    await getOrFetch('k', 10_000, f)
    expect(f).toHaveBeenCalledTimes(1)
  })

  // The regression this file exists for: an expired entry must survive a failed refetch.
  it('serves stale data when the refetch fails (PRD §9)', async () => {
    await getOrFetch('k', 10, async () => 'good')
    await new Promise((r) => setTimeout(r, 25))
    const value = await getOrFetch('k', 10, async () => {
      throw new Error('source down')
    })
    expect(value, 'expired-but-known data keeps the zone rendering').toBe('good')
    expect(storedAt('k'), 'and stays labellable as stale').not.toBeNull()
  })

  it('rethrows when the cache is cold and the fetch fails', async () => {
    await expect(
      getOrFetch('cold', 1000, async () => {
        throw new Error('source down')
      }),
    ).rejects.toThrow('source down')
  })

  it('reports the newest write across keys', async () => {
    set('a', 1, 1000)
    await new Promise((r) => setTimeout(r, 5))
    set('b', 2, 1000)
    expect(newestStoredAt(['a', 'b'])).toBe(storedAt('b'))
    expect(newestStoredAt(['missing'])).toBeNull()
  })

  it('invalidates by prefix', () => {
    set('linear:issues', 1, 1000)
    set('graph:day', 2, 1000)
    invalidate('linear:')
    expect(get('linear:issues')).toBeUndefined()
    expect(get('graph:day')).toBe(2)
    expect(size()).toBe(1)
  })
})
