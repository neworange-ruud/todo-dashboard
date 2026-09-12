/**
 * Server-process startup hooks.
 *
 * Task Desk runs as a permanently-running local server, so the daily sentence is
 * regenerated on a schedule rather than on request: it costs a few seconds and a
 * gateway call, and PRD §4 wants it already warm when the page opens.
 *
 * Next.js calls `register()` once per server process.
 */

export async function register() {
  // Only the Node.js runtime has timers that outlive a request.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // Never run the scheduler during `next build`'s static analysis pass.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const { startSentenceScheduler } = await import('@/lib/scheduler')
  startSentenceScheduler()
}
