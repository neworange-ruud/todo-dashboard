import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Sentence, { segmentSentence } from './Sentence'
import { TID } from '@/lib/testids'
import type { DailySentence } from '@/lib/types'

function sentence(text: string, entities: DailySentence['entities']): DailySentence {
  return {
    text,
    entities,
    window: 'morning',
    generatedAt: '2026-09-11T08:00:00+02:00',
    inputHash: 'abc123',
  }
}

const today = sentence(
  'Today is a meeting day. Your only real block is 14:00–16:00 — spend it on the Acme migration and nothing else. Marieke is waiting on it.',
  [
    { text: '14:00–16:00', kind: 'timerange', ref: '840-960' },
    { text: 'Acme migration', kind: 'issue', ref: 'RW-214' },
    { text: 'Marieke', kind: 'person', ref: 'marieke@neworange.agency' },
  ],
)

describe('Sentence', () => {
  it('renders the whole sentence as written', () => {
    render(<Sentence sentence={today} />)

    expect(screen.getByTestId(TID.sentenceText)).toHaveTextContent(
      /Today is a meeting day\..*Marieke is waiting on it\./,
    )
  })

  it('linkifies every entity into its drill-in', () => {
    render(<Sentence sentence={today} />)

    const issue = screen.getByText('Acme migration')
    expect(issue.tagName).toBe('A')
    expect(issue).toHaveAttribute('href', '?drill=issue:RW-214')

    const person = screen.getByText('Marieke')
    expect(person).toHaveAttribute('href', '?drill=person:marieke@neworange.agency')
  })

  it('renders a time range as a button, not a link (PRD §4)', () => {
    render(<Sentence sentence={today} />)

    const range = screen.getByText('14:00–16:00')
    expect(range.tagName).toBe('BUTTON')
    expect(range).not.toHaveAttribute('href')
    expect(range).toHaveAttribute('data-ref', '840-960')
  })

  it('linkifies a repeated word only where it is the entity', () => {
    const repeated = sentence(
      'The migration slipped again; the Acme migration is the one that matters.',
      [{ text: 'Acme migration', kind: 'issue', ref: 'RW-214' }],
    )
    render(<Sentence sentence={repeated} />)

    const entities = screen.getAllByTestId(TID.sentenceEntity)
    expect(entities).toHaveLength(1)
    expect(entities[0]).toHaveTextContent('Acme migration')
    // The earlier, plain "migration" is left alone.
    expect(screen.getByTestId(TID.sentenceText).textContent).toContain(
      'The migration slipped again;',
    )
  })

  it('matches each entity once, even when the same word appears twice', () => {
    const twice = sentence('Acme wants an answer today; Acme has waited a week.', [
      { text: 'Acme', kind: 'account', ref: 'acme' },
    ])
    render(<Sentence sentence={twice} />)

    expect(screen.getAllByTestId(TID.sentenceEntity)).toHaveLength(1)
  })

  it('never nests one entity inside another', () => {
    const overlapping = sentence('Spend the block on the Acme migration.', [
      { text: 'Acme', kind: 'account', ref: 'acme' },
      { text: 'Acme migration', kind: 'issue', ref: 'RW-214' },
    ])
    const segments = segmentSentence(overlapping.text, overlapping.entities)
    const claimed = segments.filter((s) => s.entity !== null)

    expect(claimed).toHaveLength(1)
    expect(claimed[0].text).toBe('Acme migration')
    expect(segments.map((s) => s.text).join('')).toBe(overlapping.text)
  })

  it('drops an entity the model invented rather than dropping the sentence', () => {
    const hallucinated = sentence('Nothing on the calendar and nothing due. A rare one.', [
      { text: 'Acme migration', kind: 'issue', ref: 'RW-214' },
    ])
    render(<Sentence sentence={hallucinated} />)

    expect(screen.queryAllByTestId(TID.sentenceEntity)).toHaveLength(0)
    expect(screen.getByTestId(TID.sentenceText)).toHaveTextContent(
      'Nothing on the calendar and nothing due. A rare one.',
    )
  })

  it('renders a skeleton rather than crashing when there is no sentence yet', () => {
    render(<Sentence sentence={null} />)

    expect(screen.getByTestId(TID.skeleton)).toBeInTheDocument()
    expect(screen.queryByTestId(TID.sentenceText)).not.toBeInTheDocument()
  })

  it('renders the skeleton on a first load that has nothing yet', () => {
    render(<Sentence sentence={null} loading />)

    expect(screen.getByTestId(TID.skeleton)).toBeInTheDocument()
  })
})

