import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CASCADE_STEP_MS,
  MIN_WORD_FADE_MS,
  SENTENCE_MS,
  WORD_STEP_MS,
  cascadeDelays,
  hasSentenceChanged,
  shouldReduceMotion,
  wordTimings,
} from './motion'
import type { DailySentence } from './types'

function sentence(text: string, inputHash: string): DailySentence {
  return {
    text,
    entities: [],
    window: 'morning',
    generatedAt: '2026-09-11T08:00:00+02:00',
    inputHash,
  }
}

/** Replaces `window.matchMedia` for one test and restores it afterwards. */
function stubMatchMedia(matches: boolean): ReturnType<typeof vi.fn> {
  const fn = vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  vi.stubGlobal('matchMedia', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cascadeDelays', () => {
  it('spaces the zones 60ms apart, starting at zero (PRD §11)', () => {
    expect(cascadeDelays(6)).toEqual([0, 60, 120, 180, 240, 300])
  })

  it('uses the spec constant rather than a literal', () => {
    const delays = cascadeDelays(4)
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i] - delays[i - 1]).toBe(CASCADE_STEP_MS)
    }
  })

  it('keeps the six-zone cascade at roughly 700ms end to end', () => {
    const delays = cascadeDelays(6)
    // Last zone starts at 300ms and runs for 400ms.
    expect(delays[delays.length - 1] + 400).toBe(700)
  })

  it('collapses to a single simultaneous start under reduced motion', () => {
    expect(cascadeDelays(6, true)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('returns nothing for a degenerate count', () => {
    expect(cascadeDelays(0)).toEqual([])
    expect(cascadeDelays(-3)).toEqual([])
    expect(cascadeDelays(Number.NaN)).toEqual([])
  })
})

describe('wordTimings', () => {
  it('gives one timing per word and ignores the whitespace between them', () => {
    const timings = wordTimings('  Today is  a meeting day. ')
    expect(timings.map((t) => t.text)).toEqual(['Today', 'is', 'a', 'meeting', 'day.'])
  })

  it('finishes the whole run at 500ms, whatever the length (PRD §11)', () => {
    for (const words of [1, 5, 11, 25, 50]) {
      const text = Array.from({ length: words }, (_, i) => `w${i}`).join(' ')
      const timings = wordTimings(text)
      const last = timings[timings.length - 1]
      expect(last.delayMs + last.durationMs).toBeCloseTo(SENTENCE_MS, 0)
    }
  })

  it('steps ~28ms per word while the sentence is short enough to afford it', () => {
    const timings = wordTimings('one two three four five')
    expect(timings[1].delayMs - timings[0].delayMs).toBe(WORD_STEP_MS)
    expect(timings[4].delayMs).toBe(WORD_STEP_MS * 4)
  })

  it('compresses the step rather than overrunning 500ms on a long sentence', () => {
    const text = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')
    const timings = wordTimings(text)
    const step = timings[1].delayMs - timings[0].delayMs
    expect(step).toBeLessThan(WORD_STEP_MS)
    expect(timings[timings.length - 1].delayMs).toBeLessThanOrEqual(SENTENCE_MS - MIN_WORD_FADE_MS)
  })

  it('never fades a single word faster than the floor', () => {
    const text = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    for (const timing of wordTimings(text)) {
      expect(timing.durationMs).toBeGreaterThanOrEqual(MIN_WORD_FADE_MS)
    }
  })

  it('returns nothing for empty prose', () => {
    expect(wordTimings('')).toEqual([])
    expect(wordTimings('   ')).toEqual([])
  })
})

describe('hasSentenceChanged', () => {
  it('compares the input hash, not the prose', () => {
    const a = sentence('Today is a meeting day.', 'hash-1')
    const b = sentence('A meeting day, today.', 'hash-1')

    // Different words, same inputs — the model only rephrased itself. Not news.
    expect(a.text).not.toBe(b.text)
    expect(hasSentenceChanged(a, b)).toBe(false)
  })

  it('is true when the inputs changed, even if the prose happens to match', () => {
    const a = sentence('Today is a meeting day.', 'hash-1')
    const b = sentence('Today is a meeting day.', 'hash-2')

    expect(hasSentenceChanged(a, b)).toBe(true)
  })

  it('treats appearing and disappearing as a change, and absence as no change', () => {
    const a = sentence('Today is a meeting day.', 'hash-1')

    expect(hasSentenceChanged(null, a)).toBe(true)
    expect(hasSentenceChanged(a, null)).toBe(true)
    expect(hasSentenceChanged(null, null)).toBe(false)
    expect(hasSentenceChanged(undefined, undefined)).toBe(false)
  })
})

describe('shouldReduceMotion', () => {
  it('reads the prefers-reduced-motion media query', () => {
    const matchMedia = stubMatchMedia(true)

    expect(shouldReduceMotion()).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
  })

  it('is false when the reader has expressed no preference', () => {
    stubMatchMedia(false)

    expect(shouldReduceMotion()).toBe(false)
  })

  it('does not throw where matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)

    expect(shouldReduceMotion()).toBe(false)
  })
})
