'use client'

import { useState, type ReactNode } from 'react'
import Switcher, { type Horizon } from './Switcher'
import { TID } from '@/lib/testids'
import styles from './horizons.module.css'

/**
 * Holds the mobile horizon selection (PRD §3).
 *
 * Both zones are always rendered on the server and both stay in the DOM; the switcher
 * only decides which is *shown* below 1000px. Above that the switcher is hidden by CSS
 * and both columns are visible — "one layout, three sizes; only the column count
 * changes" (principle 6). Nothing is fetched twice and nothing re-renders on switch.
 */
export default function Horizons({ today, week }: { today: ReactNode; week: ReactNode }) {
  const [horizon, setHorizon] = useState<Horizon>('today')

  return (
    <>
      <Switcher value={horizon} onChange={setHorizon} />
      <div className={styles.horizons} data-horizon={horizon}>
        <section {...{ 'data-testid': TID.today }} className={styles.horizonToday} data-zone="today">
          {today}
        </section>
        {/* The zone test ids live on Week and Timeline themselves, not on these
            wrappers — two elements sharing one id makes every selector ambiguous. */}
        <section className={styles.horizonWeek} data-zone="week">
          {week}
        </section>
      </div>
    </>
  )
}
