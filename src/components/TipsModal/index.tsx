import { useEffect, useCallback } from 'react'
import styles from './TipsModal.module.css'

interface TipsModalProps {
  onClose: () => void
}

const sections = [
  {
    title: 'Background',
    icon: '🟫',
    tips: [
      'Use a plain, uniform background — a white wall or sheet of card is ideal.',
      'Any colour works as long as it is consistent across the whole shot.',
    ],
  },
  {
    title: 'Rotation',
    icon: '🔄',
    tips: [
      'Rotate the object — keep the phone still.',
      'Hold by the cap or top so your hands stay above the label and out of frame.',
      'Rotate slowly and steadily to avoid motion blur.',
    ],
  },
  {
    title: 'Lighting',
    icon: '💡',
    tips: [
      'Use even, diffuse light — an overcast day or a well-lit room is ideal.',
      'Avoid direct sunlight or a single strong lamp. Moving glare spots on the label confuse the stitching.',
    ],
  },
  {
    title: 'Framing',
    icon: '📐',
    tips: [
      'Get close enough that the label fills most of the frame height.',
      'Keep the bottle vertical — don\'t tilt it.',
      'Maintain a consistent distance throughout the rotation.',
    ],
  },
  {
    title: 'Video mode',
    icon: '🎥',
    tips: [
      '8–12 seconds is plenty — rotate slowly.',
      'Brace your elbow on a table to keep the phone steady.',
    ],
  },
]

export function TipsModal({ onClose }: TipsModalProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div className={styles.backdrop} onClick={onClose} role="dialog" aria-modal="true" aria-label="Tips for best results">
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Tips for best results</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close tips">✕</button>
        </div>
        <div className={styles.body}>
          {sections.map((section) => (
            <div key={section.title} className={styles.section}>
              <h3 className={styles.sectionTitle}>
                <span className={styles.sectionIcon}>{section.icon}</span>
                {section.title}
              </h3>
              <ul className={styles.tipList}>
                {section.tips.map((tip, i) => (
                  <li key={i} className={styles.tipItem}>{tip}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
