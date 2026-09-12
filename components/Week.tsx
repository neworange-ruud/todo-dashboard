import { isNew, provenanceOf } from '@/lib/domain/states'
import { TID, testid } from '@/lib/testids'
import { daysBetween, dueLabel, formatDuration } from '@/lib/time'
import type { DayLoad, DisplayMode, LinearIssue, TaskState } from '@/lib/types'
import styles from './zones.module.css'

export interface WeekProps {
  load: DayLoad[]
  /** Already soonest-first (`lib/domain/states.dueThisWeek`). Rendered in the order given. */
  due: LinearIssue[]
  /** Ready then Inbox (`lib/domain/states.needsPlanning`). Rendered in the order given. */
  planning: LinearIssue[]
  todayKey: string
  /** Presentation profile (PRD §17.13). Board caps each block at three rows. */
  mode?: DisplayMode
  /**
   * Set when a source this zone depends on is unreachable. The cached rows keep
   * rendering behind the notice (PRD §9).
   */
  unavailable?: { source: string; since?: string }
}

/**
 * Board mode is the one place the §17.5 caps return. Both lists still *say* how long
 * they are in their header, so nothing is hidden — only undrawn (PRD §17.13).
 */
const BOARD_ROWS = 3

/** See the matching note in `TopFive.tsx`: one line, 2px stripe, content stays (PRD §9). */
function UnavailableLine({ source, since }: { source: string; since?: string }) {
  return (
    <p className={`${styles.unavailable} stripe`} data-testid="zone-unavailable" role="status">
      <span className={styles.unavailableText}>
        {source} unreachable
        {since ? ` · showing data from ${since}` : ''}
      </span>
      <a className={styles.unavailableRetry} href="">
        Retry
      </a>
    </p>
  )
}

type Urgency = 'none' | 'risk' | 'critical'

/** Due within two days is at risk; already past is critical (PRD §7). */
function urgencyOf(dueDate: string | null, todayKey: string): Urgency {
  if (!dueDate) return 'none'
  const days = daysBetween(dueDate, todayKey)
  if (days < 0) return 'critical'
  if (days <= 2) return 'risk'
  return 'none'
}

function isStarted(state: TaskState): boolean {
  return state === 'In Progress' || state === 'Waiting'
}

/**
 * Zone 4 — the week (PRD §7, §17.5, §17.6).
 *
 * Three blocks, in the order the week is actually read: where is my room, what is
 * owed, and what have I not decided yet.
 *
 * **Load lanes.** One bar per weekday, split booked / free. No grid, no titles, no
 * times — a five-day calendar at this size is unreadable and duplicates Outlook. A
 * day above ~70% booked draws its booked portion in the warning hue and is the only
 * colour in the zone; the exact minutes live in the bar's accessible label, because a
 * visible number here would be a count nobody asked for.
 *
 * **The dot does two jobs at once** in Due this week: shape is state (filled = started)
 * and colour is urgency. That is legitimate here precisely because there is no reason
 * line beside it to carry the urgency in words, which is why the top five does the
 * opposite.
 *
 * Both lists render whole — the `⌄ N more` caps are removed at real volumes (§17.5).
 * Board mode is the single exception: it draws three rows per block and lets the
 * header's named count carry the rest, because 720px is a hard constraint (§17.13).
 */
