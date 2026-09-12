import 'server-only'
import { buildDashboard } from './view-model'
import { generateSentence } from './ai/sentence'
import { parts } from './time'

/**
 * Keeps the daily sentence warm (PRD §4, round-2 answer 8).
 *
 * The sentence is regenerated roughly every 15 minutes, and additionally right after
 * each of the three time-window boundaries in §4, because those are the moments its
 * register changes — a sentence that still frames the morning at 16:05 is wrong in a
 * way that a slightly stale one is not.
 *
 * Regeneration is cheap to skip: `generateSentence` caches on an input hash, so a tick
 * where nothing material changed re-uses the cached text and the UI does not animate.
 */

/** Hours at which the §4 register changes. */
export const WINDOW_BOUNDARY_HOURS = [11, 16] as const

export const TICK_MS = 60_000
export const REGENERATE_EVERY_MS = 15 * 60_000

let timer: ReturnType<typeof setInterval> | null = null
let lastRunAt = 0
let lastWindowHour = -1

/** Exported for testing: decides whether this minute should trigger a regeneration. */
export function shouldRegenerate(now: Date, since: number, lastHour: number): boolean {
  const { hour, minute } = parts(now)
  // Just crossed a register boundary — regenerate immediately, once.
  if (WINDOW_BOUNDARY_HOURS.includes(hour as 11 | 16) && minute < 2 && hour !== lastHour) {
    return true
  }
  return Date.now() - since >= REGENERATE_EVERY_MS
}

async function tick(): Promise<void> {
  const now = new Date()
  if (!shouldRegenerate(now, lastRunAt, lastWindowHour)) return

  lastRunAt = Date.now()
  lastWindowHour = parts(now).hour
  try {
    const model = await buildDashboard('default', now)
    await generateSentence(model)
  } catch (err) {
    // A scheduler failure must never take down the server. The page still renders:
    // generateSentence falls back to a deterministic sentence on demand.
    console.warn('[task-desk] sentence pre-generation failed:', (err as Error).message)
  }
}

export function startSentenceScheduler(): void {
  if (timer) return
  // Warm immediately so the first page view does not pay for generation.
  void tick()
  timer = setInterval(() => void tick(), TICK_MS)
  // Do not hold the process open on its own account.
  timer.unref?.()
  console.log('[task-desk] sentence scheduler started')
}

export function stopSentenceScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  lastRunAt = 0
  lastWindowHour = -1
}
