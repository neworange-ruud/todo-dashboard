'use client'

import { useState } from 'react'

import { TID, testid } from '@/lib/testids'
import { formatDayMonth } from '@/lib/time'
// The runtime value comes from the client-safe module; the rest are type-only and are
// erased at build time, so the server-only drill module never reaches the browser.
import { BLOCK_SOURCE_LABELS } from '@/lib/drill/blocks'
import type { DrillBlockId, DrillType } from '@/lib/drill/blocks'
import type {
  AccountData,
  ActionItemRow,
  AttendeeRow,
  ProseData,
} from '@/lib/drill/meeting'
import type { IssueDetail, MailRow, MeetingRow } from '@/lib/drill/issue'
import type { DrillBlock as DrillBlockModel, SourceRef } from '@/lib/types'
import styles from './drill.module.css'

/**
 * One block of a drill-in (PRD §8).
 *
 * Two shapes and no third: *Attendees* and *Open action items* are rows because they are
 * lists; *Last time* and *Unresolved* are paragraphs because their meaning lives in the
 * connective tissue. "Never a wall of bullets, never an undifferentiated essay."
 *
 * The header carries the block's own state on the right — *Checking CRM…* in flight, a
 * timing once done, *Nothing found* if empty, *Could not reach CRM · Retry* if failed. The
 * retry re-runs this block alone: the panel fetches per block, so nothing else is disturbed.
 *
 * `data-block-id` and `data-block-status` are read by the e2e specs and are part of the
 * contract; do not rename them without updating tests/e2e/drill-in.spec.ts.
 */

export interface DrillBlockProps {
  block: DrillBlockModel<unknown>
  onRetry: () => void
  /**
   * Drilling from a drill-in pushes onto the trail — it never opens a second panel.
   *
   * Includes `meeting`, so a task's *Meetings* row can hop to that meeting's own panel.
   * It must go through this callback rather than through an `<a href="?drill=…">`: a
   * query-only link replaces the whole query string, which throws the trail away and
   * lands the reader in a one-crumb panel with no way back to the task.
   */
  onDrill?: (type: DrillType, id: string) => void
  /** What this block is about, e.g. `meeting:AAMk…` — recorded with any feedback. */
  subject?: string
}

/** Blocks whose content is written by the model, and so can be wrong (PRD §9). */
const SYNTHESISED: ReadonlySet<string> = new Set(['last-time', 'unresolved', 'said'])

export default function DrillBlock({ block, onRetry, onDrill, subject }: DrillBlockProps) {
  const failed = block.status === 'failed'
  const pending = block.status === 'pending' || block.status === 'loading'
  const [dismissed, setDismissed] = useState(false)

  // Only synthesised prose carries the controls; rows read straight from Outlook or
  // Linear cannot be "wrong" in the sense §9 means.
  const canCorrect = SYNTHESISED.has(block.id) && block.status === 'ok'

  async function send(kind: 'regenerate' | 'not-right') {
    if (kind === 'not-right') setDismissed(true)
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          subject: subject ?? 'unknown',
          blockId: block.id,
          output: proseOf(block),
        }),
      })
    } catch {
      // The log is best-effort; never interrupt the reader over it.
    }
    if (kind === 'regenerate') onRetry()
  }

  // Dismissing hides the block for this item for the day (PRD §9).
  if (dismissed) return null

  return (
    <section
      className={`${styles.block} ${failed ? `${styles.blockFailed} stripe` : ''}`}
      data-block-id={block.id}
      data-block-status={block.status}
      aria-busy={pending}
      {...testid(TID.panelBlock)}
    >
      <header className={styles.blockHeader}>
        <h3 className={styles.blockTitle}>{block.title}</h3>
        <span
          className={`${styles.blockStatus} ${failed ? styles.statusFailed : ''}`}
          {...testid(TID.panelBlockStatus)}
        >
          <span>{statusText(block)}</span>
          {failed && (
            <>
              <span aria-hidden>·</span>
              <button type="button" className={styles.retry} onClick={onRetry}>
                Retry
              </button>
            </>
          )}
          {canCorrect && (
            <span className={styles.correct}>
              {/* Quiet: revealed on hover or focus, never competing with the content. */}
              <button
                type="button"
                className={styles.retry}
                onClick={() => void send('regenerate')}
                title="Regenerate this block"
              >
                ↻ Regenerate
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                className={styles.retry}
                onClick={() => void send('not-right')}
                title="Hide this block for today and record what it said"
              >
                ⊘ Not right
              </button>
            </span>
          )}
        </span>
      </header>

      <div className={`${styles.blockBody} ${pending ? '' : styles.arrive}`}>
        {pending ? <Skeleton id={block.id} /> : <Body block={block} onDrill={onDrill} />}
      </div>
    </section>
  )
}


