/**
 * Theme selection (PRD §10, "Dark").
 *
 * Three states, because the stylesheet already distinguishes three: no `data-theme`
 * attribute means *follow the system*, and `light` / `dark` are explicit overrides that win
 * in **either** direction. Collapsing that to a two-way switch would quietly remove the
 * ability to say "whatever this machine is doing", which for a dashboard that lives on a
 * wall monitor and a phone is the setting most worth keeping.
 *
 * Client-safe and free of React, so the pre-paint boot script and the toggle agree on the
 * storage key and the vocabulary rather than each carrying their own copy.
 */

export type Theme = 'system' | 'light' | 'dark'

export const THEMES: readonly Theme[] = ['system', 'light', 'dark']

/** Versioned, so a future change of shape cannot be read as this one. */
export const THEME_STORAGE_KEY = 'task-desk.theme.v1'

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

/** The next state in the cycle: system → light → dark → system. */
export function nextTheme(current: Theme): Theme {
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]
}

/** What the control says it will do. */
export const THEME_LABELS: Record<Theme, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
}

/**
 * Applies a choice to the document.
 *
 * `system` **removes** the attribute rather than setting a value, because the stylesheet's
 * system rules are written as `:root:not([data-theme='light'])` — a placeholder value would
 * satisfy that selector by accident and pin the reader to whichever theme the media query
 * happened to be resolving.
 */
export function applyTheme(theme: Theme, root: HTMLElement): void {
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/**
 * `window.localStorage`, or undefined where reading it is not allowed.
 *
 * **The property access itself throws** in Safari with site data fully blocked and in some
 * embedded webviews — before any method on it is called, so a try/catch *inside* a reader
 * function never runs. That is not theoretical: it took the whole theme control off the
 * page, because a component that throws during render takes its subtree with it.
 */
export function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Reads the stored choice. Falls back to `system` on anything unreadable. */
export function readStoredTheme(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Theme {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY)
    return isTheme(raw) ? raw : 'system'
  } catch {
    // Private browsing, blocked site data, a wall monitor in kiosk mode — all of which are
    // reasons to fall back to the system theme, none of which are reasons to break.
    return 'system'
  }
}

/** Writes the choice. Silently a no-op where storage is unavailable. */
export function writeStoredTheme(theme: Theme): void {
  try {
    safeStorage()?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The choice still applies to this page; it just will not outlive it — which is better
    // than refusing to switch.
  }
}

/**
 * The script that runs before first paint.
 *
 * Without it the page renders in the system theme and then snaps to the stored one a frame
 * later — the flash of wrong theme, which on a near-black dashboard is a flash of white.
 * Inlined into `<head>` above the body, so it has stamped the attribute before the browser
 * has anything to paint. Deliberately tiny, dependency-free and wrapped in try/catch: it
 * runs before React exists and must never be able to stop the page loading.
 */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`
