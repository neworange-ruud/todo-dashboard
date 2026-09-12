import { describe, it, expect, vi, afterEach } from 'vitest'
import { shouldRegenerate, REGENERATE_EVERY_MS, WINDOW_BOUNDARY_HOURS } from './scheduler'

const at = (iso: string) => new Date(iso)

afterEach(() => vi.useRealTimers())

describe('sentence scheduler', () => {
  it('regenerates once the interval has elapsed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(at('2026-09-11T09:30:00+02:00'))
    expect(shouldRegenerate(at('2026-09-11T09:30:00+02:00'), Date.now() - REGENERATE_EVERY_MS, 9)).toBe(true)
    expect(shouldRegenerate(at('2026-09-11T09:30:00+02:00'), Date.now(), 9)).toBe(false)
  })

  it('fires immediately on each register boundary (PRD §4)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(at('2026-09-11T11:00:30+02:00'))
    // Just ticked past 11:00 and the last run was moments ago — still regenerate,
    // because the register changed from "morning" to "midday".
    expect(shouldRegenerate(at('2026-09-11T11:00:30+02:00'), Date.now(), 10)).toBe(true)
    vi.setSystemTime(at('2026-09-11T16:01:00+02:00'))
    expect(shouldRegenerate(at('2026-09-11T16:01:00+02:00'), Date.now(), 15)).toBe(true)
  })

  it('does not re-fire repeatedly within the same boundary hour', () => {
    vi.useFakeTimers()
    vi.setSystemTime(at('2026-09-11T11:01:00+02:00'))
    expect(shouldRegenerate(at('2026-09-11T11:01:00+02:00'), Date.now(), 11)).toBe(false)
  })

  it('ignores non-boundary hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(at('2026-09-11T14:00:30+02:00'))
    expect(shouldRegenerate(at('2026-09-11T14:00:30+02:00'), Date.now(), 13)).toBe(false)
  })

  it('uses the two boundaries the voice spec defines', () => {
    expect([...WINDOW_BOUNDARY_HOURS]).toEqual([11, 16])
  })
})
