'use client'

import { TID, testid } from '@/lib/testids'
import styles from './zones.module.css'

export type Horizon = 'today' | 'week'

export interface SwitcherProps {
  value: Horizon
  onChange: (value: Horizon) => void
}

/**
 * The horizon switcher (PRD §3, §17.4).
 *
 * The only navigation in the product, and it exists only on phone: below 1000px the
 * sentence plus one horizon is already a full screen, so Today and Week take turns.
 * Above that the switcher dissolves in CSS and both horizons are on screen at once —
 * which is why visibility is a media query here rather than a branch in the page.
 *
 * **Exactly two segments.** Month is cut from v1: no projects, cycles or milestones
 * exist to fill it, and a third segment leading to an empty zone would be a promise
 * the product cannot keep.
 */
export default function Switcher({ value, onChange }: SwitcherProps) {
  return (
    <div className={styles.switcher} role="tablist" aria-label="Horizon" {...testid(TID.switcher)}>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'today'}
        className={styles.segment}
        onClick={() => onChange('today')}
        {...testid(TID.switcherToday)}
      >
        TODAY
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'week'}
        className={styles.segment}
        onClick={() => onChange('week')}
        {...testid(TID.switcherWeek)}
      >
        WEEK
      </button>
    </div>
  )
}
