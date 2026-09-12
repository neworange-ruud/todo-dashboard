import { test, expect } from '@playwright/test'
import { TID } from '../../lib/testids'

/**
 * The date override (PRD §17.14) and the shape of a Wednesday (PRD §17.9, round 4).
 *
 * These two features meet here, and the meeting point is the only way to test the second
 * one end to end: the Wednesday frame is a real property of Ruud's calendar, and without
 * `?date=` it can only be seen one day in seven.
 *
 * The fixed dates are real Wednesdays on the live calendar. **16 September** holds the
 * protected morning with two genuine meetings inside it; **23 September** holds the same
 * morning empty, plus a personal commitment sitting inside the non-work afternoon. If
 * these ever stop being true the assertions below should be re-pointed at a Wednesday
 * that is, not loosened.
 */

const t = (id: string) => `[data-testid="${id}"]`

const WEDNESDAY_WITH_MEETINGS = '2026-09-16'
const WEDNESDAY_WITH_PERSONAL_BLOCK = '2026-09-23'

test.describe('the date override', () => {
  test('opens on today, and says nothing about it', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(t(TID.shell))
    // The live day is the default and the common case; a marker here would be noise.
    await expect(page.locator(t(TID.previewMark))).toHaveCount(0)
  })

  test('moves the whole dashboard to a named day', async ({ page }) => {
    await page.goto(`/?date=${WEDNESDAY_WITH_MEETINGS}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator(t(TID.dateLabel))).toContainText('Wednesday 16 September')
  })

  test('accepts a weekday name', async ({ page }) => {
    await page.goto('/?date=monday', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(t(TID.dateLabel))).toContainText('Monday')
  })

  test('never lets a preview pass for the live day (PRD §9)', async ({ page }) => {
    await page.goto(`/?date=${WEDNESDAY_WITH_MEETINGS}`, { waitUntil: 'domcontentloaded' })
    const mark = page.locator(t(TID.previewMark))
    await expect(mark).toBeVisible()

    // And it is the way back, so a preview is never a place you can get stuck.
    await mark.click()
    await page.waitForURL((url) => !url.searchParams.has('date'))
    await expect(page.locator(t(TID.previewMark))).toHaveCount(0)
  })

  test('steps a day at a time, keeping the flag in the URL', async ({ page }) => {
    await page.goto(`/?date=${WEDNESDAY_WITH_MEETINGS}`, { waitUntil: 'domcontentloaded' })
    await page.locator(t(TID.dateNext)).click()
    await expect(page.locator(t(TID.dateLabel))).toContainText('Thursday 17 September')
    await page.locator(t(TID.datePrev)).click()
    await page.locator(t(TID.datePrev)).click()
    await expect(page.locator(t(TID.dateLabel))).toContainText('Tuesday 15 September')
  })

  test('falls back to today rather than erroring on nonsense', async ({ page }) => {
    // A mistyped link opens the live day. It never opens an error page (PRD §9).
    await page.goto('/?date=not-a-date', { waitUntil: 'domcontentloaded' })
    await expect(page.locator(t(TID.shell))).toBeVisible()
    await expect(page.locator(t(TID.previewMark))).toHaveCount(0)
  })

  test('carries the viewed day into a drill-in link', async ({ page }) => {
    await page.goto(`/?date=${WEDNESDAY_WITH_MEETINGS}`, { waitUntil: 'domcontentloaded' })
    const events = page.locator(t(TID.timelineEvent))
    test.skip((await events.count()) === 0, 'no meetings drawn on that Wednesday')

    const href = await events.first().getAttribute('href')
    // Without this the dashboard behind the panel would snap back to today on click.
    expect(href).toContain(`date=${WEDNESDAY_WITH_MEETINGS}`)
    expect(href, 'the trail separator must not be escaped').toContain('drill=meeting:')
  })
})

test.describe('the shape of a Wednesday', () => {
  test('reads the protected morning as kept clear, not as free', async ({ page }) => {
    await page.goto(`/?date=${WEDNESDAY_WITH_MEETINGS}`, { waitUntil: 'domcontentloaded' })
    const clear = page.locator(`${t(TID.timelineGap)}[data-tone="clear"]`)
    await expect(clear.first()).toBeVisible()
    await expect(clear.first()).toContainText('KEPT CLEAR')
  })

  test('never draws the framing blocks as meetings', async ({ page }) => {
    await page.goto(`/?date=${WEDNESDAY_WITH_MEETINGS}`, { waitUntil: 'domcontentloaded' })
    const titles = await page
      .locator(t(TID.timelineEvent))
      .evaluateAll((els) => els.map((e) => e.textContent ?? ''))
    expect(titles.join(' ')).not.toContain('Vrij houden')
    expect(titles.join(' ')).not.toContain('Niet beschikbaar')
  })

  test('shows what is scheduled inside the non-work block, and marks it', async ({ page }) => {
    await page.goto(`/?date=${WEDNESDAY_WITH_PERSONAL_BLOCK}`, { waitUntil: 'domcontentloaded' })
    const outside = page.locator(`${t(TID.timelineEvent)}[data-outside="true"]`)
    await expect(outside.first()).toBeVisible()
    await expect(outside.first()).toContainText('Outside working hours')
  })

  test('measures the load against the morning that is actually left', async ({ page }) => {
    await page.goto(`/?date=${WEDNESDAY_WITH_MEETINGS}`, { waitUntil: 'domcontentloaded' })
    const wednesday = page.locator(t(TID.loadLane)).nth(2)
    // Before the frame was understood, both containers billed as load and this read
    // "8H 30M booked of 8H" — a solid day, on a day with two half-hour meetings in it.
    const reading = await wednesday.locator('[role="img"]').getAttribute('aria-label')
    expect(reading).toContain('of 4H')
    expect(reading).not.toContain('8H booked')
  })
})
