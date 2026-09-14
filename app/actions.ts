'use server'

import { revalidatePath } from 'next/cache'
import { invalidate } from '@/lib/cache'

/**
 * Drop the source caches and redraw (PRD §9).
 *
 * The bar's marker *is* the refresh control, and a control that only re-runs the render
 * would be a lie: `getOrFetch` would hand back the same 40-second-old Linear response and
 * the marker would still say "Synced just now". So pressing it evicts the two source
 * families and forces a real round trip.
 *
 * Only `linear:` and `graph:` are dropped. The AI caches (`sentence:`, the 12-hour
 * drill-in `synthesis:` entries, `match:`) key on an input hash and regenerate themselves
 * when the data underneath them actually changes — clearing those would turn a glance at
 * the bar into a few seconds and a gateway bill for prose that was already correct.
 *
 * The automatic poll deliberately does *not* call this: it lets the TTLs do their job, so
 * a wall monitor left on all day makes one Linear request a minute and not one per render.
 */
export async function refreshSources(): Promise<void> {
  invalidate('linear:')
  invalidate('graph:')
  revalidatePath('/', 'page')
}
