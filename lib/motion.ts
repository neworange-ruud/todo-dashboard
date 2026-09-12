/**
 * Motion (PRD §11).
 *
 * Four deliberate moments and nothing else: the open cascade, the sentence writing
 * itself, the arrival cross-fade, and the panel (which belongs to the drill-in and is
 * deliberately absent from this module). Continuous motion is limited to the now-line
 * advancing and the refresh glyph rotating — both plain CSS, neither routed through
 * this file. **Nothing pulses, breathes, shimmers or loops.**
 *
 * The split in this module is deliberate:
 *
 *   - The **top half** is pure arithmetic — no DOM, no library, no clock. Every timing
 *     decision the product makes is a function here, so `lib/motion.test.ts` can assert
 *     the spec without a browser.
 *   - The **bottom half** touches the DOM. anime.js v4 is loaded with a dynamic
 *     `import()` at the moment of use, which keeps the engine out of the unit-test
 *     graph and off the critical path of first paint. v4's API is
 *     `import { animate, stagger } from 'animejs'` — the v3 default export is gone.
 *
 * Transform and opacity only; nothing here animates layout.
 */

import type { FunctionValue } from 'animejs'
import type { DailySentence } from './types'

// ---------------------------------------------------------------------------
// Spec constants (PRD §11)
// ---------------------------------------------------------------------------

/** Open cascade: zones start 60ms apart… */
export const CASCADE_STEP_MS = 60
/** …each running 400ms… */
export const CASCADE_DURATION_MS = 400
/** …rising 8px as it fades in. Six zones ⇒ ~700ms end to end. */
export const CASCADE_RISE_PX = 8

/** Sentence: nominal per-word step. */
export const WORD_STEP_MS = 28
/** Sentence: the whole run, however many words. */
export const SENTENCE_MS = 500
/** Sentence: no single word fades in faster than this. */
export const MIN_WORD_FADE_MS = 160

/** Arrival: skeleton → content. */
export const ARRIVAL_MS = 250
/** Arrival: the rise that stops it being a pop. */
export const ARRIVAL_RISE_PX = 3

/** `prefers-reduced-motion: reduce` collapses every moment to this opacity fade. */
export const REDUCED_MS = 120

/** The old sentence leaving. Leaving is always faster than arriving. */
export const SENTENCE_OUT_MS = 160

/**
 * The cascade is once per *session*, not once per mount and certainly not once per
 * poll: the wall monitor re-renders every few minutes and a page that re-introduces
 * itself each time is exactly the nervous tic §11 forbids.
 */
export const CASCADE_SESSION_KEY = 'task-desk:cascade-played'

// ---------------------------------------------------------------------------
// Pure helpers — unit-testable without a DOM
// ---------------------------------------------------------------------------

/**
 * True when the reader has asked for less motion.
 *
 * Read at the moment of use rather than cached, so a system-level change takes effect
 * without a reload. Guarded for the server and for environments with no `matchMedia`,
 * where the honest answer is "no preference expressed".
 */
