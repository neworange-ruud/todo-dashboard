import { describe, expect, it } from 'vitest'

import { describeSections, isTranscript, parseProvenance, withoutProvenance } from './provenance'

/**
 * Every description here is copied verbatim from the live board (12 Sep 2026). The format
 * is produced by the extraction pipeline, not by a human, so the value of these tests is
 * entirely in matching what that pipeline actually writes.
 */

const FROM_TRANSCRIPT = `Maakt gedeelde content, projecten, tech stacks en expertise vindbaar

Het relevante transcriptfragment is vastgelegd, het concept is als nieuw project aan Flight Deck toegevoegd.

Provenance: Omni fireflies/01M27T2KN8ENXYZD57Q43E1MM0; evidence 2026-09-11`

const FROM_MAIL = `De nieuwe laptop van Ruud is geregistreerd en zichtbaar in Intune.

Provenance: Omni outlook/01M28A8TR3HETYVTC1CWYFZRY2; evidence 2026-09-11`

describe('parseProvenance', () => {
  it('reads the pointer a transcript-extracted task carries', () => {
    expect(parseProvenance(FROM_TRANSCRIPT)).toEqual({
      sourceType: 'fireflies',
      documentId: '01M27T2KN8ENXYZD57Q43E1MM0',
      evidenceDate: '2026-09-11',
    })
  })

  it('reads a mail pointer too', () => {
    expect(parseProvenance(FROM_MAIL)).toMatchObject({
      sourceType: 'outlook',
      documentId: '01M28A8TR3HETYVTC1CWYFZRY2',
    })
  })

  it('handles the multi-word source types without splitting them', () => {
    const line = 'Provenance: Omni outlook_calendar/01ABC; evidence 2026-09-01'
    expect(parseProvenance(line)?.sourceType).toBe('outlook_calendar')
    expect(parseProvenance(line)?.documentId).toBe('01ABC')
  })

  it('accepts a pointer with no evidence clause', () => {
    expect(parseProvenance('Provenance: Omni fireflies/01ABC')).toEqual({
      sourceType: 'fireflies',
      documentId: '01ABC',
      evidenceDate: null,
    })
  })

  it('returns nothing for the 78% of tasks that carry no pointer', () => {
    expect(parseProvenance('Just a task somebody typed.')).toBeNull()
    expect(parseProvenance('')).toBeNull()
    expect(parseProvenance(null)).toBeNull()
  })

  it('refuses half a pointer rather than guessing at the other half', () => {
    // Sending a retrieval somewhere arbitrary is worse than not retrieving.
    expect(parseProvenance('Provenance: Omni fireflies/')).toBeNull()
    expect(parseProvenance('Provenance: Omni 01ABC')).toBeNull()
  })
})

describe('withoutProvenance', () => {
  it('leaves the prose and takes the bookkeeping', () => {
    const body = withoutProvenance(FROM_TRANSCRIPT)
    expect(body).toContain('Maakt gedeelde content')
    expect(body).not.toContain('Provenance:')
    expect(body).not.toContain('01M27T2KN8ENXYZD57Q43E1MM0')
    // No trailing blank lines where the line used to be.
    expect(body).toBe(body.trim())
  })

  it('leaves a description without a pointer exactly as it was', () => {
    expect(withoutProvenance('A plain description.')).toBe('A plain description.')
  })

  it('is safe on nothing at all', () => {
    expect(withoutProvenance(null)).toBe('')
  })
})

