import 'server-only'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { toDateKey } from './time'

/**
 * The "when the AI is wrong" log (PRD §9).
 *
 * It will be wrong. Dismissing a block records the item, the block and the output —
 * "that log is the only way the prompts ever improve, and it costs the reader one tap."
 *
 * This is the one thing in v1 that outlives the process, and PRD §17.7 allows exactly
 * that: storage owned by the app, for the feedback log and warm restarts. A JSONL file
 * is enough — appends are atomic at this size, it needs no service, and it is trivially
 * greppable when the time comes to actually improve a prompt. Never Omni's Postgres,
 * never the archive database.
 */

const STORE_DIR = process.env.TASK_DESK_STATE_DIR ?? join(process.cwd(), '.task-desk')
const LOG_PATH = join(STORE_DIR, 'feedback.jsonl')

export type FeedbackKind = 'regenerate' | 'not-right'

export interface FeedbackEntry {
  at: string
  dateKey: string
  kind: FeedbackKind
  /** e.g. "meeting:AAMk..." — what was being looked at. */
  subject: string
  /** Which block produced the bad output. */
  blockId: string
  /** The output being complained about, so the log is reviewable without replaying. */
  output: string
  sources?: string[]
}

/**
 * Blocks dismissed today, keyed `subject::blockId`.
 *
 * Dismissal hides that block for that item *for the day* — deliberately not forever.
 * Kept in memory and rebuilt from the log at boot, so a restart does not resurrect a
 * block the reader already rejected this morning.
 */
const dismissedToday = new Set<string>()
let hydratedFor: string | null = null

const key = (subject: string, blockId: string) => `${subject}::${blockId}`

export async function record(entry: Omit<FeedbackEntry, 'at' | 'dateKey'>): Promise<void> {
  const full: FeedbackEntry = {
    ...entry,
    at: new Date().toISOString(),
    dateKey: toDateKey(new Date()),
  }
  if (full.kind === 'not-right') dismissedToday.add(key(full.subject, full.blockId))

  try {
    await mkdir(dirname(LOG_PATH), { recursive: true })
    await appendFile(LOG_PATH, JSON.stringify(full) + '\n', 'utf8')
  } catch (err) {
    // Losing a feedback line must never break the drill-in the reader is using.
    console.warn('[task-desk] could not write feedback log:', (err as Error).message)
  }
}

/** Rebuilds today's dismissals from the log. Cheap: the file is small and read once. */
export async function hydrate(todayKey = toDateKey(new Date())): Promise<void> {
  if (hydratedFor === todayKey) return
  hydratedFor = todayKey
  dismissedToday.clear()
  try {
    const raw = await readFile(LOG_PATH, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as FeedbackEntry
        if (entry.dateKey === todayKey && entry.kind === 'not-right') {
          dismissedToday.add(key(entry.subject, entry.blockId))
        }
      } catch {
        // A truncated final line is expected if the process died mid-append.
      }
    }
  } catch {
    // No log yet — nothing has been dismissed.
  }
}

export function isDismissed(subject: string, blockId: string): boolean {
  return dismissedToday.has(key(subject, blockId))
}

/** Test seam. */
export function resetDismissals(): void {
  dismissedToday.clear()
  hydratedFor = null
}

export const LOG_FILE = LOG_PATH
