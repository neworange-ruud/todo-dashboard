import { TID, testid } from '@/lib/testids'
import type { AttentionItem } from '@/lib/types'
import styles from './zones.module.css'

export interface AttentionProps {
  items: AttentionItem[]
}

/** A fourth item and beyond collapse into one named line (PRD §9). */
const MAX_ITEMS = 3

/**
 * Zone 1 — the attention strip (PRD §9).
 *
 * Conditional, and absent on a normal day. When nothing qualifies it renders
 * **nothing at all** — returning `null` rather than an empty element, so the strip
 * takes zero height instead of collapsing to a hairline the reader still has to
 * parse. That is the difference between calm and a permanently reserved slot.
 *
 * Everything here is named in full: no badges, no counts, no red dot on an icon.
 * A count with no name is anxiety with no information.
 */
export default function Attention({ items }: AttentionProps) {
  if (items.length === 0) return null

  const shown = items.slice(0, MAX_ITEMS)
  const overflow = items.length - shown.length

  return (
    <section className={styles.attention} aria-label="Needs attention" {...testid(TID.attention)}>
      {shown.map((item) => (
        <a
          key={`${item.href}:${item.text}`}
          href={item.href}
          className={`${styles.attentionItem} stripe list-row`}
        >
          <span className={styles.attentionLabel}>NEEDS ATTENTION</span>
          <span className={styles.attentionText}>{item.text}</span>
        </a>
      ))}
      {overflow > 0 && (
        <p className={styles.attentionMore}>
          and <span className="num">{overflow}</span> more
        </p>
      )}
    </section>
  )
}
