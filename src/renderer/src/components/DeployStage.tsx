import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  MARK_BRACKET_RX,
  MARK_BRACKETS,
  MARK_TILE_RX,
  MARK_TILES,
  MARK_VIEWBOX,
  MarkGradient
} from './FabricatorMark'
import { Codicon } from './icons'
import { deployRuns, readDeployProgress, type DeployTopic } from '../deployProgress'
import { useMascot } from './mascot/context'
import { isRaySentAway, useRayOnScreen } from './mascot/stage'
import { RayPerch } from './mascot/RayPerch'
import type { RayMood } from './mascot/Ray'
import {
  DEPLOY_LINES,
  FactDeck,
  deployGreeting,
  deployLiveLine,
  type MascotLine
} from './mascot/lines'

/**
 * The deploy screen, shown in the preview while a deploy runs. It's Ray's: he
 * swims up, talks you through the deploy in his own words, shares a fact or two
 * on a long build, and celebrates when the app is live. Beneath him are the
 * steps the deploy has been through, read from `rayfin up`'s output (see
 * deployProgress.ts), with the CLI's own words for the step in progress. The
 * raw output is one click away under View logs.
 *
 * With Ray turned off (Settings → Appearance) or sent away, the Fabricator mark
 * builds itself in his place. Flat throughout: solid fills, no glow or shadow.
 */

const RAY_SIZE = 168
/** Each line stays up at least this long, so none flashes by unread. */
const LINE_MS = 1700
/** When a step takes a while, Ray moves on to its next line this often. */
const ROTATE_MS = 4200
/** On a step this long, he starts sharing facts, one this often. */
const FACTS_AFTER_MS = 12_000
const FACT_MS = 9000
/** He hops when a step finishes, but not for every one of a quick run of them. */
const HOP_GAP_MS = 900

/** Steps where he puts his reading glasses on. */
const READING: ReadonlySet<DeployTopic> = new Set(['data', 'storage', 'connectors'])
/** Where he sticks to the point instead of sharing facts. */
const NO_FACTS: ReadonlySet<DeployTopic> = new Set(['signin', 'retry', 'live'])

/** Per-brick fly-in offset + stagger for the self-building mark (Ray turned off). */
const BUILD: Record<string, { tx: number; ty: number; d: number }> = {
  'tile--topbar': { tx: 0, ty: -22, d: 0 },
  'tile--stem': { tx: -22, ty: 0, d: 0.08 },
  'tile--mid': { tx: 22, ty: 0, d: 0.16 },
  'tile--botleft': { tx: 0, ty: 22, d: 0.24 },
  'tile--square': { tx: 0, ty: 12, d: 0.32 },
  'bracket--tl': { tx: -12, ty: -12, d: 0.42 },
  'bracket--br': { tx: 12, ty: 12, d: 0.48 }
}

const brickStyle = (cls: string): CSSProperties => {
  const b = BUILD[cls] ?? { tx: 0, ty: 0, d: 0 }
  return { ['--tx']: `${b.tx}px`, ['--ty']: `${b.ty}px`, ['--d']: `${b.d}s` } as CSSProperties
}

