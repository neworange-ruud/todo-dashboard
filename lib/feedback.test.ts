import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'taskdesk-feedback-'))
process.env.TASK_DESK_STATE_DIR = dir

const { record, hydrate, isDismissed, resetDismissals, LOG_FILE } = await import('./feedback')

beforeEach(() => resetDismissals())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('AI feedback log (PRD §9)', () => {
  it('records the item, the block and the output', async () => {
    await record({ kind: 'not-right', subject: 'meeting:abc', blockId: 'last-time', output: 'wrong prose' })
    expect(existsSync(LOG_FILE)).toBe(true)
    const last = readFileSync(LOG_FILE, 'utf8').trim().split('\n').pop()!
    const entry = JSON.parse(last)
    expect(entry).toMatchObject({
      kind: 'not-right',
      subject: 'meeting:abc',
      blockId: 'last-time',
      output: 'wrong prose',
    })
    expect(entry.at).toBeTruthy()
    expect(entry.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('hides a dismissed block for that item only', async () => {
    await record({ kind: 'not-right', subject: 'meeting:abc', blockId: 'unresolved', output: 'x' })
    expect(isDismissed('meeting:abc', 'unresolved')).toBe(true)
    expect(isDismissed('meeting:abc', 'attendees'), 'other blocks unaffected').toBe(false)
    expect(isDismissed('meeting:other', 'unresolved'), 'other items unaffected').toBe(false)
  })

  it('regenerate does not dismiss', async () => {
    await record({ kind: 'regenerate', subject: 'meeting:z', blockId: 'last-time', output: 'x' })
    expect(isDismissed('meeting:z', 'last-time')).toBe(false)
  })

  it('rebuilds today’s dismissals from the log after a restart', async () => {
    await record({ kind: 'not-right', subject: 'meeting:restart', blockId: 'account', output: 'x' })
    resetDismissals()
    expect(isDismissed('meeting:restart', 'account'), 'cleared in memory').toBe(false)
    await hydrate()
    expect(isDismissed('meeting:restart', 'account'), 'restored from disk').toBe(true)
  })

  it('does not resurrect a dismissal from another day', async () => {
    await record({ kind: 'not-right', subject: 'meeting:old', blockId: 'account', output: 'x' })
    resetDismissals()
    await hydrate('1999-01-01')
    expect(isDismissed('meeting:old', 'account')).toBe(false)
  })

  it('survives a truncated final line', async () => {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(LOG_FILE, '{"kind":"not-right","subj')
    resetDismissals()
    await expect(hydrate()).resolves.toBeUndefined()
  })
})