export default function Week({
  load,
  due,
  planning,
  todayKey,
  mode = 'default',
  unavailable,
}: WeekProps) {
  const readyCount = planning.filter((issue) => !isNew(issue)).length
  const newCount = planning.length - readyCount

  const board = mode === 'board'
  const visibleDue = board ? due.slice(0, BOARD_ROWS) : due
  const visiblePlanning = board ? planning.slice(0, BOARD_ROWS) : planning

  return (
    <div className={styles.week} {...testid(TID.week)}>
      {unavailable && <UnavailableLine {...unavailable} />}

      <section className={styles.block}>
        <div className={styles.zoneHead}>
          <h2 className={styles.zoneLabel}>THIS WEEK</h2>
        </div>
        <div className={styles.lanes} {...testid(TID.loadLanes)}>
          {load.map((day) => {
            const share = Math.min(100, Math.round((day.bookedMinutes / day.workdayMinutes) * 100))
            return (
              <div
                key={day.date}
                className={styles.lane}
                data-today={day.isToday ? 'true' : 'false'}
                data-heavy={day.isHeavy ? 'true' : 'false'}
                {...testid(TID.loadLane)}
              >
                <span className={styles.laneLabel}>{day.label}</span>
                <span
                  className={styles.laneTrack}
                  role="img"
                  aria-label={`${day.label}: ${formatDuration(day.bookedMinutes)} booked of ${formatDuration(day.workdayMinutes)}`}
                >
                  <span
                    className={styles.laneBooked}
                    style={{ width: `${share}%` }}
                    data-heavy={day.isHeavy ? 'true' : 'false'}
                  />
                </span>
              </div>
            )
          })}
        </div>
      </section>

      <section className={styles.block} {...testid(TID.dueThisWeek)}>
        <div className={styles.zoneHead}>
          <h2 className={styles.zoneLabel}>DUE THIS WEEK</h2>
          {/* A count inside a named header is fine; a bare badge is not (PRD §9). */}
          <span className={`${styles.blockCount} num`}>{due.length}</span>
        </div>
        {due.length === 0 ? (
          <p className={styles.empty}>Nothing due before the weekend.</p>
        ) : (
          <ul className={styles.list}>
            {visibleDue.map((issue) => {
              const urgency = urgencyOf(issue.dueDate, todayKey)
              return (
                <li
                  key={issue.identifier}
                  className={`${styles.dueRow} list-row crossfade`}
                  {...testid(TID.dueRow)}
                >
                  <a href={`?drill=issue:${issue.identifier}`} className={styles.dueMain}>
                    <span
                      className={styles.dot}
                      data-filled={isStarted(issue.state) ? 'true' : 'false'}
                      data-urgency={urgency}
                      data-state={issue.state}
                      aria-hidden="true"
                    />
                    <span className={styles.issueKey}>{issue.identifier}</span>
                    <span className={styles.rowTitle}>{issue.title}</span>
                    <span className={`${styles.dueWhen} num`} data-urgency={urgency}>
                      {issue.dueDate ? dueLabel(issue.dueDate, todayKey) : ''}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className={styles.block} {...testid(TID.needsPlanning)}>
        <div className={styles.zoneHead}>
          <h2 className={styles.zoneLabel}>NEEDS PLANNING</h2>
          <span className={`${styles.blockCount} num`}>
            {readyCount} READY · {newCount} NEW
          </span>
        </div>
        {planning.length === 0 ? (
          <p className={styles.empty}>Nothing waiting to be planned.</p>
        ) : (
          <ul className={styles.list}>
            {visiblePlanning.map((issue) => {
              const source = provenanceOf(issue)
              return (
                <li
                  key={issue.identifier}
                  className={`${styles.planningRow} list-row crossfade`}
                  {...testid(TID.planningRow)}
                >
                  <a href={`?drill=issue:${issue.identifier}`} className={styles.planningMain}>
                    <span
                      className={styles.dot}
                      data-filled={isStarted(issue.state) ? 'true' : 'false'}
                      data-state={issue.state}
                      aria-hidden="true"
                    />
                    <span className={styles.issueKey}>{issue.identifier}</span>
                    <span className={styles.rowTitle}>{issue.title}</span>
                    {/* Fixed trailing lane, so the marker never shifts the titles. */}
                    <span className={styles.newMarker}>
                      {isNew(issue) && <span {...testid(TID.newMarker)}>*NEW</span>}
                    </span>
                  </a>
                  {/* Provenance matters more than novelty: these are the only items no human wrote. */}
                  {source && (
                    <p className={styles.rowSource}>
                      <span className={styles.sourceRef} {...testid(TID.sourceRef)}>
                        ↗ {source}
                      </span>
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