export function shouldReduceMotion(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/**
 * Start offsets for the open cascade: `[0, 60, 120, …]`.
 *
 * Under reduced motion every zone starts at once — a cascade is still motion, and §11
 * collapses it to a single 120ms fade rather than a faster cascade.
 */
export function cascadeDelays(count: number, reduced: boolean = false): number[] {
  if (!Number.isFinite(count) || count <= 0) return []
  const n = Math.floor(count)
  const step = reduced ? 0 : CASCADE_STEP_MS
  return Array.from({ length: n }, (_, i) => i * step)
}

export interface WordTiming {
  text: string
  delayMs: number
  durationMs: number
}

/**
 * Per-word timings for the sentence writing itself in.
 *
 * **The ambiguity, resolved.** §11 asks for both "~28ms per word" and "500ms total",
 * which cannot both hold for a 50-word sentence (§17.13 caps it there). 500ms is the
 * one that carries the intent — it is the reason the moment reads as writing rather
 * than as a loading state — so the run is always 500ms end to end and the 28ms step is
 * the *nominal* spacing, compressed when there are more words than fit. The last word
 * therefore always finishes at exactly `SENTENCE_MS`, and no word ever fades faster
 * than `MIN_WORD_FADE_MS`.
 */
export function wordTimings(text: string): WordTiming[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return []

  const gaps = words.length - 1
  const step =
    gaps === 0 ? 0 : Math.min(WORD_STEP_MS, (SENTENCE_MS - MIN_WORD_FADE_MS) / gaps)
  const lastDelay = step * gaps
  const fade = SENTENCE_MS - lastDelay

  return words.map((word, index) => ({
    text: word,
    delayMs: Math.round(step * index),
    durationMs: Math.round(fade),
  }))
}

/**
 * Has the sentence *genuinely* changed?
 *
 * **Hashes, never text.** `inputHash` is a hash of the inputs the model saw, so two
 * runs over an unchanged day produce the same hash even when the model rephrases
 * itself — and a rephrase is not news. Comparing the prose instead would replay the
 * one indulgence in the product on every poll, which is precisely how an indulgence
 * turns into a tic.
 */
export function hasSentenceChanged(
  previous: DailySentence | null | undefined,
  next: DailySentence | null | undefined,
): boolean {
  if (!previous || !next) return Boolean(previous) !== Boolean(next)
  return previous.inputHash !== next.inputHash
}

// ---------------------------------------------------------------------------
// Session memory for the open cascade
// ---------------------------------------------------------------------------

/** `sessionStorage` is unavailable in private modes and on the server; never throw. */
function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function hasCascaded(): boolean {
  return session()?.getItem(CASCADE_SESSION_KEY) === '1'
}

export function markCascaded(): void {
  try {
    session()?.setItem(CASCADE_SESSION_KEY, '1')
  } catch {
    // A reader who blocks storage sees the cascade once per load rather than once per
    // session. That is the correct failure direction: annoying, never broken.
  }
}

// ---------------------------------------------------------------------------
// DOM moments
// ---------------------------------------------------------------------------

/**
 * Zone order, verbatim from §11: bar → attention → sentence → timeline → top five →
 * week. Selected by test id because those are already the stable contract between the
 * components and the e2e suite (`lib/testids.ts`), and because the cascade must not
 * require every zone to accept a motion prop.
 */
export const CASCADE_TARGETS: readonly string[] = [
  '[data-testid="zone-bar"]',
  '[data-testid="zone-attention"]',
  '[data-testid="zone-sentence"]',
  '[data-testid="timeline"]',
  '[data-testid="top-five"]',
  '[data-testid="zone-week"]',
]

function cascadeElements(root: ParentNode): HTMLElement[] {
  const found: HTMLElement[] = []
  for (const selector of CASCADE_TARGETS) {
    const el = root.querySelector(selector)
    if (el instanceof HTMLElement) found.push(el)
  }
  return found
}

/**
 * The open cascade (§11, §17.13).
 *
 * Runs at most once per session — the session flag is set *before* the first frame, so
 * a React strict-mode double-mount, a hydration re-run and a poll refresh all find it
 * already played. The elements are never hidden by CSS, only by this animation, so a
 * failure to load the engine leaves a fully readable page rather than a blank one.
 */
export async function runOpenCascade(root: ParentNode = document): Promise<boolean> {
  if (hasCascaded()) return false
  const targets = cascadeElements(root)
  if (targets.length === 0) return false
  markCascaded()

  const { animate, stagger } = await import('animejs')

  if (shouldReduceMotion()) {
    animate(targets, { opacity: [0, 1], duration: REDUCED_MS, ease: 'linear' })
    return true
  }

  animate(targets, {
    opacity: [0, 1],
    translateY: [CASCADE_RISE_PX, 0],
    duration: CASCADE_DURATION_MS,
    delay: stagger(CASCADE_STEP_MS),
    ease: 'out(3)',
  })
  return true
}

/** The old sentence leaving, before the new one is written in its place. */
export async function fadeOut(el: HTMLElement): Promise<void> {
  const { animate } = await import('animejs')
  const duration = shouldReduceMotion() ? REDUCED_MS : SENTENCE_OUT_MS
  await animate(el, { opacity: [1, 0], duration, ease: 'linear' })
}

/**
 * Wrap every word of `el` in its own inert span so the words can be staggered.
 *
 * Done here rather than in the component's JSX on purpose: a sentence whose every word
 * is an element breaks `getByText` for entities and leaves permanent scaffolding in the
 * DOM for the sake of a moment that fires at most a few times a day. The spans are
 * created at the moment of animation and removed again when it finishes.
 */
function splitWords(el: HTMLElement): { words: HTMLElement[]; restore: () => void } {
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && node.nodeValue.trim().length > 0) texts.push(node as Text)
  }

  const words: HTMLElement[] = []
  const undo: Array<() => void> = []

  for (const text of texts) {
    const parent = text.parentNode
    if (!parent) continue
    const original = text.nodeValue ?? ''
    const fragment = doc.createDocumentFragment()
    // The split keeps the separators, so the prose reflows to exactly the same shape.
    for (const token of original.split(/(\s+)/)) {
      if (token.length === 0) continue
      if (/^\s+$/.test(token)) {
        fragment.appendChild(doc.createTextNode(token))
        continue
      }
      const span = doc.createElement('span')
      span.setAttribute('data-word', '')
      span.textContent = token
      fragment.appendChild(span)
      words.push(span)
    }
    const first = fragment.firstChild
    parent.replaceChild(fragment, text)
    undo.push(() => {
      // Collapse the scaffolding back to the single text node it came from.
      if (!first || !first.parentNode) return
      const restored = doc.createTextNode(original)
      const p = first.parentNode
      let cursor: ChildNode | null = first
      const doomed: ChildNode[] = []
      let remaining = original.length
      while (cursor && remaining > 0) {
        remaining -= (cursor.textContent ?? '').length
        doomed.push(cursor)
        cursor = cursor.nextSibling
      }
      p.insertBefore(restored, doomed[0])
      for (const node of doomed) node.remove()
    })
  }

  return { words, restore: () => undo.forEach((fn) => fn()) }
}

/**
 * The sentence writing itself in, word by word (§11).
 *
 * The one indulgence in the product, and the only place a stagger is spent on prose.
 * Under reduced motion the sentence **appears whole** — never typed — as a 120ms
 * opacity fade.
 */
export async function writeInWords(el: HTMLElement): Promise<void> {
  const { animate } = await import('animejs')

  if (shouldReduceMotion()) {
    await animate(el, { opacity: [0, 1], duration: REDUCED_MS, ease: 'linear' })
    return
  }

  const timings = wordTimings(el.textContent ?? '')
  const { words, restore } = splitWords(el)
  if (words.length === 0) {
    await animate(el, { opacity: [0, 1], duration: REDUCED_MS, ease: 'linear' })
    return
  }

  el.style.opacity = '1'
  try {
    // anime.js v4 resolves a per-target value by calling back with (target, index).
    const durationFor: FunctionValue = (_target, index) =>
      timings[index ?? 0]?.durationMs ?? MIN_WORD_FADE_MS
    const delayFor: FunctionValue = (_target, index) => timings[index ?? 0]?.delayMs ?? 0

    await animate(words, {
      opacity: [0, 1],
      duration: durationFor,
      delay: delayFor,
      ease: 'linear',
    })
  } finally {
    restore()
    el.style.opacity = ''
  }
}
