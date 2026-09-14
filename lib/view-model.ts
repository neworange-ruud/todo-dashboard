import 'server-only'
import { fetchIssues } from './linear/client'
import { fetchEventsForDay, fetchEventsForWeek } from './graph/calendar'
import { rankTasks } from './domain/ranking'
import { dueThisWeek, needsPlanning } from './domain/states'
import { buildTimeline } from './domain/timeline'
import { buildWeekLoad } from './domain/week'
import { buildAttention } from './domain/attention'
import { NOMINAL_WORKDAY_MINUTES } from './domain/shape'
import { matchIssuesToMeetings } from './ai/matching'
import { startOfLocalDay, toDateKey, weekdaysOf } from './time'
import { newestStoredAtPrefix } from './cache'
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
  /**
   * The day being drawn. Named for the common case; with `?date=` in play it is the
   * viewed day, and {@link DashboardModel.isToday} is what says which.
   */
  todayKey: string
  now: Date
  display: DisplayMode
  /** False when a date override is in effect — the one thing the bar must never hide. */
  isToday: boolean
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
  availableMinutes: NOMINAL_WORKDAY_MINUTES,
}

async function settle<T>(p: Promise<T>, fallback: T): Promise<[T, SourceHealth]> {
  try {
    return [await p, 'ok']
  } catch {
    return [fallback, 'failed']
  }
}

/**
 * @param dateKey The day to draw. Defaults to today; supplied by `?date=` (PRD §17.14),
 *   which is a genuine change of subject rather than a filter — every zone below follows
 *   it, and only the clock stays real.
 */
export async function buildDashboard(
  display: DisplayMode = 'default',
  now: Date = new Date(),
  dateKey?: string,
): Promise<DashboardModel> {
  const realTodayKey = toDateKey(now)
  const todayKey = dateKey ?? realTodayKey
  const isToday = todayKey === realTodayKey
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
    graphHealth === 'ok'
      ? buildTimeline(todayEvents, now, { nowOnward: display === 'board', dateKey: todayKey })
      : EMPTY_TIMELINE

  return {
    todayKey,
    now,
    display,
    isToday,
    // On a preview the reference instant moves to that day's midnight and the conflict
    // horizon opens to the whole day, so the strip answers "what already looks wrong about
    // Monday" instead of the four-hour question, which only today can be asked.
    attention: buildAttention({
      issues,
      events: todayEvents,
      todayKey,
      now: isToday ? now : startOfLocalDay(todayKey),
      ...(isToday ? {} : { horizonHours: 24 }),
    }),
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

/**
 * When a source last answered for real.
 *
 * Asked by *prefix* rather than by key. The previous form spelled Graph's key as
 * `graph:day:<today>`, which the calendar fetcher has never written — it writes
 * `graph:events:day:<key>` — so the marker silently reported Linear's timestamp alone
 * and Graph could never register as stale. A prefix also survives `?date=`, where the
 * day actually fetched is not today's.
 */
function syncedAt(): string | null {
  const times = [newestStoredAtPrefix('linear:'), newestStoredAtPrefix('graph:')].filter(
    (t): t is number => t !== null,
  )
  return times.length ? new Date(Math.max(...times)).toISOString() : null
}

/** A source that answered but from an old cache is stale, not healthy (PRD §9). */
function health(prefix: 'linear:' | 'graph:', fetched: SourceHealth): SourceHealth {
  if (fetched === 'failed') return 'failed'
  const t = newestStoredAtPrefix(prefix)
  if (t && Date.now() - t > STALE_AFTER_MS) return 'stale'
  return 'ok'
}