/** The prose a synthesised block produced, so the feedback log is reviewable later. */
function proseOf(block: DrillBlockModel<unknown>): string {
  const data = block.data as { prose?: unknown } | undefined
  return typeof data?.prose === 'string' ? data.prose : ''
}

// ---------------------------------------------------------------------------
// Header state
// ---------------------------------------------------------------------------

/** *Checking Omni…* / `1.2s` / *Nothing found* / *Could not reach Omni*. */
export function statusText(block: DrillBlockModel<unknown>): string {
  const source = BLOCK_SOURCE_LABELS[block.id] ?? 'source'
  switch (block.status) {
    case 'pending':
    case 'loading':
      return `Checking ${source}…`
    case 'ok':
      return formatElapsed(block.elapsedMs)
    case 'empty':
      return 'Nothing found'
    case 'failed':
      return block.error?.trim() || `Could not reach ${source}`
  }
}

/** Sub-second work reads in milliseconds; anything slower reads in seconds. */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'Done'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ---------------------------------------------------------------------------
// Skeletons — the container is already the right size (PRD §11)
// ---------------------------------------------------------------------------

const SKELETON_LINES: Record<DrillBlockId, number> = {
  attendees: 3,
  'last-time': 3,
  'action-items': 2,
  account: 2,
  unresolved: 3,
  'issue-detail': 3,
  said: 3,
  'related-issues': 2,
  meetings: 2,
  email: 2,
}

