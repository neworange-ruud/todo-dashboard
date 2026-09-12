import { NextResponse } from 'next/server'
import { record, hydrate, type FeedbackKind } from '@/lib/feedback'

export const runtime = 'nodejs'

/**
 * Records that a synthesised block was wrong (PRD §9).
 *
 * Read-only product, one deliberate exception: this writes to the app's own log and
 * touches no external system. See lib/feedback.ts.
 */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { kind, subject, blockId, output, sources } = (body ?? {}) as Record<string, unknown>
  if (
    (kind !== 'regenerate' && kind !== 'not-right') ||
    typeof subject !== 'string' ||
    typeof blockId !== 'string'
  ) {
    return NextResponse.json({ error: 'kind, subject and blockId are required' }, { status: 400 })
  }

  await hydrate()
  await record({
    kind: kind as FeedbackKind,
    subject,
    blockId,
    output: typeof output === 'string' ? output.slice(0, 4000) : '',
    sources: Array.isArray(sources) ? sources.filter((s): s is string => typeof s === 'string') : undefined,
  })

  return NextResponse.json({ ok: true })
}
