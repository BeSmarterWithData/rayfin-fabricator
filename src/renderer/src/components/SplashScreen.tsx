// The startup screen. With Ray on (the default), it's his: he swims up, says hello
// and, in his own words, tells you how the startup checks are going. With Ray off,
// the Fabricator mark builds itself instead: a set of rounded-rect tiles that form
// an "F", recreated as inline SVG (one element per tile) so each block can glide
// into place. The tile/bracket geometry + blue→cyan→green gradient are shared with
// the static <FabricatorMark> so the mark matches exactly.
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { StartupStage } from '../startup'
import {
  MARK_BRACKET_RX,
  MARK_BRACKETS,
  MARK_TILE_RX,
  MARK_TILES,
  MARK_VIEWBOX,
  MarkGradient
} from './FabricatorMark'
import { Ray, RAY_MOUTH, RAY_VIEWBOX, type RayMood } from './mascot/Ray'
import { Particles, useParticles } from './mascot/Particles'
import { SpeechBubble, TYPE_MS } from './mascot/SpeechBubble'
import { useReducedMotion } from './mascot/context'
import { useRayGaze } from './mascot/gaze'
import { firstMeeting, rememberMeeting, SPLASH_LINES, splashGreeting } from './mascot/lines'

function BuildingLogo(): JSX.Element {
  const gid = 'splash-mark-' + useId().replace(/:/g, '')
  const fill = `url(#${gid})`
  return (
    <svg
      className="splash-logo"
      viewBox={MARK_VIEWBOX}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <MarkGradient id={gid} />
        <linearGradient id="splash-sheen-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.65" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="splash-logo-clip">
          {MARK_TILES.map((t) => (
            <rect key={t.cls} x={t.x} y={t.y} width={t.w} height={t.h} rx={MARK_TILE_RX} />
          ))}
          {MARK_BRACKETS.flatMap((b) =>
            b.rects.map((r, i) => (
              <rect key={`${b.cls}-${i}`} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={MARK_BRACKET_RX} />
            ))
          )}
        </clipPath>
      </defs>

      <g className="splash-logo-inner">
        {MARK_TILES.map((t) => (
          <rect
            key={t.cls}
            className={`tile ${t.cls}`}
            x={t.x}
            y={t.y}
            width={t.w}
            height={t.h}
            rx={MARK_TILE_RX}
            fill={fill}
          />
        ))}
        {MARK_BRACKETS.map((b) => (
          <g key={b.cls} className={`tile bracket ${b.cls}`} fill={fill}>
            {b.rects.map((r, i) => (
              <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={MARK_BRACKET_RX} />
            ))}
          </g>
        ))}
      </g>

      {/* A soft highlight that sweeps across the assembled mark, clipped to its shape. */}
      <g clipPath="url(#splash-logo-clip)">
        <rect className="splash-sheen" x="0" y="0" width="150" height="424" fill="url(#splash-sheen-grad)" />
      </g>
    </svg>
  )
}

/** Each line stays up at least this long, so none flashes by unread. */
const LINE_MS = 1700
/** When a step takes a while, Ray moves on to its next line this often. */
const ROTATE_MS = 3600
const RAY_W = 200
const RAY_H = (RAY_W * RAY_VIEWBOX.h) / RAY_VIEWBOX.w