function BuildingMark(): JSX.Element {
  const gid = 'dstage-mark-' + useId().replace(/:/g, '')
  const fill = `url(#${gid})`
  return (
    <svg
      className="dstage-logo"
      viewBox={MARK_VIEWBOX}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <MarkGradient id={gid} />
      </defs>
      <g className="dstage-logo-inner">
        {MARK_TILES.map((t) => (
          <rect
            key={t.cls}
            className={`dstage-brick ${t.cls}`}
            style={brickStyle(t.cls)}
            x={t.x}
            y={t.y}
            width={t.w}
            height={t.h}
            rx={MARK_TILE_RX}
            fill={fill}
          />
        ))}
        {MARK_BRACKETS.map((b) => (
          <g
            key={b.cls}
            className={`dstage-brick bracket ${b.cls}`}
            style={brickStyle(b.cls)}
            fill={fill}
          >
            {b.rects.map((r, i) => (
              <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={MARK_BRACKET_RX} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  )
}

/**
 * What Ray says: his hello, then a line for each step, moving on to the step's
 * next line when it takes a while, and to facts when it takes much longer. Every
 * line stays up for LINE_MS at least, so he never talks faster than you can
 * read; only the good news at the end doesn't wait.
 */
function useDeployNarration(topic: DeployTopic, greeting: string, liveLine: string): MascotLine {
  const deck = useMemo(() => new FactDeck(), [])
  const [said, setSaid] = useState<{ topic: DeployTopic; beat: number; fact: MascotLine | null }>(
    { topic, beat: 0, fact: null }
  )
  useEffect(() => {
    setSaid({ topic, beat: 0, fact: null })
    const next = (): void => setSaid((s) => (s.topic === topic ? { ...s, beat: s.beat + 1 } : s))
    const rotate = DEPLOY_LINES[topic].length > 1 ? window.setInterval(next, ROTATE_MS) : 0
    let facts = 0
    const share = (): void => {
      const fact = deck.next()
      setSaid((s) => (s.topic === topic ? { ...s, fact } : s))
    }
    const start = NO_FACTS.has(topic)
      ? 0
      : window.setTimeout(() => {
          share()
          facts = window.setInterval(share, FACT_MS)
        }, FACTS_AFTER_MS)
    return () => {
      window.clearInterval(rotate)
      window.clearTimeout(start)
      window.clearInterval(facts)
    }
  }, [topic, deck])

  const { beat, fact } = said.topic === topic ? said : { beat: 0, fact: null }
  const wanted = useMemo<MascotLine>(() => {
    if (topic === 'live') return { kind: 'chat', text: liveLine }
    const lines = DEPLOY_LINES[topic]
    return fact ?? { kind: 'chat', text: lines[beat % lines.length] }
  }, [topic, liveLine, fact, beat])

  const [shown, setShown] = useState<MascotLine>({ kind: 'chat', text: greeting })
  const shownAt = useRef(Date.now())
  useEffect(() => {
    if (wanted.text === shown.text) return
    const wait = topic === 'live' ? 0 : Math.max(0, shownAt.current + LINE_MS - Date.now())
    const timer = window.setTimeout(() => {
      shownAt.current = Date.now()
      setShown(wanted)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [wanted, shown, topic])
  return shown
}

/** Ray on the deploy screen, swimming hard against the current. */
function DeployRay({
  topic,
  hop,
  name,
  firstDeploy
}: {
  topic: DeployTopic
  hop: number
  name: string
  firstDeploy: boolean
}): JSX.Element {
  const line = useDeployNarration(topic, deployGreeting(name, firstDeploy), deployLiveLine(name))
  const live = topic === 'live'
  const reading = READING.has(topic)
  const mood: RayMood = live ? 'happy' : topic === 'signin' ? 'surprised' : reading ? 'read' : 'idle'
  return (
    <div className={`dstage-ray${live ? ' is-live' : ''}`}>
      <span className="dstage-current" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <i key={i} />
        ))}
      </span>
      <RayPerch
        className="dstage-perch"
        line={line}
        mood={mood}
        glasses={reading}
        size={RAY_SIZE}
        bubbling={!live && topic !== 'signin'}
        celebrate={live ? 1 : 0}
        confetti={40}
        hop={hop}
      />
    </div>
  )
}

export default function DeployStage({
  log,
  name,
  firstDeploy = false
}: {
  log: string[]
  name?: string
  /** The app has never been deployed, so this is its first trip to Fabric. */
  firstDeploy?: boolean
}): JSX.Element {
  const appName = name?.trim() ?? ''
  const mascot = useMascot()
  const [sentAway] = useState(isRaySentAway)
  const withRay = mascot && !sentAway
  useRayOnScreen(withRay)

  const [now, setNow] = useState(() => Date.now())
  const [startedAt] = useState(now)
  const [showLog, setShowLog] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, showLog])

  // An older CLI's progress is partly read off the clock, from when the CLI
  // started in the latest run: a sign-in retry starts a new one, and installing
  // packages doesn't count.
  const runs = useMemo(() => deployRuns(log), [log])
  const [cli, setCli] = useState<{ runs: number; at: number | null }>({ runs, at: startedAt })
  const cliSec = cli.runs === runs && cli.at !== null ? Math.max(0, now - cli.at) / 1000 : 0
  const progress = readDeployProgress(log, cliSec)
  const installing = progress.current.id === 'packages'
  if (cli.runs !== runs || (installing ? cli.at !== null : cli.at === null)) {
    setCli({ runs, at: installing ? null : Date.now() })
  }

  // When the current step began, and how many steps have gone by.
  const [step, setStep] = useState({ id: progress.current.id, at: startedAt, count: 0 })
  if (step.id !== progress.current.id) {
    setStep({ id: progress.current.id, at: Date.now(), count: step.count + 1 })
  }

  // The bar: where the step began, easing toward where the next one would, and
  // never back. The CLI's own percentage wins when it gives one.
  const span = progress.next - progress.at
  const inStepSec = Math.max(0, now - step.at) / 1000
  const tau = progress.topic === 'build' || progress.topic === 'upload' ? 16 : 6
  const target = progress.live
    ? 1
    : progress.percent !== null
      ? progress.at + (span * progress.percent) / 100
      : progress.at + span * 0.85 * (1 - Math.exp(-inStepSec / tau))
  const high = useRef({ runs, value: 0 })
  const bar = Math.max(high.current.runs === runs ? high.current.value : 0, target)
  useEffect(() => {
    high.current = { runs, value: bar }
  }, [runs, bar])

  const [hop, setHop] = useState(0)
  const lastHop = useRef(0)
  useEffect(() => {
    if (step.count === 0 || progress.live) return
    const at = Date.now()
    if (at - lastHop.current < HOP_GAP_MS) return
    lastHop.current = at
    setHop((n) => n + 1)
  }, [step.count, progress.live])

  const elapsed = Math.floor((now - startedAt) / 1000)
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  const lastLine = useMemo(() => {
    // Scan the joined log by line, not by entry: a coalesced proc:log event can
    // carry several lines, so the last *entry* may be a multi-line block.
    const lines = log.join('').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (t) return t
    }
    return ''
  }, [log])

  return (
    <div className="dstage">
      <div className="dstage-scene">
        <span className="dstage-timer" aria-hidden="true">
          {elapsedLabel}
        </span>

        {withRay ? (
          <DeployRay
            topic={progress.topic}
            hop={hop}
            name={appName || 'Your app'}
            firstDeploy={firstDeploy}
          />
        ) : (
          <div className="dstage-mark">
            <BuildingMark />
          </div>
        )}

        <div className="dstage-hud">
          <span className="dstage-eyebrow">{progress.live ? 'Shipped' : 'Fabricating'}</span>
          <h3 className="dstage-title">
            {progress.live ? (
              <>
                <b>{appName || 'Your app'}</b> is live
              </>
            ) : (
              <>
                Deploying <b>{appName || 'your app'}</b>
              </>
            )}
          </h3>
          <div
            className="dstage-bar"
            role="progressbar"
            aria-label="Deploy progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(bar * 100)}
          >
            <span style={{ width: `${(bar * 100).toFixed(1)}%` }} />
          </div>
          <ol className="dstage-steps" aria-label="Deploy steps">
            {progress.steps.map((s) => (
              <li key={s.id} className="dstage-step" data-state={s.state}>
                <span className="dstage-step-mark" aria-hidden="true">
                  {s.state === 'done' && <Codicon name="check" />}
                </span>
                <span className="dstage-step-text">
                  <span className="dstage-step-label">{s.label}</span>
                  {s.state === 'active' && progress.detail && (
                    <span className="dstage-step-detail">{progress.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
          <span className="sr-only" role="status">
            {progress.current.label}
          </span>
        </div>
      </div>

      <div className="dstage-foot">
        <div className="dstage-ticker">
          <span className="dstage-ticker-caret">›</span>
          <span className="dstage-ticker-text">{lastLine || 'Starting the deploy…'}</span>
          <span className="dstage-ticker-cursor" aria-hidden="true" />
        </div>
        <button className="dstage-logbtn" type="button" onClick={() => setShowLog((s) => !s)}>
          {showLog ? 'Hide logs' : 'View logs'}
        </button>
      </div>

      {showLog && (
        <pre className="deploy-log deploy-log--static dstage-fulllog" ref={logRef}>
          {log.join('') || 'Starting deploy…'}
        </pre>
      )}
    </div>
  )
}