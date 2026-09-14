'use client'

import { useEffect, useState } from 'react'
import { TID, testid } from '@/lib/testids'
import { formatTime } from '@/lib/time'
import styles from './zones.module.css'

export interface ClockProps {
  /**
   * The instant the server drew this render. Seeds the display so the first client
   * render matches the markup, then the component keeps its own time.
   */
  nowMs: number
}

/** Milliseconds until the top of the next minute. */
function untilNextMinute(from: number): number {
  return 60_000 - (from % 60_000)
}

/**
 * The wall clock, beside the sentence (PRD §4, §9).
 *
 * The sentence talks about *now* — "the afternoon has only a narrow working window",
 * "already late" — and until this existed the page never said which now it meant. On a
 * monitor glanced at from across the room that is the difference between reading a
 * statement and reading a claim, and it is the fastest way to catch a page that has
 * stopped refreshing: the prose can be subtly wrong and look fine, but a clock stuck at
 * 15:42 is unmistakable.
 *
 * Serif, one step above the prose it sits beside, in the quiet ink — large enough to
 * read at a glance and light enough not to compete with the sentence for the eye.
 *
 * **Fixed to Europe/Amsterdam**, like everything else here (§17.4): this reads the
 * browser's instant but never the browser's zone, so a laptop on another continent still
 * shows the time the calendar was drawn in.
 *
 * It ticks on the minute boundary rather than every 60 seconds from mount, so it never
 * sits a beat behind the timeline's now-rule. Seconds are deliberately absent: nothing on
 * this page changes in under a minute, and a second hand would be the only element
 * demanding continuous attention.
 */
export default function Clock({ nowMs }: ClockProps) {
  const [ms, setMs] = useState(nowMs)

  // A poll hands down a fresh instant; adopt it during render rather than in an effect,
  // so the clock is never painted one frame behind the data beside it.
  const [seed, setSeed] = useState(nowMs)
  if (seed !== nowMs) {
    setSeed(nowMs)
    setMs(nowMs)
  }

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>

    const schedule = () => {
      timeout = setTimeout(() => {
        setMs(Date.now())
        schedule()
      }, untilNextMinute(Date.now()))
    }
    schedule()

    return () => clearTimeout(timeout)
  }, [])

  const label = formatTime(new Date(ms))

  return (
    <time className={`${styles.clock} num`} dateTime={label} {...testid(TID.clock)}>
      {label}
    </time>
  )
}
