import { NextResponse } from 'next/server'

import {
  BLOCK_ORDER,
  BLOCK_TITLES,
  buildDrill,
  type DrillBlockId,
  type DrillPayload,
  type DrillType,
} from '@/lib/drill/meeting'

/**
 * `GET /api/drill/{type}/{id}` — the drill-in's data (PRD §8).
 *
 * Node runtime: the builder reaches Graph, Linear, Omni and Brain's MCP client, none of
 * which belong on the edge.
 *
 * **Per-block fetching.** `?block=attendees` resolves that block alone. The panel opens
 * five requests at once, which is what lets each block fill independently and what makes
 * *Retry* retry one block rather than the panel. Without the parameter the whole payload
 * is assembled, which is the useful shape for a script or a check.
 *
 * Nothing here throws a source's error text at the client verbatim — see
 * {@link sanitize}. A drill-in header is the last place an API key should surface.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TYPES: readonly DrillType[] = ['meeting', 'issue', 'person', 'account']

function isDrillType(value: string): value is DrillType {
  return (TYPES as readonly string[]).includes(value)
}

function isBlockId(value: string): value is DrillBlockId {
  return (BLOCK_ORDER as readonly string[]).includes(value)
}

export async function GET(
  request: Request,
  // Next.js 16: dynamic params arrive as a promise and must be awaited.
  context: { params: Promise<{ type: string; id: string }> },
) {
  const { type: rawType, id: rawId } = await context.params
  const id = decodeURIComponent(rawId ?? '').trim()

  if (!isDrillType(rawType) || !id) {
    return NextResponse.json({ error: 'Unknown drill target.' }, { status: 404 })
  }

  const requested = new URL(request.url).searchParams.getAll('block').filter(isBlockId)

  try {
    const payload = await buildDrill(rawType, id)
    return NextResponse.json(project(payload, requested), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    // buildDrill contains its own failures, so reaching here means something structural.
    // Even then the panel gets five containers and a per-block failure, never a dead panel.
    return NextResponse.json(fallback(rawType, id, requested, sanitize(err)), { status: 200 })
  }
}

/**
 * Narrows the payload to the requested blocks, keeping the fixed order.
 *
 * The meta (title, subtitle, action) always rides along, so whichever request lands first
 * can name the panel and no extra round trip is needed for the header.
 */
function project(payload: DrillPayload, requested: DrillBlockId[]): DrillPayload {
  if (requested.length === 0) return payload
  const wanted = new Set(requested)
  return { ...payload, blocks: payload.blocks.filter((b) => wanted.has(b.id)) }
}

function fallback(
  type: DrillType,
  id: string,
  requested: DrillBlockId[],
  error: string,
): DrillPayload {
  const ids = requested.length ? requested : [...BLOCK_ORDER]
  return {
    type,
    id,
    title: id,
    subtitle: null,
    action: { label: actionLabel(type), href: null },
    blocks: ids.map((blockId) => ({
      id: blockId,
      title: BLOCK_TITLES[blockId],
      status: 'failed' as const,
      elapsedMs: 0,
      error,
    })),
  }
}

function actionLabel(type: DrillType): string {
  if (type === 'issue') return 'Open in Linear'
  if (type === 'meeting') return 'Open in Outlook'
  return 'Open in Brain'
}

/**
 * A message safe to send to a browser.
 *
 * Errors from an HTTP client routinely carry the request that produced them, and that
 * request carries `Authorization`. Nothing from an exception body is forwarded — the
 * client gets a fixed line and the detail stays in the server log.
 */
function sanitize(err: unknown): string {
  console.error('[drill] unexpected failure', err)
  return 'Could not assemble this drill-in'
}
