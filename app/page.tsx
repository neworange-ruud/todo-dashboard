import Shell from '@/components/Shell'
import Bar from '@/components/Bar'
import Attention from '@/components/Attention'
import Sentence from '@/components/Sentence'
import Timeline from '@/components/Timeline'
import TopFive from '@/components/TopFive'
import Week from '@/components/Week'
import Horizons from '@/components/Horizons'
import DrillPanel from '@/components/DrillPanel'
import { buildDashboard } from '@/lib/view-model'
import { generateSentence } from '@/lib/ai/sentence'
import { addDays, resolveViewDate, startOfLocalDay } from '@/lib/time'
import { POLL_MS, TIMEZONE } from '@/lib/config'
import type { DisplayMode } from '@/lib/types'

/**
 * The landing view (PRD §3).
 *
 * A Server Component: every source is read on the server, composed by `buildDashboard`,
 * and handed to presentational components. Only the timeline, the switcher and the
 * drill-in are client code, because only they need to react to anything.
 */

// The dashboard is a live reading of external systems; never statically cached.
export const dynamic = 'force-dynamic'

/** `WEDNESDAY` — the zone label for a day that is not today. */
function weekdayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'long' })
    .format(startOfLocalDay(dateKey))
    .toUpperCase()
}

function formatDateLabel(todayKey: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(startOfLocalDay(todayKey))
}

/**
 * A dashboard address carrying both flags.
 *
 * Plain links, resolved on the server: date navigation is a change of subject, not an
 * interaction, so it wants a new render rather than client state — and it keeps working
 * with JavaScript off, which the wall monitor occasionally appreciates.
 */
function href(display: DisplayMode, dateKey: string | null): string {
  const search = new URLSearchParams()
  if (display === 'board') search.set('display', 'board')
  if (dateKey) search.set('date', dateKey)
  const query = search.toString()
  return query ? `/?${query}` : '/'
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ display?: string; date?: string }>
}) {
  // Board mode is an explicit flag, never inferred from viewport width (PRD §17.13).
  const { display: displayParam, date: dateParam } = await searchParams
  const display: DisplayMode = displayParam === 'board' ? 'board' : 'default'

  // `?date=` moves the whole dashboard to another day (PRD §17.14). Anything unreadable
  // resolves to today rather than erroring — see `resolveViewDate`.
  const view = resolveViewDate(dateParam)

  // One instant for the whole render, threaded down to the two components that show it.
  // Reading the clock twice would let the bar and the sentence disagree by a minute.
  const renderedAt = new Date()
  const model = await buildDashboard(display, renderedAt, view.key)

  // Carried into every link the zones write, so opening a drill-in from a preview of
  // Monday does not drop the dashboard back onto today behind the panel.
  const viewParams = { display, date: view.isToday ? null : view.key }

  // The sentence is the one zone allowed to fail without taking the page with it:
  // it is generated, not fetched, and PRD §4 says silence is never acceptable — so a
  // failure falls through to the deterministic sentence inside generateSentence, and
  // a total failure here still renders the rest of the dashboard.
  const sentence = await generateSentence(model).catch(() => null)

  return (
    <Shell display={display}>
      {/*
        The bar's marker polls: it re-runs this Server Component on an interval so a page
        left open does not keep asserting a finished meeting and a closed task (PRD §9,
        §15.3). `router.refresh()` re-renders rather than remounting, so the open cascade
        does not replay and an open drill-in survives the poll (§17.13).
      */}
      <Bar
        dateLabel={formatDateLabel(model.todayKey)}
        sync={model.sync}
        nowMs={renderedAt.getTime()}
        pollMs={POLL_MS}
        isToday={model.isToday}
        nav={{
          previous: href(display, addDays(model.todayKey, -1)),
          next: href(display, addDays(model.todayKey, 1)),
          today: href(display, null),
        }}
      />

      {/* Zone 1 renders nothing at all when nothing qualifies — zero height, not collapsed. */}
      <Attention items={model.attention} view={viewParams} />

      <Sentence
        sentence={sentence}
        loading={sentence === null}
        view={viewParams}
        nowMs={renderedAt.getTime()}
      />

      <Horizons
        today={
          <>
            <Timeline
              layout={model.timeline}
              now={model.now}
              mode={display}
              view={viewParams}
              isToday={model.isToday}
              heading={model.isToday ? 'TODAY' : weekdayLabel(model.todayKey)}
            />
            <TopFive tasks={model.ranked} mode={display} view={viewParams} />
          </>
        }
        week={
          <Week
            load={model.week}
            due={model.due}
            planning={model.planning}
            todayKey={model.todayKey}
            mode={display}
            view={viewParams}
          />
        }
      />

      {/*
        The drill-in reads its own state from `?drill=`, so it is mounted once here and
        stays out of the data path above — opening a panel never re-runs the page.
        It renders nothing until the query param appears.
      */}
      <DrillPanel dateKey={view.isToday ? null : view.key} />
    </Shell>
  )
}