function Skeleton({ id }: { id: DrillBlockId }) {
  const lines = SKELETON_LINES[id] ?? 2
  return (
    <div className={styles.skeleton} {...testid(TID.skeleton)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={styles.skeletonLine} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function Body({
  block,
  onDrill,
}: {
  block: DrillBlockModel<unknown>
  onDrill?: DrillBlockProps['onDrill']
}) {
  // Empty and failed say everything they have to say in the header; a second sentence in
  // the body would be the panel repeating itself.
  if (block.status !== 'ok') return null

  switch (block.id) {
    case 'attendees':
      return <Attendees rows={(block.data as AttendeeRow[]) ?? []} onDrill={onDrill} />
    case 'action-items':
      return <ActionItems rows={(block.data as ActionItemRow[]) ?? []} onDrill={onDrill} />
    case 'account':
      return <Account data={block.data as AccountData} />
    case 'last-time':
    case 'unresolved':
    case 'said':
      return <Prose data={block.data as ProseData} sources={block.sources ?? []} />
    case 'issue-detail':
      return <Detail data={block.data as IssueDetail} sources={block.sources ?? []} />
    case 'related-issues':
      return <ActionItems rows={(block.data as ActionItemRow[]) ?? []} onDrill={onDrill} />
    case 'meetings':
      return <Meetings rows={(block.data as MeetingRow[]) ?? []} onDrill={onDrill} />
    case 'email':
      return <Mail rows={(block.data as MailRow[]) ?? []} />
  }
}

function Attendees({
  rows,
  onDrill,
}: {
  rows: AttendeeRow[]
  onDrill?: DrillBlockProps['onDrill']
}) {
  return (
    <div className={styles.rows}>
      {rows.map((row) => {
        const meta = [row.role, row.company, row.lastContact].filter(Boolean).join(' · ')
        const body = (
          <>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>
                {row.name}
                {row.isOrganizer ? ' — organiser' : ''}
              </span>
              <span className={styles.rowMeta}>{meta || row.email}</span>
            </span>
            <span
              className={`${styles.rowRight} ${row.isInternal ? styles.tag : styles.tagExternal}`}
            >
              {row.isInternal ? 'Internal' : 'External'}
            </span>
          </>
        )

        return onDrill ? (
          <button
            key={row.email}
            type="button"
            className={`${styles.row} ${styles.rowButton} list-row`}
            data-drill={`person:${row.email}`}
            onClick={() => onDrill('person', row.email)}
          >
            {body}
          </button>
        ) : (
          <div key={row.email} className={`${styles.row} list-row`}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

function ActionItems({
  rows,
  onDrill,
}: {
  rows: ActionItemRow[]
  onDrill?: DrillBlockProps['onDrill']
}) {
  return (
    <div className={styles.rows}>
      {rows.map((row) => {
        const meta = [row.owner, row.dueDate ? `due ${row.dueDate}` : null]
          .filter(Boolean)
          .join(' · ')
        const body = (
          <>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>
                {row.identifier} {row.title}
              </span>
              {meta && <span className={styles.rowMeta}>{meta}</span>}
            </span>
            <span className={styles.rowRight}>{row.state}</span>
          </>
        )

        return onDrill ? (
          <button
            key={row.identifier}
            type="button"
            className={`${styles.row} ${styles.rowButton} list-row`}
            data-drill={`issue:${row.identifier}`}
            onClick={() => onDrill('issue', row.identifier)}
          >
            {body}
          </button>
        ) : (
          <div key={row.identifier} className={`${styles.row} list-row`}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

function Account({ data }: { data: AccountData | undefined }) {
  if (!data) return null
  const meta = [data.stage, data.health].filter(Boolean).join(' · ')

  return (
    <div className={styles.rows}>
      <div className={styles.row}>
        <span className={styles.rowMain}>
          <span className={styles.rowTitle}>{data.companyName}</span>
          {meta && <span className={styles.rowMeta}>{meta}</span>}
        </span>
      </div>

      {data.openOpportunities.map((opp, i) => (
        <div key={opp.id ?? `${opp.title}-${i}`} className={styles.row}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{opp.title}</span>
            {opp.status && <span className={styles.rowMeta}>{opp.status}</span>}
          </span>
          {opp.amount && <span className={`${styles.rowRight} num`}>{opp.amount}</span>}
        </div>
      ))}

      {data.lastInvoice && (
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>Invoice {data.lastInvoice.number}</span>
            <span className={styles.rowMeta}>
              {[data.lastInvoice.status, data.lastInvoice.date].filter(Boolean).join(' · ')}
            </span>
          </span>
          {data.lastInvoice.total && (
            <span className={`${styles.rowRight} num`}>
              {data.lastInvoice.currency} {data.lastInvoice.total}
            </span>
          )}
        </div>
      )}

      {/* A sub-query that failed names itself rather than passing as an empty list. */}
      {data.partial.length > 0 && (
        <p className={styles.rowMeta}>No access to {data.partial.join(', ')}.</p>
      )}
    </div>
  )
}

function Prose({ data, sources }: { data: ProseData | undefined; sources: SourceRef[] }) {
  if (!data) return null
  const paragraphs = data.prose.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)

  return (
    <div>
      {paragraphs.map((p, i) => (
        <p key={i} className={`${styles.prose} voice-written`}>
          {p}
        </p>
      ))}
      <Sources sources={sources} inferred={data.inferred} />
    </div>
  )
}


// ---------------------------------------------------------------------------
// Issue panel bodies (PRD §8, "Other drill-in types")
// ---------------------------------------------------------------------------

const ORIGIN_WORDS: Record<string, string> = {
  fireflies: 'a meeting recording',
  outlook: 'an email',
  outlook_calendar: 'a calendar item',
  slack: 'a Slack message',
  local_files: 'a file',
}

/**
 * Block 1 — the task itself.
 *
 * The one block in this panel that cannot fail: it is Linear data the page already holds.
 * Its job is to state the facts and, when the task was machine-extracted, to say so —
 * "Written down from a meeting recording, 11 Sep" with a link to the recording. A reader
 * who knows a task was transcribed from a call reads everything below it differently.
 */
function Detail({ data, sources }: { data: IssueDetail | undefined; sources: SourceRef[] }) {
  if (!data) return null

  const facts = [
    data.state,
    data.dueDate ? `due ${data.dueDate}` : null,
    data.hasRelations ? 'has relations' : null,
  ].filter(Boolean)

  return (
    <div>
      <p className={styles.rowMeta}>{facts.join(' · ')}</p>

      {/*
        Labelled parts, each with its own quiet heading. The pipeline writes an outcome and
        a completion criterion; the panel is the place that has to make them readable.
      */}
      {data.sections.map((section, i) => (
        <div key={`${section.label ?? 'body'}-${i}`} className={styles.section}>
          {section.label && <h4 className={styles.sectionLabel}>{section.label}</h4>}
          <p className={`${styles.prose} voice-written`}>{section.body}</p>
        </div>
      ))}

      {data.labels.length > 0 && (
        <p className={styles.rowMeta}>{data.labels.join(' · ')}</p>
      )}

      {data.origin && (
        <p className={styles.rowMeta}>
          Written down from {ORIGIN_WORDS[data.origin.sourceType] ?? data.origin.sourceType}
          {data.origin.evidenceDate ? ` on ${data.origin.evidenceDate}` : ''}.
        </p>
      )}

      <Sources sources={sources} inferred={false} />
    </div>
  )
}

/** `28 Aug`, or `30 Oct 2025` once it is not this year. Shared with the source labels. */
const when = (iso: string | null) => formatDayMonth(iso)

/**
 * Block 4 — the meetings this task was discussed in, past and upcoming.
 *
 * A row whose calendar event Omni recorded is a **drill target**: clicking it opens that
 * meeting's own panel on the trail, which is the trail PRD §8 describes running the other
 * way — meeting → issue → back to the meeting it came out of.
 */
function Meetings({
  rows,
  onDrill,
}: {
  rows: MeetingRow[]
  onDrill?: DrillBlockProps['onDrill']
}) {
  return (
    <div className={styles.rows}>
      {rows.map((row, i) => {
        const meta = [when(row.date), row.participants.length ? `${row.participants.length} in the room` : null]
          .filter(Boolean)
          .join(' · ')
        const body = (
          <>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle} title={row.title}>
                {row.title}
              </span>
              {meta && <span className={styles.rowMeta}>{meta}</span>}
            </span>
            <span className={styles.rowRight}>{row.upcoming ? 'Upcoming' : 'Past'}</span>
          </>
        )

        // Pushes onto the trail; never a link, which would replace the query string and
        // take the trail with it.
        return row.eventId && onDrill ? (
          <button
            key={`${row.title}-${i}`}
            type="button"
            className={`${styles.row} ${styles.rowButton} list-row`}
            data-drill={`meeting:${row.eventId}`}
            onClick={() => onDrill('meeting', row.eventId!)}
          >
            {body}
          </button>
        ) : row.url ? (
          <a
            key={`${row.title}-${i}`}
            className={`${styles.row} ${styles.rowButton} list-row`}
            href={row.url}
            target="_blank"
            rel="noreferrer"
          >
            {body}
          </a>
        ) : (
          <div key={`${row.title}-${i}`} className={`${styles.row} list-row`}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

/** Block 5 — the mail threads this task turns up in. Each row opens in Outlook. */
function Mail({ rows }: { rows: MailRow[] }) {
  return (
    <div className={styles.rows}>
      {rows.map((row, i) => {
        const meta = [row.from, when(row.date)].filter(Boolean).join(' · ')
        const body = (
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{row.subject}</span>
            {meta && <span className={styles.rowMeta}>{meta}</span>}
            {row.excerpt && <span className={styles.rowExcerpt}>{row.excerpt}</span>}
          </span>
        )
        return row.url ? (
          <a
            key={`${row.subject}-${i}`}
            className={`${styles.row} ${styles.rowButton} list-row`}
            href={row.url}
            target="_blank"
            rel="noreferrer"
          >
            {body}
          </a>
        ) : (
          <div key={`${row.subject}-${i}`} className={`${styles.row} list-row`}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sourcing (PRD §8)
// ---------------------------------------------------------------------------

const VISIBLE_SOURCES = 2

/**
 * `↗ Meeting notes, 28 Aug` in accent mono.
 *
 * More than two collapse behind a count and expand on tap — understated enough to ignore
 * while reading, present enough to check when a claim surprises you. A statement the model
 * could not source is marked *inferred* rather than dropped: a visibly hedged guess is more
 * useful than a confident invention, and far more useful than silence.
 */
export function Sources({ sources, inferred }: { sources: SourceRef[]; inferred: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (sources.length === 0 && !inferred) return null

  const shown = expanded ? sources : sources.slice(0, VISIBLE_SOURCES)
  const hidden = sources.length - shown.length

  return (
    <div className={styles.sources}>
      {inferred && <span className={styles.inferred}>Inferred</span>}
      {shown.map((source, i) =>
        source.url ? (
          <a
            key={`${source.label}-${i}`}
            className={styles.source}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            {...testid(TID.sourceRef)}
          >
            ↗ {source.label}
          </a>
        ) : (
          <span key={`${source.label}-${i}`} className={styles.source} {...testid(TID.sourceRef)}>
            ↗ {source.label}
          </span>
        ),
      )}
      {hidden > 0 && (
        <button
          type="button"
          className={`${styles.source} ${styles.sourceMore}`}
          onClick={() => setExpanded(true)}
        >
          +<span className="num">{hidden}</span> more
        </button>
      )}
    </div>
  )
}
