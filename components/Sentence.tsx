'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TID, testid } from '@/lib/testids'
import { fadeOut, hasSentenceChanged, runOpenCascade, writeInWords } from '@/lib/motion'
import type { DailySentence, SentenceEntity } from '@/lib/types'
import styles from './zones.module.css'

export interface SentenceProps {
  sentence: DailySentence | null
  /**
   * Renders the resolving skeleton instead of prose — but **only before the first
   * sentence has ever arrived**. A refresh never blanks and never skeletonises what is
   * already on screen (PRD §9).
   */
  loading?: boolean
}

interface Segment {
  text: string
  entity: SentenceEntity | null
}

interface Claim {
  start: number
  end: number
  entity: SentenceEntity
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u

/** True when neither edge of `[start, end)` sits inside a word. */
function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ' '
  const after = end < text.length ? text[end] : ' '
  return !WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)
}

/**
 * The first occurrence of `needle` that no earlier claim already covers.
 *
 * A whole-word match wins over a mid-word one, so an entity "Acme" never lights up
 * the middle of "Acmecorp" while a real mention sits further along the sentence.
 */
function findFreeOccurrence(text: string, needle: string, claims: Claim[]): number {
  let fallback = -1
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length
    const overlaps = claims.some((claim) => at < claim.end && end > claim.start)
    if (overlaps) continue
    if (isWholeWord(text, at, end)) return at
    if (fallback === -1) fallback = at
  }
  return fallback
}

/**
 * Split `text` into plain runs and entity runs.
 *
 * Three properties matter and each is tested:
 *
 *   - **Each entity is linkified once.** A word repeated in the prose lights up only
 *     where the entity actually points; the other mentions stay plain text.
 *   - **Entities never nest.** Longest first wins the claim, so "Acme migration"
 *     beats a bare "Acme" pointing into the same span rather than splitting it.
 *   - **An entity the model invented is dropped, not thrown.** If `text` does not
 *     contain it, the sentence still renders whole.
 *
 * Exported for its own unit tests — it is the one piece of real logic in this zone.
 */
export function segmentSentence(text: string, entities: SentenceEntity[]): Segment[] {
  const claims: Claim[] = []
  const longestFirst = [...entities].sort((a, b) => b.text.length - a.text.length)

  for (const entity of longestFirst) {
    if (!entity.text) continue
    const at = findFreeOccurrence(text, entity.text, claims)
    if (at >= 0) claims.push({ start: at, end: at + entity.text.length, entity })
  }

  claims.sort((a, b) => a.start - b.start)

  const segments: Segment[] = []
  let cursor = 0
  for (const claim of claims) {
    if (claim.start > cursor) segments.push({ text: text.slice(cursor, claim.start), entity: null })
    segments.push({ text: text.slice(claim.start, claim.end), entity: claim.entity })
    cursor = claim.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), entity: null })
  return segments
}

/** Drill-in target for an entity. The time range is the one kind with no panel. */
function entityHref(entity: SentenceEntity): string {
  return `?drill=${entity.kind}:${entity.ref}`
}

/**
 * Zone 2 — the daily sentence (PRD §4, §9, §11, §17.13).
 *
 * Serif 300 at 28/38, capped around 62 characters a line, because this is prose and
 * prose has a measure. Every noun the sentence names that exists as an object links
 * into its own drill-in — ink-coloured text with a 40%-opacity accent underline,
 * visible as interactive but never a field of blue.
 *
 * A time range is the exception: it scrolls and highlights that band in the timeline
 * and opens no panel, so it is rendered as a button rather than a link. The timeline
 * (`#timeline`) picks it up by its `data-ref`.
 *
 * **Why this zone is client code.** Three of §11's four moments converge here and
 * none of them can be expressed in markup: the sentence has to know whether its text
 * *genuinely* changed before it animates (`inputHash`, never the prose), it has to
 * measure itself to know whether the board-mode two-line cap actually truncated
 * anything, and it owns the once-per-session open cascade for the whole page. The
 * cascade lives here rather than in the frame because it must run after the zones
 * exist and before anyone has read them, and this is the first zone with a reason to
 * be interactive at all.
 *
 * **Refreshing never blanks it** (§9). `loading` resolves to the skeleton only until
 * the first sentence has arrived; from then on the last good prose stays on screen and
 * the new one cross-fades into its place.
 */
