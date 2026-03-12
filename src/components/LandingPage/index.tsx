import { useState } from 'react'
import styles from './LandingPage.module.css'
import { TipsModal } from '../TipsModal'

interface LandingPageProps {
  onStart: () => void
}

const BUILD_DATE = new Date(__BUILD_DATE__)
const BUILD_LABEL = BUILD_DATE.toLocaleString('en-GB', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
})

const steps = [
  {
    number: '1',
    title: 'Choose your background',
    body: 'Place the object in front of a plain, uniform background — a white wall or sheet of card works best.',
  },
  {
    number: '2',
    title: 'Position and capture',
    body: 'Keep the phone still and rotate the object. Hold it by the cap so your hands stay above the label. In photo mode, overlap each shot by ~30%.',
  },
  {
    number: '3',
    title: 'Review & process',
    body: 'Delete any blurry frames, then tap Process. The app stitches them into one flat image.',
  },
  {
    number: '4',
    title: 'Save or share',
    body: 'Download the unwrapped label to your device or share it directly.',
  },
]

export function LandingPage({ onStart }: LandingPageProps) {
  const [showTips, setShowTips] = useState(false)

  return (
    <div className={styles.container}>
      <div className={styles.hero}>
        <div className={styles.icon} aria-hidden="true">
          <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="8" y="16" width="48" height="32" rx="4" fill="currentColor" opacity="0.15" />
            <path d="M8 20 Q32 12 56 20 L56 44 Q32 52 8 44 Z" fill="currentColor" opacity="0.3" />
            <rect x="14" y="22" width="36" height="20" rx="2" stroke="currentColor" strokeWidth="2" fill="none" />
            <line x1="22" y1="22" x2="22" y2="42" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
            <line x1="32" y1="22" x2="32" y2="42" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
            <line x1="42" y1="22" x2="42" y2="42" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
          </svg>
        </div>
        <h1 className={styles.title}>
          Label<span>Un</span>Wrap
        </h1>
        <p className={styles.tagline}>
          Photograph a cylindrical label and get a flat image — right on your phone.
        </p>
      </div>

      <ol className={styles.steps}>
        {steps.map((step) => (
          <li key={step.number} className={styles.step}>
            <span className={styles.stepNumber}>{step.number}</span>
            <div className={styles.stepText}>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <button className={styles.tipsButton} onClick={() => setShowTips(true)}>
        Tips for best results ›
      </button>

      <button className={styles.startButton} onClick={onStart}>
        Get Started
      </button>

      <footer className={styles.versionInfo}>
        <span>v{__GIT_HASH__}</span>
        <span className={styles.dot}>·</span>
        <span>{BUILD_LABEL}</span>
      </footer>

      {showTips && <TipsModal onClose={() => setShowTips(false)} />}
    </div>
  )
}
