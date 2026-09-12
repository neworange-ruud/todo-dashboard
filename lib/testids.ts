/**
 * Stable hooks for end-to-end tests.
 *
 * Kept in one place so Playwright specs and components cannot drift apart. Components
 * spread these onto `data-testid`; specs select by them. Adding a test id is cheap —
 * renaming one is a breaking change, so treat this file as a contract.
 */
export const TID = {
  // Zones (PRD §3)
  shell: 'shell',
  bar: 'zone-bar',
  attention: 'zone-attention',
  sentence: 'zone-sentence',
  today: 'zone-today',
  week: 'zone-week',

  // Bar (PRD §9)
  syncMarker: 'sync-marker',
  refreshButton: 'refresh-button',

  // Date override (PRD §17.14)
  dateLabel: 'date-label',
  datePrev: 'date-prev',
  dateNext: 'date-next',
  previewMark: 'preview-mark',

  /** Theme control (PRD §10). */
  themeToggle: 'theme-toggle',

  // Sentence (PRD §4)
  sentenceText: 'sentence-text',
  sentenceEntity: 'sentence-entity',

  // Timeline (PRD §5)
  timeline: 'timeline',
  allDayBand: 'all-day-band',
  timelineEvent: 'timeline-event',
  timelineGap: 'timeline-gap',
  nowRule: 'now-rule',
  nowButton: 'now-button',

  // Top five (PRD §6)
  topFive: 'top-five',
  taskRow: 'task-row',
  taskReason: 'task-reason',
  taskStateDot: 'task-state-dot',
  topFiveEmpty: 'top-five-empty',

  /** Inline "source unreachable" line above a zone that is still rendering cached data. */
  unavailable: 'zone-unavailable',
  /** The board-mode "more" affordance on the clamped sentence. */
  sentenceMore: 'sentence-more',
  /** Header count naming the remainder when board mode caps a list. */
  topFiveCount: 'top-five-count',

  // Week (PRD §7)
  loadLanes: 'load-lanes',
  loadLane: 'load-lane',
  dueThisWeek: 'due-this-week',
  dueRow: 'due-row',
  needsPlanning: 'needs-planning',
  planningRow: 'planning-row',
  newMarker: 'new-marker',
  sourceRef: 'source-ref',

  // Mobile (PRD §3)
  switcher: 'horizon-switcher',
  switcherToday: 'switcher-today',
  switcherWeek: 'switcher-week',

  // Drill-in (PRD §8)
  panel: 'drill-panel',
  panelClose: 'drill-close',
  panelCrumb: 'drill-crumb',
  panelBlock: 'drill-block',
  panelBlockStatus: 'drill-block-status',
  panelAction: 'drill-action',
  skeleton: 'skeleton',
} as const

export type TestId = (typeof TID)[keyof typeof TID]

/** `<div {...testid(TID.bar)}>` */
export function testid(id: TestId): { 'data-testid': TestId } {
  return { 'data-testid': id }
}