export default function Sentence({ sentence, loading = false }: SentenceProps) {
  // The sentence currently on screen. Seeded from props so the server and the first
  // client render agree, then held across a refresh that briefly has nothing to offer.
  const [shown, setShown] = useState<DailySentence | null>(sentence)
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)

  const proseRef = useRef<HTMLParagraphElement | null>(null)
  const pendingRef = useRef<DailySentence | null>(null)

  // The open cascade is the page's, not this zone's, and it is once per session —
  // a poll refresh must never replay it (PRD §11, §17.13).
  useEffect(() => {
    void runOpenCascade()
  }, [])

  useEffect(() => {
    if (sentence === null) return // A refresh with nothing new: keep what is readable.
    if (shown !== null && !hasSentenceChanged(shown, sentence)) return

    const prose = proseRef.current
    // Nothing was on screen to fade out: this is an arrival, not a replacement.
    if (shown === null || prose === null) {
      setShown(sentence)
      return
    }

    let cancelled = false
    pendingRef.current = sentence
    void fadeOut(prose).then(() => {
      if (cancelled) return
      setShown(sentence)
    })
    return () => {
      cancelled = true
    }
  }, [sentence, shown])

  // The old text has gone; write the new one in word by word. `useLayoutEffect` so the
  // words are never painted at full opacity for a frame before the animation starts.
  useLayoutEffect(() => {
    const prose = proseRef.current
    const pending = pendingRef.current
    if (!prose || !pending || pending !== shown) return
    pendingRef.current = null
    void writeInWords(prose)
  }, [shown])

  /**
   * Board mode caps the sentence at two lines (§17.13), and the "more" affordance only
   * earns its place when something was actually cut. The cap itself is CSS, keyed off
   * `[data-display='board']`, so this measures the rendered result rather than
   * second-guessing the mode — which also means the affordance behaves correctly if the
   * prose is short enough to fit in two lines anyway.
   */
  const measure = useCallback(() => {
    const prose = proseRef.current
    if (!prose) return
    setTruncated(prose.scrollHeight - prose.clientHeight > 1)
  }, [])

  useLayoutEffect(() => {
    if (expanded) return
    measure()
  }, [shown, expanded, measure])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // The skeleton is for the very first paint only — never for a refresh (PRD §9).
  if (shown === null) {
    return (
      <section {...testid(TID.sentence)}>
        <div
          className={styles.sentenceSkeleton}
          aria-hidden="true"
          aria-busy={loading ? 'true' : undefined}
          {...testid(TID.skeleton)}
        >
          <span className={styles.skeletonLine} />
          <span className={styles.skeletonLine} />
        </div>
      </section>
    )
  }

  const segments = segmentSentence(shown.text, shown.entities)

  return (
    <section {...testid(TID.sentence)}>
      <p
        ref={proseRef}
        className={`${styles.sentence} voice-written arrive`}
        data-clamp={expanded ? 'false' : 'true'}
        {...testid(TID.sentenceText)}
      >
        {segments.map((segment, index) => {
          if (!segment.entity) return <span key={index}>{segment.text}</span>

          const entity = segment.entity
          if (entity.kind === 'timerange') {
            return (
              <button
                key={index}
                type="button"
                className={styles.entityButton}
                data-entity-kind={entity.kind}
                data-ref={entity.ref}
                aria-controls="timeline"
                {...testid(TID.sentenceEntity)}
              >
                {segment.text}
              </button>
            )
          }

          return (
            <a
              key={index}
              href={entityHref(entity)}
              className={styles.entity}
              data-entity-kind={entity.kind}
              data-ref={entity.ref}
              {...testid(TID.sentenceEntity)}
            >
              {segment.text}
            </a>
          )
        })}
      </p>

      {/* Truncation is never silent. One word, no chevron, no count. */}
      {(truncated || expanded) && (
        <button
          type="button"
          className={styles.sentenceMore}
          aria-expanded={expanded ? 'true' : 'false'}
          onClick={() => setExpanded((open) => !open)}
          data-testid="sentence-more"
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </section>
  )
}
