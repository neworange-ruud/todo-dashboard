import type { ReactNode } from 'react'
import type { DisplayMode } from '@/lib/types'

export interface ShellProps {
  /** Explicit presentation profile threaded from `?display=board` (PRD §17.13). */
  display: DisplayMode
  children: ReactNode
}

/**
 * The page frame (PRD §3, §10, §17.13).
 *
 * A Server Component: presentational only, no data fetching. `display` is
 * read once by app/page.tsx from `searchParams` and passed down as a prop —
 * this component never branches on viewport width to infer it, because a
 * 1440x720 wall monitor is otherwise indistinguishable from a resized
 * laptop window (see the matching comment on `[data-display='board']` in
 * app/globals.css).
 *
 * `.shell` is the max-width container. `.shell__zones` supplies the
 * five-zone vertical rhythm from PRD §10 — Attention, Sentence, Today,
 * Week, and Month, separated by 32px and a hairline rule (the persistent
 * Bar sits outside this rhythm as its own fixed-height zone, zone 0 in
 * PRD §3). The 8px "within a zone" spacing belongs to each zone's own
 * component, not to Shell.
 */
export default function Shell({ display, children }: ShellProps) {
  return (
    <div className="shell" data-display={display} data-testid="shell">
      <div className="shell__zones">{children}</div>
    </div>
  )
}
