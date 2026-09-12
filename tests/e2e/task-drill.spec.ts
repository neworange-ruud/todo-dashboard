import { test, expect, type Page } from '@playwright/test'
import { TID } from '../../lib/testids'
import { ISSUE_BLOCK_ORDER } from '../../lib/drill/blocks'

/**
 * The task drill-in (PRD §8, "Other drill-in types").
 *
 * Driven through a real task from the top five rather than a fixed identifier: the board
 * turns over, and a spec pinned to RW-769 would be reporting on Linear's housekeeping
 * rather than on this panel.
 */

const t = (id: string) => `[data-testid="${id}"]`

async function openFirstTask(page: Page): Promise<boolean> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(t(TID.shell))
  const rows = page.locator(`${t(TID.taskRow)} a[href*="drill=issue:"]`)
  if ((await rows.count()) === 0) return false
  await rows.first().click()
  await page.waitForSelector(t(TID.panel), { timeout: 15_000 })
  return true
}

const blockIds = (page: Page) =>
  page
    .locator(t(TID.panel))
    .locator(t(TID.panelBlock))
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-block-id') ?? ''))

test.describe('the task drill-in', () => {
  test('lays out the task vocabulary, five containers, immediately', async ({ page }) => {
    test.skip(!(await openFirstTask(page)), 'no tasks on the board')

    // A task is a different question from a meeting and gets a different five (PRD §8).
    expect(await blockIds(page)).toEqual([...ISSUE_BLOCK_ORDER])

    const blocks = page.locator(t(TID.panel)).locator(t(TID.panelBlock))
    for (let i = 0; i < (await blocks.count()); i++) {
      await expect(blocks.nth(i).locator(t(TID.panelBlockStatus))).toBeVisible()
    }
  })

  test('nothing reorders as the slow blocks land', async ({ page }) => {
    test.skip(!(await openFirstTask(page)), 'no tasks on the board')
    const before = await blockIds(page)
    await page.waitForTimeout(8000) // the transcript read and both searches
    expect(await blockIds(page), 'a late block fills in where it always was').toEqual(before)
  })

  test('states the task itself without waiting on anything', async ({ page }) => {
    test.skip(!(await openFirstTask(page)), 'no tasks on the board')
    const detail = page.locator('[data-block-id="issue-detail"]')
    // Pure Linear data the page already holds: this block has nothing to fail on.
    await expect(detail).toHaveAttribute('data-block-status', 'ok', { timeout: 15_000 })
  })

  test('resolves every block to a rendered state, never to a spinner', async ({ page }) => {
    test.skip(!(await openFirstTask(page)), 'no tasks on the board')

    for (const id of ISSUE_BLOCK_ORDER) {
      // ok / empty / failed are all honest outcomes; `loading` forever is not (PRD §8).
      await expect
        .poll(
          async () =>
            page.locator(`[data-block-id="${id}"]`).getAttribute('data-block-status'),
          { timeout: 45_000, message: `${id} never settled` },
        )
        .toMatch(/^(ok|empty|failed)$/)
    }
  })

  test('ends with the one action, bottom of the panel', async ({ page }) => {
    test.skip(!(await openFirstTask(page)), 'no tasks on the board')
    await expect(page.locator(t(TID.panelAction))).toContainText('Open in Linear')
  })

  test('drills from a task to a meeting it was discussed in, on one trail', async ({ page }) => {
    test.skip(!(await openFirstTask(page)), 'no tasks on the board')

    const meetings = page.locator('[data-block-id="meetings"]')
    await expect
      .poll(async () => meetings.getAttribute('data-block-status'), { timeout: 45_000 })
      .toMatch(/^(ok|empty|failed)$/)
    test.skip(
      (await meetings.getAttribute('data-block-status')) !== 'ok',
      'no meetings found for this task',
    )

    const row = meetings.locator('[data-drill^="meeting:"]')
    test.skip((await row.count()) === 0, 'no meeting row carried a calendar id')

    await row.first().click()
    await page.waitForTimeout(1500)

    // One panel, always — the hop pushes onto the trail inside it (PRD §8).
    await expect(page.locator(t(TID.panel))).toHaveCount(1)
    expect(await page.locator(t(TID.panelCrumb)).count()).toBeGreaterThan(1)
    // And it is a meeting panel now, so the vocabulary swaps with it.
    expect(await blockIds(page)).toContain('attendees')
  })

  test('survives a refresh at its own address', async ({ page }) => {
    test.skip(!(await openFirstTask(page)), 'no tasks on the board')
    expect(page.url()).toContain('drill=issue:')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator(t(TID.panel))).toBeVisible({ timeout: 15_000 })
  })
})
