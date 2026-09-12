import 'server-only'
import { fetchIssues } from './linear/client'
import { fetchEventsForDay, fetchEventsForWeek } from './graph/calendar'
import { rankTasks } from './domain/ranking'
import { dueThisWeek, needsPlanning } from './domain/states'
import { buildTimeline } from './domain/timeline'
import { buildWeekLoad } from './domain/week'
import { buildAttention } from './domain/attention'
import { matchIssuesToMeetings } from './ai/matching'
import { toDateKey, weekdaysOf } from './time'
import { newestStoredAt } from './cache'
import { STALE_AFTER_MS } from './config'
import type {
  AttentionItem,
  CalendarEvent,
  DayLoad,
  DisplayMode,
  LinearIssue,
  RankedTask,
  SourceHealth,
  SyncState,
  TimelineLayout,
} from './types'

/**
 * Composes every source into the single object the page renders.
 *
 * Each source is fetched independently and failures are contained: a source going down
 * degrades its own zone and leaves the rest of the page intact (PRD §9, "never lie about
 * state"). Nothing here throws — the page always renders something honest.
 */

export interface DashboardModel {
  todayKey: string
  now: Date
  display: DisplayMode
  attention: AttentionItem[]
  timeline: TimelineLayout
  ranked: RankedTask[]
  due: LinearIssue[]
  planning: LinearIssue[]
  week: DayLoad[]
  sync: SyncState
  /** Number of committed issues beyond the five shown. */
  moreCommitted: number
}

const EMPTY_TIMELINE: TimelineLayout = {
  allDay: [],
  rows: [],
  bookedMinutes: 0,
  freeMinutes: 0,
}

async function settle<T>(p: Promise<T>, fallback: T): Promise<[T, SourceHealth]> {
  try {
    return [await p, 'ok']
  } catch {
    return [fallback, 'failed']
  }
}

export async function buildDashboard(
  display: DisplayMode = 'default',
  now: Date = new Date(),
): Promise<DashboardModel> {
  const todayKey = toDateKey(now)
  const weekKeys = weekdaysOf(todayKey)

  // Fetched together rather than in sequence: three round trips, not three waterfalls.
  const [[issues, linearHealth], [todayEvents, graphHealth], [weekEvents]] = await Promise.all([
    settle<LinearIssue[]>(fetchIssues(), []),
    settle<CalendarEvent[]>(fetchEventsForDay(todayKey), []),
    settle<Record<string, CalendarEvent[]>>(fetchEventsForWeek(weekKeys), {}),
  ])

  // Meeting↔issue links are model-matched (round-2 answer 5d) and cached. This is the
  // input that lets a reason line say "needed before the 10:30 sync" rather than only
  // repeating a date. If matching fails, ranking degrades to dates and still works —
  // it must never be able to take the page down.
  const meetingLinks = await matchIssuesToMeetings(todayEvents, issues).catch(
    () => new Map<string, { eventId: string; eventSubject: string }>(),
  )

  const ranked = rankTasks(issues, { todayKey, meetingLinks })

  const timeline =
    graphHealth === 'ok' ? buildTimeline(todayEvents, now, { nowOnward: display === 'board' }) : EMPTY_TIMELINE

  return {
    todayKey,
    now,
    display,
    attention: buildAttention({ issues, events: todayEvents, todayKey, now }),
    timeline,
    ranked,
    due: dueThisWeek(issues, weekKeys, todayKey),
    planning: needsPlanning(issues),
    week: buildWeekLoad(weekEvents, todayKey),
    moreCommitted: Math.max(0, ranked.length - 5),
    sync: {
      lastSyncedAt: syncedAt(),
      sources: {
        linear: health('linear:', linearHealth),
        graph: health('graph:', graphHealth),
        // Enrichment sources are consulted lazily by the drill-in, not on page load.
        omni: process.env.OMNI_API_KEY ? 'ok' : 'failed',
        brain: process.env.BRAIN_API_KEY ? 'ok' : 'failed',
      },
    },
  }
}

function syncedAt(): string | null {
  const t = newestStoredAt(['linear:issues', `graph:day:${toDateKey(new Date())}`])
  return t ? new Date(t).toISOString() : null
}

/** A source that answered but from an old cache is stale, not healthy (PRD §9). */
function health(prefix: string, fetched: SourceHealth): SourceHealth {
  if (fetched === 'failed') return 'failed'
  const t = newestStoredAt([prefix + 'issues', prefix + 'day:' + toDateKey(new Date())])
  if (t && Date.now() - t > STALE_AFTER_MS) return 'stale'
  return 'ok'
}
