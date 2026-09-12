import { BLOCK_SOURCE_LABELS, BLOCK_TITLES } from './blocks'
import type { DrillBlockId } from './blocks'
import type { BlockStatus, DrillBlock, SourceRef } from '../types'

/**
 * The containment boundary every drill-in block is run inside (PRD §8).
 *
 * Extracted from `lib/drill/meeting.ts` when the issue panel gained blocks of its own:
 * both panels depend on the same guarantee, and a guarantee implemented twice is a
 * guarantee that will eventually only hold once.
 *
 * The rule is that **nothing here rejects**. An empty payload becomes *Nothing found*, a
 * thrown error becomes *Could not reach X · Retry*, and the caller can therefore use
 * `Promise.all` over five blocks without a single failure taking the panel with it.
 */

export interface BlockOutcome<T> {
  data?: T
  sources?: SourceRef[]
  /** Force the *Nothing found* reading even when `data` is present. */
  empty?: boolean
}

class BlockFailure extends Error {}

/** Raised inside a block body to render *Could not reach X · Retry* rather than a crash. */
export function blockFailure(message: string): never {
  throw new BlockFailure(message)
}

/**
 * Runs one block body under its own clock and its own catch.
 *
 * Never rejects. Secrets are scrubbed by {@link safeMessage} before a message can reach a
 * header — a drill-in header is the last place an API key should be able to surface.
 */
export async function runBlock<T>(
  id: DrillBlockId,
  fn: () => Promise<BlockOutcome<T>>,
  now: () => number,
): Promise<DrillBlock<T>> {
  const started = now()
  const base = { id, title: BLOCK_TITLES[id] } as const

  try {
    const outcome = await fn()
    const empty = outcome.empty === true || isEmpty(outcome.data)
    const status: BlockStatus = empty ? 'empty' : 'ok'
    return {
      ...base,
      status,
      elapsedMs: Math.max(0, now() - started),
      ...(empty ? {} : { data: outcome.data }),
      ...(outcome.sources?.length ? { sources: outcome.sources } : {}),
    }
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      elapsedMs: Math.max(0, now() - started),
      error: safeMessage(err, BLOCK_SOURCE_LABELS[id]),
    }
  }
}

export function isEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true
  if (Array.isArray(data)) return data.length === 0
  if (typeof data === 'string') return data.trim().length === 0
  return false
}

/**
 * A message fit to print in a block header.
 *
 * Anything long, key-shaped or bearer-shaped is dropped in favour of the generic line
 * (PRD §12.5).
 */
export function safeMessage(err: unknown, sourceLabel: string): string {
  const fallback = `Could not reach ${sourceLabel}`
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const text = raw.trim()
  if (!text || text.length > 160) return fallback
  if (/(bearer|api[-_ ]?key|authorization|token|secret|password)/i.test(text)) return fallback
  // A long unbroken run of key-ish characters is a credential, whatever it is called.
  if (/[A-Za-z0-9_-]{28,}/.test(text)) return fallback
  return text
}
