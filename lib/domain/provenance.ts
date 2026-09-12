/**
 * The provenance block carried by a machine-extracted Linear issue (PRD §17.6).
 *
 * Issues on team RW that were extracted from a transcript or a mail thread record the exact
 * Omni document they came from. This is the single most valuable field on the board: it
 * turns "what was said in the meeting this task came from" into one lookup by id rather
 * than a fuzzy search over 609 transcripts — the difference between a block that is usually
 * roughly right and one that is exactly right, which for a sourced claim is the whole
 * difference (PRD §8, "Sourcing").
 *
 * **Three formats are in the wild**, written by different generations of the extraction
 * pipeline. Surveyed against the live board on 12 Sep 2026:
 *
 * A — inline, 22 issues:
 * ```
 * Provenance: Omni outlook/01M28JZ5F5PB97MTHBSVTWF4BW; evidence 2026-09-11
 * ```
 *
 * B — markdown section, the majority:
 * ```
 * ### Provenance
 *
 * * Source: fireflies
 * * Source reference: omni://01M1F786JY42W7BPJSBA20B7A9/01M1F7CTTKH9P7J5Y8XGD31GGC
 * * Captured: 2026-06-11T07:35:00+00:00
 * * Ownership confidence: explicit
 * * Inference: -
 * * Fingerprint: candidate:74e8269bbb…
 * ```
 *
 * C — inline key/value:
 * ```
 * Provenance: source=fireflies; source_url=omni://01M1F786JY…/01M1P77H20G9DKZSSTHPEHCW4X;
 * evidence_at=2026-09-04T11:05:00+00:00; owner_confidence=inferred; inference_note=…;
 * fingerprint=candidate:b24ababbdde…
 * ```
 *
 * In B and C the reference is `omni://<source_id>/<document_id>` — the **second** segment is
 * the document id. Handling only format A left three quarters of the board with no pointer
 * and, worse, printed the whole raw block at the reader as if it were the description.
 */

export interface Provenance {
  /** Omni's own `source_type`, e.g. `fireflies`, `outlook`, `outlook_calendar`. */
  sourceType: string
  /** The Omni document id, ready for `fetchDocument`. */
  documentId: string
  /** When the extraction was evidenced, `YYYY-MM-DD`, when the block carries it. */
  evidenceDate: string | null
}

// ---------------------------------------------------------------------------
// Format A — `Provenance: Omni <source_type>/<document_id>; evidence <date>`
// ---------------------------------------------------------------------------

const FORMAT_A =
  /^[ \t]*Provenance:[ \t]*Omni[ \t]+([a-z][a-z0-9_]*)\/([A-Za-z0-9_-]+)[ \t]*(?:;[ \t]*evidence[ \t]*(\d{4}-\d{2}-\d{2}))?[ \t]*$/im

// ---------------------------------------------------------------------------
// Formats B and C — a labelled block naming a source and an `omni://` reference
// ---------------------------------------------------------------------------

/** `omni://<source_id>/<document_id>`, wherever it appears. */
const OMNI_REF = /omni:\/\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/i

/** `* Source: fireflies` (B) or `source=fireflies` (C). */
const SOURCE_NAME = /(?:^|[\s;*])(?:Source:[ \t]*|source=)([a-z][a-z0-9_]*)/i

/** `* Captured: <iso>` (B) or `evidence_at=<iso>` (C). */
const CAPTURED = /(?:Captured:[ \t]*|evidence_at=)(\d{4}-\d{2}-\d{2})/i

/**
 * The whole markdown provenance section (B), heading through to the end of its bullets.
 *
 * Ends at the next heading or at the end of the description, because the section is always
 * last and its bullets are free to gain fields.
 */
const SECTION_B = /\n*^[ \t]*#{1,6}[ \t]*Provenance[ \t]*$[\s\S]*?(?=^[ \t]*#{1,6}[ \t]+|\s*$)/im

/**
 * The same bullets **without** the heading above them.
 *
 * A good part of the board writes format B's list directly after the completion criterion
 * with no `### Provenance` line at all, so a heading-anchored rule left the whole block —
 * source id, capture timestamp, fingerprint hash — sitting on screen. Anchored instead on
 * the labels themselves, which are stable, and consuming to the end, because the block is
 * always last.
 */
