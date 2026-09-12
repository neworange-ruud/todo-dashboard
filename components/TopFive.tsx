import { TID, testid } from '@/lib/testids'
import type { DisplayMode, RankedTask, TaskState } from '@/lib/types'
import styles from './zones.module.css'


export interface TopFiveProps {
  tasks: RankedTask[]
  /** Presentation profile (PRD §17.13). Board caps the list at three. */
  mode?: DisplayMode
  /**
   * Set when a source this zone depends on is unreachable. The cached rows keep
   * rendering behind the notice (PRD §9). Declared per zone rather than centrally
   * because the whole point of the state is that it is *local*: Linear going down
   * degrades the Linear zones and leaves the calendar alone.
   */
  unavailable?: { source: string; since?: string }
}

const MAX_ROWS = 5
/** Board mode is the one place the §17.5 caps return — 720px is a hard constraint. */
const BOARD_ROWS = 3

/** Shape carries state: filled = started work, hollow = not started (PRD §6, §17.3). */
function isStarted(state: TaskState): boolean {
  return state === 'In Progress' || state === 'Waiting'
}

/**
 * The source-down line (PRD §9).
 *
 * One inline line on a 2px critical left-stripe, above content that **keeps
 * rendering** — the cached rows behind it are still the best answer available, and
 * blanking them would trade a stale truth for no truth at all. The stripe is §10's
 * single "this needs your eye" device; the line invents no other decoration.
 */
function UnavailableLine({ source, since }: { source: string; since?: string }) {
  return (
    <p className={`${styles.unavailable} stripe`} data-testid="zone-unavailable" role="status">
      <span className={styles.unavailableText}>
        {source} unreachable
        {since ? ` · showing data from ${since}` : ''}
      </span>
      {/* An empty href re-requests this exact URL, query flag and all. */}
      <a className={styles.unavailableRetry} href="">
        Retry
      </a>
    </p>
  )
}

/**
 * Zone 3b — the top five (PRD §6, §17.2).
 *
 * The direct answer to "what do I work on today": five items at most, ranked, each
 * with its reason on the line below.
 *
 * **The reason line is not optional.** It is the entire basis of trust in the ranking —
 * a row without one is a number with no argument behind it — so it is rendered for
 * every row, unconditionally, and `TopFive.test.tsx` asserts that for every fixture.
 * An item that cannot generate a reason belongs in the full list beneath, not here,
 * and that filtering is the ranker's job rather than this component's.
 *
 * Fixed-width lanes (16px rank, 6px dot, 58px issue key) make the titles line up down
 * the column, which is what lets you read five rows as a list instead of five cards.
 * The dots stay ink-grey: the reason line already carries urgency in words, and five
 * coloured dots down the most important column buys nothing.
 */
export default function TopFive({ tasks, mode = 'default', unavailable }: TopFiveProps) {
  const rows = tasks.slice(0, MAX_ROWS)
  const visible = mode === 'board' ? rows.slice(0, BOARD_ROWS) : rows

  if (rows.length === 0) {
    return (
      <div {...testid(TID.topFive)}>
        <p className={styles.zoneLabel}>TOP FIVE</p>
        {unavailable && <UnavailableLine {...unavailable} />}
        {/*
         * Meetings but no tasks (PRD §9): one honest line pointing at the next
         * horizon rather than apologising. No illustration, no encouragement,
         * nothing invented to fill the space — whitespace is the intended outcome.
         */}
        <p className={styles.empty} {...testid(TID.topFiveEmpty)}>
          Nothing in progress or planned. The week below is where the next thing comes from.
        </p>
      </div>
    )
  }

  return (
    <div {...testid(TID.topFive)}>
      <div className={styles.zoneHead}>
        <p className={styles.zoneLabel}>TOP FIVE</p>
        {/*
         * The full length of the list, named by its header. In board mode only three
         * rows are drawn, so this count *is* how the remainder is reported — a count
         * inside a named header is fine; a bare badge is not (PRD §9).
         */}
        <span className={`${styles.blockCount} num`} data-testid="top-five-count">
          {rows.length}
        </span>
      </div>
      {unavailable && <UnavailableLine {...unavailable} />}
      <ol className={styles.list}>
        {visible.map((task) => {
          const issue = task.issue
          return (
            <li key={issue.identifier} className={`${styles.taskRow} list-row crossfade`} {...testid(TID.taskRow)}>
              <a href={`?drill=issue:${issue.identifier}`} className={styles.taskMain}>
                <span className={`${styles.rank} num`}>{task.rank}</span>
                <span
                  className={styles.dot}
                  data-filled={isStarted(issue.state) ? 'true' : 'false'}
                  data-state={issue.state}
                  aria-hidden="true"
                  {...testid(TID.taskStateDot)}
                />
                <span className={styles.issueKey}>{issue.identifier}</span>
                <span className={styles.taskTitle}>{issue.title}</span>
              </a>

              <p className={styles.reason} {...testid(TID.taskReason)}>
                {task.reason.text}
              </p>

              {(task.reason.source || task.reason.inferred) && (
                <p className={styles.taskMeta}>
                  {task.reason.source &&
                    (task.reason.source.url ? (
                      <a
                        href={task.reason.source.url}
                        className={styles.sourceRef}
                        {...testid(TID.sourceRef)}
                      >
                        ↗ {task.reason.source.label}
                      </a>
                    ) : (
                      <span className={styles.sourceRef} {...testid(TID.sourceRef)}>
                        ↗ {task.reason.source.label}
                      </span>
                    ))}
                  {/* The model could not source the claim; say so rather than imply it (PRD §8). */}
                  {task.reason.inferred && <span className={styles.inferred}>inferred</span>}
                </p>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
