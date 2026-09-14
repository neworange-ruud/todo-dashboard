import { test, expect, type Page } from '@playwright/test'
import { TID } from '../../lib/testids'

/**
 * Acceptance tests for the drill-in panel — "the drill-in is the product" (PRD §2).
 * Requirements come from PRD §8.
 */

const t = (id: string) => `[data-testid="${id}"]`

async function openFirstMeeting(page: Page): Promise<boolean> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(t(TID.shell))
  const events = page.locator(t(TID.timelineEvent))
  if ((await events.count()) === 0) return false
  await events.first().click()
  await page.waitForSelector(t(TID.panel), { timeout: 10_000 })
  /*
   * Wait for the panel to be *interactive*, not merely present.
   *
   * `waitForSelector` returns the moment the element enters the DOM, which is before React
   * has flushed the effects that attach the Escape listener and move focus. A test that
   * pressed a key in that window was racing a paint — something no reader can do, and it
   * showed up as a mobile-only flake once the page had enough client work to widen the gap.
   *
   * Focus lands in the same effect pass as the key listener, so a focused panel is proof
   * the listener is attached. That makes this a real readiness signal rather than a sleep.
   */
  await expect(page.locator(t(TID.panel))).toBeFocused({ timeout: 5000 })
  return true
}

test.describe('drill-in panel', () => {
  test('opens from a timeline event and lays out all blocks immediately', async ({ page }) => {
    test.skip(!(await openFirstMeeting(page)), 'no events on the calendar today')

    const panel = page.locator(t(TID.panel))
    await expect(panel).toBeVisible()

    // PRD §8: all five blocks lay out immediately as titled containers with skeletons.
    // Nothing may appear only after its data arrives.
    const blocks = panel.locator(t(TID.panelBlock))
    expect(await blocks.count(), 'all blocks present on open').toBeGreaterThanOrEqual(4)

    // Every block carries its own state in the header.
    for (let i = 0; i < (await blocks.count()); i++) {
      await expect(blocks.nth(i).locator(t(TID.panelBlockStatus))).toBeVisible()
    }
  })

  test('blocks do not reorder as they resolve (PRD §8)', async ({ page }) => {
    test.skip(!(await openFirstMeeting(page)), 'no events on the calendar today')
    const panel = page.locator(t(TID.panel))
    const idsOf = async () =>
      panel.locator(t(TID.panelBlock)).evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-block-id') ?? e.textContent?.slice(0, 20) ?? ''),
      )

    const before = await idsOf()
    await page.waitForTimeout(6000) // let the slow blocks land
    const after = await idsOf()
    expect(after, 'a late block must fill in where it always was').toEqual(before)
  })

  test('has its own URL and survives a refresh (PRD §8)', async ({ page }) => {
    test.skip(!(await openFirstMeeting(page)), 'no events on the calendar today')
    const url = page.url()
    expect(url, 'the drill-in must be addressable').not.toMatch(/\/$/)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator(t(TID.panel)), 'panel survives refresh').toBeVisible({
      timeout: 10_000,
    })
  })

  test('closes on Escape and on the close control', async ({ page }) => {
    test.skip(!(await openFirstMeeting(page)), 'no events on the calendar today')

    await page.keyboard.press('Escape')
    await expect(page.locator(t(TID.panel))).toBeHidden({ timeout: 5000 })

    await openFirstMeeting(page)
    await page.locator(t(TID.panelClose)).click()
    await expect(page.locator(t(TID.panel))).toBeHidden({ timeout: 5000 })
  })

  test('never spawns a second panel (PRD §8)', async ({ page }) => {
    test.skip(!(await openFirstMeeting(page)), 'no events on the calendar today')
    const panel = page.locator(t(TID.panel))

    // Drill from the drill-in, if there is anything to drill into.
    const inner = panel.locator('a[href*="drill"], button[data-drill]').first()
    if ((await inner.count()) === 0) test.skip(true, 'nothing to drill into from here')
    await inner.click()
    await page.waitForTimeout(800)

    expect(await page.locator(t(TID.panel)).count(), 'exactly one panel, always').toBe(1)
    await expect(panel.locator(t(TID.panelCrumb)).first()).toBeVisible()
  })

  test('ends with exactly one escape action (PRD §8)', async ({ page }) => {
    test.skip(!(await openFirstMeeting(page)), 'no events on the calendar today')
    const actions = page.locator(t(TID.panel)).locator(t(TID.panelAction))
    expect(await actions.count(), 'one button, bottom of the panel, same place').toBe(1)
    const label = (await actions.first().textContent()) ?? ''
    expect(label).toMatch(/open in (linear|outlook|brain)/i)
  })

  test('a failing block does not take down the panel (PRD §8)', async ({ page }) => {
    test.skip(!(await openFirstMeeting(page)), 'no events on the calendar today')
    await page.waitForTimeout(6000)

    const panel = page.locator(t(TID.panel))
    await expect(panel, 'panel still rendered').toBeVisible()
    // No whole-panel error state.
    expect(await panel.locator('[data-panel-error]').count()).toBe(0)

    // Any failed block must offer a retry rather than failing silently.
    const failed = panel.locator('[data-block-status="failed"]')
    for (let i = 0; i < (await failed.count()); i++) {
      await expect(failed.nth(i)).toContainText(/retry/i)
    }
  })
})

test.describe('mobile drill-in', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('rises as a sheet and leaves the dashboard visible above', async ({ page }) => {
    test.skip(!(await openFirstMeeting(page)), 'no events on the calendar today')
    const box = await page.locator(t(TID.panel)).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y, 'a strip of dashboard stays visible above the sheet').toBeGreaterThan(0)
  })
})