/** The mark's tiles, cropped to their bounds so the F can sit on a baseline. */
const F_BOUNDS = MARK_TILES.reduce(
  (b, t) => ({
    x1: Math.min(b.x1, t.x),
    y1: Math.min(b.y1, t.y),
    x2: Math.max(b.x2, t.x + t.w),
    y2: Math.max(b.y2, t.y + t.h)
  }),
  { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
)
const F_VIEWBOX = `${F_BOUNDS.x1} ${F_BOUNDS.y1} ${F_BOUNDS.x2 - F_BOUNDS.x1} ${F_BOUNDS.y2 - F_BOUNDS.y1}`

/**
 * Where each of the F's tiles glides in from, in the mark's units, and when: the
 * same moves as the self-building mark, at word size.
 */
const F_TILE_IN: Record<string, { x: number; y: number; order: number }> = {
  'tile--stem': { x: -120, y: 0, order: 0 },
  'tile--topbar': { x: 0, y: -110, order: 1 },
  'tile--mid': { x: 120, y: 0, order: 2 },
  'tile--botleft': { x: 0, y: 110, order: 3 },
  'tile--square': { x: 0, y: 70, order: 4 }
}
/** When the word starts to build, and the beat between its pieces (seconds). */
const WORD_AT = 0.45
const TILE_BEAT = 0.07
const LETTER_AT = WORD_AT + 0.32
const LETTER_BEAT = 0.035

/**
 * "Fabricator" with the mark as its F, cap-height and on the baseline like any
 * letter. It builds itself: the F's tiles glide into place, then the letters
 * rise in one after another. Only the tiles: at text size the mark's thin corner
 * brackets would blur.
 */
function Wordmark(): JSX.Element {
  const gid = 'splash-f-' + useId().replace(/:/g, '')
  return (
    <span className="splash-word splash-word--mark">
      <span className="sr-only">Fabricator</span>
      <span aria-hidden="true">
        <svg className="splash-word-f" viewBox={F_VIEWBOX} xmlns="http://www.w3.org/2000/svg">
          <defs>
            <MarkGradient id={gid} />
          </defs>
          {MARK_TILES.map((t) => {
            const from = F_TILE_IN[t.cls] ?? { x: 0, y: 0, order: 0 }
            const style = {
              '--fx': `${from.x}px`,
              '--fy': `${from.y}px`,
              animationDelay: `${WORD_AT + from.order * TILE_BEAT}s`
            } as CSSProperties
            return (
              <rect
                key={t.cls}
                x={t.x}
                y={t.y}
                width={t.w}
                height={t.h}
                rx={MARK_TILE_RX}
                fill={`url(#${gid})`}
                style={style}
              />
            )
          })}
        </svg>
        {Array.from('abricator').map((letter, i) => (
          <span
            key={i}
            className="splash-word-letter"
            style={{ animationDelay: `${LETTER_AT + i * LETTER_BEAT}s` }}
          >
            {letter}
          </span>
        ))}
      </span>
    </span>
  )
}

/** The stage a line belongs to; none for his hello. */
function stageOf(text: string): StartupStage | undefined {
  return (Object.keys(SPLASH_LINES) as StartupStage[]).find((s) => SPLASH_LINES[s].includes(text))
}

/**
 * What Ray says: his hello, then a line for each stage of the startup checks.
 * Every line stays up for LINE_MS at least, and a stage that's over by then is
 * skipped, so he never talks faster than you can read.
 */
function useNarration(stage: StartupStage, greeting: string): string {
  const [beat, setBeat] = useState(0)
  useEffect(() => {
    setBeat(0)
    if (SPLASH_LINES[stage].length < 2) return
    const timer = window.setInterval(() => setBeat((n) => n + 1), ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [stage])
  const lines = SPLASH_LINES[stage]
  const wanted = lines[beat % lines.length]

  const [shown, setShown] = useState(greeting)
  const shownAt = useRef(Date.now())
  useEffect(() => {
    if (wanted === shown) return
    const timer = window.setTimeout(
      () => {
        shownAt.current = Date.now()
        setShown(wanted)
      },
      Math.max(0, shownAt.current + LINE_MS - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [wanted, shown])
  return shown
}

/**
 * Ray swims up, waves, and talks you through startup. His eyes follow the
 * pointer, he blows the odd bubble while he waits, celebrates when everything
 * checks out, and likes being petted.
 */
function SplashRay({ stage }: { stage: StartupStage }): JSX.Element {
  const reduced = useReducedMotion()
  const [firstTime] = useState(firstMeeting)
  const text = useNarration(stage, splashGreeting(firstTime))
  const said = stageOf(text)
  const { particles, burst } = useParticles()
  const rayRef = useRef<HTMLButtonElement>(null)
  const squishRef = useRef<HTMLSpanElement>(null)
  const petTimer = useRef(0)
  const [arriving, setArriving] = useState(!reduced)
  const [wave, setWave] = useState<number | undefined>(undefined)
  const [talking, setTalking] = useState(false)
  const [petted, setPetted] = useState(false)
  useRayGaze(rayRef)

  // Introduced now, so his hellos elsewhere won't introduce him again.
  useEffect(() => {
    if (firstTime) rememberMeeting()
  }, [firstTime])

  useEffect(() => {
    const swim = window.setTimeout(() => setArriving(false), 1000)
    const hello = window.setTimeout(() => setWave(1), 1050)
    return () => {
      window.clearTimeout(swim)
      window.clearTimeout(hello)
      window.clearTimeout(petTimer.current)
    }
  }, [])

  // His mouth moves while a line types out.
  useEffect(() => {
    if (reduced) return
    setTalking(true)
    const timer = window.setTimeout(() => setTalking(false), Array.from(text).length * TYPE_MS)
    return () => window.clearTimeout(timer)
  }, [text, reduced])

  useEffect(() => {
    if (reduced) return
    if (said === 'ready') {
      burst('confetti', 24, { x: RAY_W / 2, y: RAY_H * 0.35 })
      return
    }
    if (said === 'setup' || said === 'error') return
    const timer = window.setInterval(
      () => burst('bubble', 2, { x: RAY_W * RAY_MOUTH.x, y: RAY_H * RAY_MOUTH.y }),
      3200
    )
    return () => window.clearInterval(timer)
  }, [said, reduced, burst])

  function pet(): void {
    setPetted(true)
    window.clearTimeout(petTimer.current)
    petTimer.current = window.setTimeout(() => setPetted(false), 1400)
    const el = squishRef.current
    if (el && typeof el.animate === 'function') {
      el.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.12, 0.86)' },
          { transform: 'scale(0.95, 1.07)' },
          { transform: 'scale(1)' }
        ],
        { duration: 420, easing: 'ease-out' }
      )
    }
    if (!reduced) burst('heart', 3, { x: RAY_W / 2, y: 12 })
  }

  const base: RayMood = said === 'ready' ? 'happy' : said === 'error' ? 'worried' : 'idle'
  const mood: RayMood = petted ? 'love' : talking ? 'talk' : base

  return (
    <div className="splash-scene">
      <div className="splash-bubble">
        <SpeechBubble key={text} line={{ kind: 'chat', text }} typing={!reduced} />
      </div>
      <div
        className={`splash-ray${arriving ? ' is-arriving' : ''}`}
        style={{ width: RAY_W, height: RAY_H }}
      >
        <button
          type="button"
          ref={rayRef}
          className="splash-ray-hit"
          onClick={pet}
          aria-label="Ray, the Fabricator stingray. Select to pet him."
        >
          <span className="splash-ray-bob">
            <span ref={squishRef} className="splash-ray-squish">
              <Ray mood={mood} wave={wave} />
            </span>
          </span>
        </button>
        <Particles particles={particles} />
      </div>
      <span className="sr-only" role="status">
        {text}
      </span>
    </div>
  )
}

/**
 * The startup screen. `mascot`: Ray is on (Settings → Appearance), so the screen
 * is his. `stage`: how far the startup checks have got, for him to narrate.
 */
export default function SplashScreen({
  mascot = true,
  stage = 'tools'
}: {
  mascot?: boolean
  stage?: StartupStage
}): JSX.Element {
  if (mascot) {
    return (
      <div className="splash splash--ray">
        <SplashRay stage={stage} />
        <div className="splash-brand">
          <Wordmark />
          <span className="splash-tiles" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    )
  }
  return (
    <div className="splash">
      <div className="splash-hero">
        <div className="splash-stage">
          <BuildingLogo />
        </div>
        <div className="splash-wordmark">
          <span className="splash-word">Fabricator</span>
          <span className="splash-sub">Setting up your workspace…</span>
        </div>
      </div>
      <div className="splash-progress" aria-hidden="true">
        <span />
      </div>
    </div>
  )
}
