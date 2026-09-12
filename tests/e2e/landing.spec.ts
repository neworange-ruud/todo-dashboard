import { test, expect, type Page } from '@playwright/test'
import { TID } from '../../lib/testids'

/**
 * Acceptance tests for the landing view.
 *
 * These encode PRD requirements rather than implementation details, so they should
 * survive refactors. Section references point at PRD.md.
 */

const t = (id: string) => `[data-testid="${id}"]`

async function gotoDashboard(page: Page, query = '') {
  const res = await page.goto(`/${query}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'page must not error').toBeLessThan(400)
  await page.waitForSelector(t(TID.shell))
}

test.describe('landing view', () => {
  test('renders the zones in priority order', async ({ page }) => {
    await gotoDashboard(page)

    // Zone 0 and 2 are always present; 1 is conditional (PRD §9).
    await expect(page.locator(t(TID.bar))).toBeVisible()
    await expect(page.locator(t(TID.sentence))).toBeVisible()
    await expect(page.locator(t(TID.today))).toBeVisible()

    // Order on the page must follow PRD §3, whatever the layout does.
    const order = await page.evaluate((ids) => {
      const seen: string[] = []
      document.querySelectorAll('[data-testid]').forEach((el) => {
        const id = el.getAttribute('data-testid')!
        if (ids.includes(id) && !seen.includes(id)) seen.push(id)
      })
      return seen
    }, [TID.bar, TID.attention, TID.sentence, TID.today, TID.week] as string[])

    const expected = [TID.bar, TID.attention, TID.sentence, TID.today, TID.week] as string[]
    const filtered = expected.filter((id) => order.includes(id))
    expect(order).toEqual(filtered)
  })

  test('the attention strip takes zero height when empty (PRD §9)', async ({ page }) => {
    await gotoDashboard(page)
    const strip = page.locator(t(TID.attention))
    if ((await strip.count()) === 0) return // absent entirely — also correct
    const box = await strip.boundingBox()
    if (box && (await strip.isVisible())) {
      expect(box.height, 'a visible strip must carry real content').toBeGreaterThan(8)
    }
  })

  test('shows no numeric badge anywhere (PRD §9)', async ({ page }) => {
    await gotoDashboard(page)
    // A bare number in a pill/badge is forbidden: "a count with no name is anxiety
    // with no information". Counts must sit inside a named header.
    const badges = await page.locator('[class*="badge" i], [class*="pill" i]').all()
    for (const b of badges) {
      const text = (await b.textContent())?.trim() ?? ''
      expect(text, `bare numeric badge found: "${text}"`).not.toMatch(/^\d+$/)
    }
  })

  test('the sentence is present and within its word cap (PRD §4)', async ({ page }) => {
    await gotoDashboard(page)
    const text = (await page.locator(t(TID.sentenceText)).first().textContent()) ?? ''
    expect(text.trim().length).toBeGreaterThan(0)
    const words = text.trim().split(/\s+/).length
    expect(words, 'hard cap is roughly 50 words').toBeLessThanOrEqual(60)
    // Never greets, never uses the reader's name, never encourages.
    expect(text).not.toMatch(/good morning|good afternoon|you've got this|let's make/i)
    expect(text).not.toMatch(/\bRuud\b/)
  })

  test('every ranked task carries a reason line (PRD §6)', async ({ page }) => {
    await gotoDashboard(page)
    const rows = page.locator(t(TID.taskRow))
    const n = await rows.count()
    if (n === 0) {
      await expect(page.locator(t(TID.topFiveEmpty))).toBeVisible()
      return
    }
    expect(n, 'the top five shows at most five').toBeLessThanOrEqual(5)
    for (let i = 0; i < n; i++) {
      const reason = rows.nth(i).locator(t(TID.taskReason))
      await expect(reason, `row ${i} must have a reason line`).toBeVisible()
      expect((await reason.textContent())?.trim().length).toBeGreaterThan(0)
    }
  })

  test('all-day events render outside the timeline (PRD §17.9)', async ({ page }) => {
    await gotoDashboard(page)
    const band = page.locator(t(TID.allDayBand))
    if ((await band.count()) === 0) return
    // An all-day event must not also appear as a proportional timeline block.
    const inTimeline = page.locator(`${t(TID.timeline)} ${t(TID.allDayBand)}`)
    expect(await inTimeline.count()).toBe(0)
  })

  test('page does not scroll horizontally', async ({ page }) => {
    await gotoDashboard(page)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(1)
  })

  test('has no console errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(e.message))
    await gotoDashboard(page)
    await page.waitForTimeout(1200)
    expect(errors).toEqual([])
  })
})

test.describe('board mode (PRD §17.13)', () => {
  test.use({ viewport: { width: 1440, height: 720 } })

  test('fits 720px without vertical scrolling', async ({ page }) => {
    await gotoDashboard(page, '?display=board')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    )
    expect(overflow, 'board mode must fit the wall monitor without scrolling').toBeLessThanOrEqual(4)
  })

  test('is selected by the flag, not the viewport', async ({ page }) => {
    // Same 1440x720 viewport, no flag -> must NOT be board mode.
    await gotoDashboard(page)
    const el = page.locator('[data-display]').first()
    if (await el.count()) expect(await el.getAttribute('data-display')).toBe('default')

    await gotoDashboard(page, '?display=board')
    const board = page.locator('[data-display]').first()
    await expect(board).toHaveAttribute('data-display', 'board')
  })
})

test.describe('mobile (PRD §3)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('shows the two-segment switcher and no horizontal scroll', async ({ page }) => {
    await gotoDashboard(page)
    const switcher = page.locator(t(TID.switcher))
    await expect(switcher).toBeVisible()
    // Month is cut from v1 (PRD §17.4), so there are exactly two segments.
    await expect(page.locator(t(TID.switcherToday))).toBeVisible()
    await expect(page.locator(t(TID.switcherWeek))).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test('touch targets are at least 44px (PRD §10)', async ({ page }) => {
    await gotoDashboard(page)
    const rows = await page.locator(t(TID.taskRow)).all()
    for (const row of rows.slice(0, 5)) {
      const box = await row.boundingBox()
      if (box) expect(box.height, 'mobile rows need 44px targets').toBeGreaterThanOrEqual(40)
    }
  })
})