/**
 * Refreshing (PRD §9): "Data on screen stays live and readable — never blanked, never
 * skeletonised." The skeleton is an *arrival* state, and a poll that has nothing to say
 * yet is not an arrival.
 */
describe('Sentence — refreshing', () => {
  it('keeps the prose on screen when a refresh has nothing yet', () => {
    const { rerender } = render(<Sentence sentence={today} />)
    expect(screen.getByTestId(TID.sentenceText)).toBeInTheDocument()

    rerender(<Sentence sentence={null} loading />)

    expect(screen.queryByTestId(TID.skeleton)).not.toBeInTheDocument()
    expect(screen.getByTestId(TID.sentenceText)).toHaveTextContent(/Today is a meeting day/)
  })

  it('leaves the prose exactly as it was when the inputs have not changed', () => {
    const { rerender } = render(<Sentence sentence={today} />)

    // Same hash, rephrased text: a poll, not news. Nothing is replaced.
    rerender(<Sentence sentence={sentence('A meeting day, today.', [])} />)

    expect(screen.getByTestId(TID.sentenceText)).toHaveTextContent(/Today is a meeting day/)
  })

  it('adopts the new prose when the inputs genuinely changed', async () => {
    const { rerender } = render(<Sentence sentence={today} />)

    const next: DailySentence = {
      ...sentence('Everything due today is done. One look-ahead: Tuesday is heavy.', []),
      inputHash: 'def456',
    }
    rerender(<Sentence sentence={next} />)

    await waitFor(() =>
      expect(screen.getByTestId(TID.sentenceText)).toHaveTextContent(/Everything due today is done/),
    )
  })
})

/**
 * Board mode caps the sentence at two lines and truncates with a "more" affordance
 * (PRD §17.13). The cap itself is CSS; the component's job is to mark the clamp and to
 * notice, by measuring, whether anything was actually cut.
 */
describe('Sentence — the two-line cap', () => {
  /** jsdom has no layout, so the overflow the component measures is supplied here. */
  function stubOverflow(scrollHeight: number, clientHeight: number): () => void {
    const original = {
      scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
      clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
    }
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => clientHeight,
    })
    return () => {
      if (original.scrollHeight) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original.scrollHeight)
      }
      if (original.clientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', original.clientHeight)
      }
    }
  }

  let restore: (() => void) | null = null

  afterEach(() => {
    restore?.()
    restore = null
  })

  it('marks the prose as clamped so the board rule can cap it at two lines', () => {
    render(<Sentence sentence={today} />)

    expect(screen.getByTestId(TID.sentenceText)).toHaveAttribute('data-clamp', 'true')
  })

  it('offers "more" only when the cap actually cut something', () => {
    restore = stubOverflow(76, 76)
    render(<Sentence sentence={today} />)

    expect(screen.queryByTestId('sentence-more')).not.toBeInTheDocument()
  })

  it('offers "more" when the prose overflows its two lines', async () => {
    restore = stubOverflow(190, 76)
    render(<Sentence sentence={today} />)

    const more = await screen.findByTestId('sentence-more')
    expect(more).toHaveTextContent('more')
    expect(more).toHaveAttribute('aria-expanded', 'false')
  })

  it('lifts the clamp when the reader asks for more, and puts it back', async () => {
    restore = stubOverflow(190, 76)
    render(<Sentence sentence={today} />)

    const more = await screen.findByTestId('sentence-more')
    fireEvent.click(more)

    expect(screen.getByTestId(TID.sentenceText)).toHaveAttribute('data-clamp', 'false')
    expect(screen.getByTestId('sentence-more')).toHaveTextContent('less')

    fireEvent.click(screen.getByTestId('sentence-more'))
    expect(screen.getByTestId(TID.sentenceText)).toHaveAttribute('data-clamp', 'true')
  })

  it('never hides prose behind a count — the affordance is a word', async () => {
    restore = stubOverflow(190, 76)
    render(<Sentence sentence={today} />)

    const more = await screen.findByTestId('sentence-more')
    expect(more.textContent).not.toMatch(/\d/)
  })
})
