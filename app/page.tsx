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
import { startOfLocalDay } from '@/lib/time'
import { TIMEZONE } from '@/lib/config'
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

function formatDateLabel(todayKey: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(startOfLocalDay(todayKey))
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ display?: string }>
}) {
  // Board mode is an explicit flag, never inferred from viewport width (PRD §17.13).
  const { display: displayParam } = await searchParams
  const display: DisplayMode = displayParam === 'board' ? 'board' : 'default'

  const model = await buildDashboard(display)

  // The sentence is the one zone allowed to fail without taking the page with it:
  // it is generated, not fetched, and PRD §4 says silence is never acceptable — so a
  // failure falls through to the deterministic sentence inside generateSentence, and
  // a total failure here still renders the rest of the dashboard.
  const sentence = await generateSentence(model).catch(() => null)

  return (
    <Shell display={display}>
      <Bar dateLabel={formatDateLabel(model.todayKey)} sync={model.sync} />

      {/* Zone 1 renders nothing at all when nothing qualifies — zero height, not collapsed. */}
      <Attention items={model.attention} />

      <Sentence sentence={sentence} loading={sentence === null} />

      <Horizons
        today={
          <>
            <Timeline layout={model.timeline} now={model.now} mode={display} />
            <TopFive tasks={model.ranked} mode={display} />
          </>
        }
        week={
          <Week
            load={model.week}
            due={model.due}
            planning={model.planning}
            todayKey={model.todayKey}
            mode={display}
          />
        }
      />

      {/*
        The drill-in reads its own state from `?drill=`, so it is mounted once here and
        stays out of the data path above — opening a panel never re-runs the page.
        It renders nothing until the query param appears.
      */}
      <DrillPanel />
    </Shell>
  )
}
