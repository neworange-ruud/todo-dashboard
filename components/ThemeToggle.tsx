'use client'

import { useCallback, useSyncExternalStore } from 'react'

import { TID, testid } from '@/lib/testids'
import {
  THEME_LABELS,
  THEME_STORAGE_KEY,
  applyTheme,
  nextTheme,
  readStoredTheme,
  writeStoredTheme,
  type Theme,
} from '@/lib/theme'
import styles from './zones.module.css'

/**
 * The theme control (PRD §10, "Dark").
 *
 * Cycles *Auto → Light → Dark* and remembers the choice in `localStorage`. Sits beside the
 * sync marker in the bar, in the same mono 11px, because it is the same kind of thing: a
 * persistent setting that should be findable and never prominent.
 *
 * **The colours are already correct before this component exists.** A script in `<head>`
 * stamps the stored choice on `<html>` before first paint (`THEME_BOOT_SCRIPT`), so this
 * owns the *control*, not the appearance.
 *
 * `localStorage` is an external store, so it is read through `useSyncExternalStore` rather
 * than copied into state by an effect. That is what makes the server render (`system`, the
 * only honest answer without a browser) hand over cleanly to the real stored value, and it
 * gets the cross-tab case for free: two windows of the same dashboard cannot end up
 * disagreeing about what they are.
 */

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Local subscribers, so our own writes notify this tab as well as the others. */
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)

  // Another tab changed the choice: adopt both the value and the appearance.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return
    applyTheme(readStoredTheme(), document.documentElement)
    emit()
  }
  window.addEventListener('storage', onStorage)

  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** Returns a string, so React's referential check compares by value and cannot loop. */
function getSnapshot(): Theme {
  return readStoredTheme()
}

/** The server has no store. `system` is the only answer that is true for every reader. */
function getServerSnapshot(): Theme {
  return 'system'
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const cycle = useCallback(() => {
    const next = nextTheme(readStoredTheme())
    applyTheme(next, document.documentElement)
    writeStoredTheme(next)
    emit()
  }, [])

  return (
    <button
      type="button"
      className={styles.themeButton}
      onClick={cycle}
      data-theme-choice={theme}
      aria-label={`Theme: ${THEME_LABELS[theme]}. Switch to ${THEME_LABELS[nextTheme(theme)]}.`}
      title={`Theme: ${THEME_LABELS[theme]}`}
      suppressHydrationWarning
      {...testid(TID.themeToggle)}
    >
      <span className={styles.themeGlyph} aria-hidden="true">
        {theme === 'dark' ? '◑' : theme === 'light' ? '◐' : '◒'}
      </span>
      <span className="num" suppressHydrationWarning>
        {THEME_LABELS[theme]}
      </span>
    </button>
  )
}