const BULLETS_B =
  /\n*^[ \t]*[*-][ \t]*(?:Source|Source reference|Captured|Ownership confidence|Inference|Fingerprint)[ \t]*:[\s\S]*$/im

/**
 * The inline key/value run (C).
 *
 * Runs from `Provenance:` to the end of the description. `inference_note=` routinely
 * contains sentences, semicolons and quotation marks, so anything that tried to stop at a
 * delimiter would cut the block in half and leave the tail on screen.
 */
const SECTION_C = /\n*^[ \t]*Provenance:[ \t]*source=[\s\S]*$/im

/** Format A's single line. */
const SECTION_A = new RegExp(FORMAT_A.source, 'im')

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Reads the pointer out of a description, or null when there is not one. */
export function parseProvenance(description: string | null | undefined): Provenance | null {
  if (!description) return null

  const a = FORMAT_A.exec(description)
  if (a) {
    return {
      sourceType: a[1].toLowerCase(),
      documentId: a[2],
      evidenceDate: a[3] ?? null,
    }
  }

  // B and C differ only in punctuation; both name a source and carry an omni:// reference.
  const ref = OMNI_REF.exec(description)
  if (!ref) return null
  const source = SOURCE_NAME.exec(description)
  if (!source) return null

  return {
    sourceType: source[1].toLowerCase(),
    // `omni://<source_id>/<document_id>` — the document is the second segment.
    documentId: ref[2],
    evidenceDate: CAPTURED.exec(description)?.[1] ?? null,
  }
}

/**
 * The description with the provenance block taken out.
 *
 * Provenance is bookkeeping: opaque ids, a fingerprint hash, and an `inference_note`
 * explaining to a machine why a machine believed something. None of it is what the reader
 * opened the panel for, and all of it was being printed at them. The panel renders the
 * prose and turns the pointer into a `↗ source` affordance instead, which is what PRD §8
 * asks of every sourced claim.
 */
export function withoutProvenance(description: string | null | undefined): string {
  if (!description) return ''
  return description
    .replace(SECTION_B, '')
    .replace(BULLETS_B, '')
    .replace(SECTION_C, '')
    .replace(SECTION_A, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Whether this pointer leads to a meeting recording rather than to mail or a file. */
export function isTranscript(provenance: Provenance | null): boolean {
  return provenance?.sourceType === 'fireflies'
}

// ---------------------------------------------------------------------------
// The description itself
// ---------------------------------------------------------------------------

export interface DescriptionSection {
  /** `Outcome`, `Completion criterion`, or null for an unlabelled opening paragraph. */
  label: string | null
  body: string
}

/** Labels the extraction pipeline writes, in both of its styles. */
const LABELLED = /^[ \t]*(?:#{1,6}[ \t]*)?(Outcome|Completion criterion|Context|Notes?)[ \t]*:?[ \t]*$/i
const INLINE_LABEL = /^[ \t]*(Outcome|Completion criterion|Context|Notes?):[ \t]*(.+)$/i

/**
 * Splits an extracted description into its labelled parts.
 *
 * Both pipeline styles write the same two fields — an outcome and a completion criterion —
 * one as markdown headings, the other as inline `Label: value` lines. Rendered as a single
 * run of text they read as one long undifferentiated sentence, which is exactly what PRD §8
 * says the panel must never produce. Anything unrecognised comes back as one unlabelled
 * section rather than being dropped.
 */
export function describeSections(description: string | null | undefined): DescriptionSection[] {
  const text = withoutProvenance(description)
  if (!text) return []

  const sections: DescriptionSection[] = []
  let label: string | null = null
  let buffer: string[] = []

  const flush = () => {
    const body = buffer.join('\n').trim()
    if (body) sections.push({ label, body })
    buffer = []
  }

  for (const line of text.split('\n')) {
    const heading = LABELLED.exec(line)
    if (heading) {
      flush()
      label = titleCase(heading[1])
      continue
    }
    const inline = INLINE_LABEL.exec(line)
    if (inline) {
      flush()
      label = titleCase(inline[1])
      buffer.push(inline[2])
      continue
    }
    buffer.push(line)
  }
  flush()

  return sections
}

function titleCase(label: string): string {
  const lower = label.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}
