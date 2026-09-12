/**
 * Font loading for Task Desk (PRD §10 — "Type — two voices").
 *
 * Newsreader carries anything written FOR the reader: the daily sentence,
 * drill-in titles, AI prose.
 *
 * IBM Plex Sans carries anything read FROM a system: meeting/task titles,
 * body copy, attendees, summaries.
 *
 * IBM Plex Mono carries times, labels and meta — anything that benefits
 * from a fixed-width, instrument-panel feel.
 *
 * Each is exposed as a CSS variable so app/layout.tsx can wire it onto
 * <html>, and globals.css can consume it via var(--font-serif) etc.
 */
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google'

export const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['300', '400'],
  style: ['normal', 'italic'],
  variable: '--font-serif',
  display: 'swap',
})

export const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
})

export const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})
