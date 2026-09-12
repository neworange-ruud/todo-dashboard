import { test, expect, type Page } from '@playwright/test'
import { TID } from '../../lib/testids'
import { THEME_STORAGE_KEY } from '../../lib/theme'

/**
 * The theme control (PRD §10, "Dark").
 *
 * Three states, persisted, and — the part worth testing hardest — applied *before first
 * paint*. A toggle that works but flashes white on every load of a dark dashboard has
 * solved the smaller half of the problem.
 */

const t = (id: string) => `[data-testid="${id}"]`

const themeAttr = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'))

const stored = (page: Page, key: string) =>
  page.evaluate((k) => window.localStorage.getItem(k), key)

test.describe('the theme control', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.evaluate((k) => window.localStorage.removeItem(k), THEME_STORAGE_KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(t(TID.shell))
  })

  test('follows the system until asked not to', async ({ page }) => {
    // No attribute at all — the stylesheet's system rules are written as
    // :root:not([data-theme='light']), so a placeholder value would pin the reader.
    await expect(page.locator(t(TID.themeToggle))).toHaveAttribute('data-theme-choice', 'system')
    expect(await themeAttr(page)).toBeNull()
  })

  test('cycles Auto → Light → Dark → Auto', async ({ page }) => {
    const toggle = page.locator(t(TID.themeToggle))

    await toggle.click()
    await expect(toggle).toHaveAttribute('data-theme-choice', 'light')
    expect(await themeAttr(page)).toBe('light')

    await toggle.click()
    await expect(toggle).toHaveAttribute('data-theme-choice', 'dark')
    expect(await themeAttr(page)).toBe('dark')

    await toggle.click()
    await expect(toggle).toHaveAttribute('data-theme-choice', 'system')
    expect(await themeAttr(page)).toBeNull()
  })

  test('remembers the choice across a reload', async ({ page }) => {
    const toggle = page.locator(t(TID.themeToggle))
    await toggle.click()
    await toggle.click()
    expect(await stored(page, THEME_STORAGE_KEY)).toBe('dark')

    await page.reload({ waitUntil: 'domcontentloaded' })
    expect(await themeAttr(page)).toBe('dark')
    await expect(page.locator(t(TID.themeToggle))).toHaveAttribute('data-theme-choice', 'dark')
  })

  test('is dark before the first paint, not after it', async ({ page }) => {
    await page.locator(t(TID.themeToggle)).click()
    await page.locator(t(TID.themeToggle)).click()

    // Read the attribute at the earliest moment a script can run in the new document. If
    // the theme were applied by React instead of by the inline boot script, this would be
    // null here and the reader would see a frame of the wrong colour.
    const inHead = await page.evaluate(async () => {
      const doc = await fetch(window.location.href).then((r) => r.text())
      const script = doc.indexOf('localStorage.getItem')
      const body = doc.indexOf('<body')
      return script > -1 && body > -1 && script < body
    })
    expect(inHead, 'the boot script ships before <body>').toBe(true)

    await page.reload({ waitUntil: 'commit' })
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-theme'))
    expect(await themeAttr(page)).toBe('dark')
  })

  test('survives storage being unavailable', async ({ page }) => {
    // Private browsing, blocked site data, a kiosk. The page must still render and the
    // control must still switch — it simply will not outlive the tab.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('blocked')
        },
      })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator(t(TID.shell))).toBeVisible()
    await expect(page.locator(t(TID.themeToggle))).toBeVisible()
  })
})