describe('isTranscript', () => {
  it('distinguishes a recording from mail', () => {
    expect(isTranscript(parseProvenance(FROM_TRANSCRIPT))).toBe(true)
    expect(isTranscript(parseProvenance(FROM_MAIL))).toBe(false)
    expect(isTranscript(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Formats B and C — also copied verbatim from the live board
// ---------------------------------------------------------------------------

const FORMAT_B = `### Outcome

De saleskansen bij Klimaatgoed en Ascent afronden en opvolgen met concrete vervolgstappen.

### Completion criterion

Voor beide saleskansen is de actuele status bepaald.

### Provenance

* Source: fireflies
* Source reference: omni://01M1F786JY42W7BPJSBA20B7A9/01M1F7CTTKH9P7J5Y8XGD31GGC
* Captured: 2026-06-11T07:35:00+00:00
* Ownership confidence: explicit
* Inference: -
* Fingerprint: candidate:74e8269bbb9313aa6745959e033ce4fbd36819c723c6d9b768ad565476b5c65d`

/** The same bullets with no `### Provenance` heading above them — common on this board. */
const FORMAT_B_HEADLESS = `### Outcome

De overdracht van het Jira-beheer begeleiden.

### Completion criterion

Een nieuwe beheerder heeft de benodigde toegang ontvangen.

* Source: fireflies
* Source reference: omni://01M1F786JY42W7BPJSBA20B7A9/01M1F7CTTKH9P7J5Y8XGD31GGC
* Captured: 2026-06-11T07:35:00+00:00
* Fingerprint: candidate:74e8269bbb9313aa`

const FORMAT_C = `Outcome: Technische specificatie aanleveren voor de benodigde Ask NVM-API.
Completion criterion: Piet Hein heeft een concrete API-specificatie ontvangen.
Provenance: source=fireflies; source_url=omni://01M1F786JY42W7BPJSBA20B7A9/01M1P77H20G9DKZSSTHPEHCW4X; evidence_at=2026-09-04T11:05:00+00:00; owner_confidence=inferred; inference_note=Speaker 3 vraagt Ruud de benodigde API-specificatie te sturen; Speaker 1 stemt expliciet toe met: 'Ja, dat kunnen we doen, zeker.'; fingerprint=candidate:b24ababbdde6091ef05035e6db7790141e169db04f65ab8cec392b8d94c008f4`

describe('the markdown and key-value formats', () => {
  it('reads the omni:// reference, taking the document from the second segment', () => {
    expect(parseProvenance(FORMAT_B)).toEqual({
      sourceType: 'fireflies',
      documentId: '01M1F7CTTKH9P7J5Y8XGD31GGC',
      evidenceDate: '2026-06-11',
    })
    expect(parseProvenance(FORMAT_C)).toEqual({
      sourceType: 'fireflies',
      documentId: '01M1P77H20G9DKZSSTHPEHCW4X',
      evidenceDate: '2026-09-04',
    })
  })

  it('reads the bullets even with no heading above them', () => {
    expect(parseProvenance(FORMAT_B_HEADLESS)?.documentId).toBe('01M1F7CTTKH9P7J5Y8XGD31GGC')
  })

  it('leaves no trace of any of it on screen', () => {
    for (const [name, raw] of [
      ['B', FORMAT_B],
      ['B headless', FORMAT_B_HEADLESS],
      ['C', FORMAT_C],
    ] as const) {
      const body = withoutProvenance(raw)
      expect(body, name).not.toMatch(/omni:\/\//)
      expect(body, name).not.toMatch(/fingerprint/i)
      expect(body, name).not.toMatch(/Ownership confidence|owner_confidence/i)
      expect(body, name).not.toMatch(/inference_note|Captured:|evidence_at/i)
      expect(body, name).not.toMatch(/Provenance/i)
    }
  })

  it('keeps the prose that was actually written', () => {
    expect(withoutProvenance(FORMAT_B)).toContain('saleskansen bij Klimaatgoed')
    expect(withoutProvenance(FORMAT_C)).toContain('Technische specificatie aanleveren')
  })
})

describe('describeSections', () => {
  it('splits the markdown style into its labelled parts', () => {
    const sections = describeSections(FORMAT_B)
    expect(sections.map((s) => s.label)).toEqual(['Outcome', 'Completion criterion'])
    expect(sections[0].body).toContain('saleskansen')
  })

  it('splits the inline style the same way', () => {
    // Run together these read as one long sentence, which is what PRD §8 rules out.
    const sections = describeSections(FORMAT_C)
    expect(sections.map((s) => s.label)).toEqual(['Outcome', 'Completion criterion'])
    expect(sections[1].body).toContain('Piet Hein')
  })

  it('keeps an unlabelled description whole rather than dropping it', () => {
    const sections = describeSections('Just a sentence somebody wrote.')
    expect(sections).toEqual([{ label: null, body: 'Just a sentence somebody wrote.' }])
  })

  it('is empty when there is nothing but provenance', () => {
    expect(describeSections('Provenance: Omni fireflies/01ABC')).toEqual([])
  })
})
