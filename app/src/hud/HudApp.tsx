import { useEffect, useReducer, useRef, useState } from 'react'
import { deckReducer, initialDeck } from './cardDeck'
import { align, createAligner, paginate } from './scriptAligner'
import { useCoachEvents } from './useCoachEvents'
import type { AsrStatusEvent, CoachEvent, TelemetryEvent } from './protocol'
import './hud.css'

const KIND_LABEL: Record<string, string> = {
  question: 'ASK', counterpoint: 'PUSH BACK', alignment: 'ALIGN', bluf: 'BOTTOM LINE',
  context: 'CONTEXT', risk: 'RISK', answer: 'ANSWER', bio: 'WHO',
}

export default function HudApp() {
  const [meetingId, setMeetingId] = useState<number | null>(null)
  const [deck, dispatch] = useReducer(deckReducer, initialDeck)
  const [tele, setTele] = useState<TelemetryEvent | null>(null)
  const [asr, setAsr] = useState<AsrStatusEvent | null>(null)
  const [live, setLive] = useState<{ speaker: string; text: string } | null>(null)
  const [script, setScript] = useState<string>('')
  const [pointer, setPointer] = useState(0)
  const [asking, setAsking] = useState<{ state: 'pending' | 'empty' | 'error'; message?: string } | null>(null)
  const [llmError, setLlmError] = useState<string | null>(null)
  const aligner = useRef(createAligner(''))

  // Main process tells us which meeting to follow + hotkeys.
  useEffect(() => {
    const api = window.eloquent
    if (!api) return
    const offs = [
      api.onHudMeeting((id) => setMeetingId(id)),
      api.onHudScript((s) => { setScript(s); aligner.current = createAligner(s); setPointer(0) }),
      api.onHudCommand((cmd) => dispatch({ type: cmd })),
    ]
    // Pull the current meeting in case the show event arrived before this component mounted.
    void api.getHudState?.().then(({ meetingId: id, script: s }) => {
      if (id != null) setMeetingId(prev => prev ?? id)
      if (s) { setScript(prev => prev || s); if (!aligner.current.words.length) aligner.current = createAligner(s) }
    })
    return () => offs.forEach(off => off())
  }, [])

  useEffect(() => {
    const t = window.setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 1000)
    return () => window.clearInterval(t)
  }, [])

  useCoachEvents(meetingId, (e: CoachEvent) => {
    if (e.type === 'ask') {
      setAsking(e.state === 'done' ? null : { state: e.state, message: e.message })
      if (e.state === 'empty' || e.state === 'error') {
        window.setTimeout(() => setAsking(a => (a?.state === e.state ? null : a)), e.state === 'error' ? 6000 : 3000)
      }
    }
    else if (e.type === 'llm_status') setLlmError(e.ok ? null : e.message)
    else if (e.type === 'card') dispatch({ type: 'card', card: e })
    else if (e.type === 'telemetry') setTele(e)
    else if (e.type === 'asr_status') setAsr(e)
    else if (e.type === 'transcript') {
      setLive(e.kind === 'final' ? null : { speaker: e.speaker, text: e.text })
      dispatch({ type: 'speech', speaker: e.speaker, text: e.text, final: e.kind === 'final' })
      if (e.kind === 'final') dispatch({ type: 'silence', speaker: e.speaker })
      if (e.speaker === 'Me' && aligner.current.words.length) {
        const p = align(aligner.current, e.text)
        if (p !== aligner.current.pointer) { aligner.current.pointer = p; setPointer(p) }
      }
    }
  })

  const card = deck.active
  const balance = tele?.talk_share_recent_pct ?? 0
  const alert = tele?.alerts[0]

  // Hover-to-interact: window is click-through except while the pointer is over a panel.
  const hover = (on: boolean) => window.eloquent?.setHudInteractive(on)

  return (
    <div className="hud">
      <div className="hud-panel" onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
        <header className="hud-strip">
          <span className={`dot ${deck.speaking === 'Me' ? 'me' : deck.speaking ? 'them' : ''}`} />
          <Meter label="TALK" value={`${Math.round(balance)}%`} warn={balance > 60} />
          <Meter label="WPM" value={`${Math.round(tele?.my_wpm ?? 0)}`} warn={(tele?.my_wpm ?? 0) > 175} />
          <Meter label="FILLER/m" value={(tele?.filler_per_min ?? 0).toFixed(1)} warn={(tele?.filler_per_min ?? 0) > 4} />
          <Meter label="ROOM" value={sentimentGlyph(tele?.room_sentiment ?? 0)} warn={(tele?.room_sentiment ?? 0) < -0.25} />
          <AsrBadge status={asr} />
          {deck.locked && <span className="lock">LOCKED</span>}
        </header>

        {alert && <div className="hud-alert">{alert}</div>}

        {llmError && <div className="hud-llm-error" title={llmError}>Coaching unavailable: {llmError}</div>}

        {asking && (
          <div className={`hud-ask ${asking.state}`}>
            {asking.state === 'pending' ? 'Thinking…'
              : asking.state === 'error' ? (llmError ? 'Couldn’t reach the coach' : asking.message || 'Couldn’t reach the coach')
              : 'Nothing new to add right now'}
          </div>
        )}

        {card ? (
          <article key={card.id} className={`hud-card p${card.priority} ${deck.pinned ? 'pinned' : ''}`}>
            <div className="kind">{KIND_LABEL[card.kind] ?? card.kind.toUpperCase()}</div>
            <div className="headline">{card.headline}</div>
            {card.body && <div className="body">{card.body}</div>}
            <TtlBar createdAt={card.created_at_ms} ttl={card.ttl_s} frozen={deck.pinned || deck.locked} />
            <footer>{deck.queue.length > 0 && `+${deck.queue.length} queued · ←/→`}</footer>
          </article>
        ) : (
          <div className="hud-idle">Listening…</div>
        )}

        {script && <Teleprompter script={script} pointer={pointer} />}
        {live && <div className={`hud-live ${live.speaker === 'Me' ? 'me' : ''}`}>{live.text}</div>}
      </div>
    </div>
  )
}

function Meter({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return <span className={`meter ${warn ? 'warn' : ''}`}><b>{value}</b>{label}</span>
}

/** Silent when healthy; a small amber tag when the governor had to trade latency for stability. */
function AsrBadge({ status }: { status: AsrStatusEvent | null }) {
  const me = status?.channels.Me
  if (!status || !me || (!me.degraded && !status.warnings.length)) return null
  const why = [me.last_event, ...status.warnings].filter(Boolean).join('\n')
  return <span className="meter warn asr" title={why}><b>⏷</b>ASR {me.profile.toUpperCase()}{me.device === 'cpu' ? '·CPU' : ''}</span>
}

function sentimentGlyph(v: number) { return v > 0.2 ? '▲' : v < -0.2 ? '▼' : '●' }

function TtlBar({ createdAt, ttl, frozen }: { createdAt: number; ttl: number; frozen: boolean }) {
  const remaining = Math.max(0, ttl * 1000 - (Date.now() - createdAt))
  return (
    <div className="ttl">
      <div style={{
        animationDuration: `${remaining}ms`,
        animationPlayState: frozen ? 'paused' : 'running',
        transform: `scaleX(${remaining / (ttl * 1000)})`,
      }} />
    </div>
  )
}

/** Paginated script; highlights read words and auto-flips page as the pointer advances. */
function Teleprompter({ script, pointer }: { script: string; pointer: number }) {
  const pages = paginate(script)
  let offset = 0
  let pageIdx = pages.length - 1
  for (let i = 0; i < pages.length; i++) {
    const n = (pages[i].toLowerCase().match(/[a-z0-9%$']+/g) ?? []).length
    if (pointer < offset + n) { pageIdx = i; break }
    offset += n
  }
  let wi = offset
  return (
    <div className="prompter">
      <div className="page">
        {pages[pageIdx]?.split(/\s+/).map((w, i) => {
          const counts = /[a-z0-9%$']/i.test(w)
          const cls = counts && wi < pointer ? 'read' : counts && wi === pointer ? 'cursor' : ''
          if (counts) wi++
          return <span key={i} className={cls}>{w} </span>
        })}
      </div>
      <div className="pageno">{pageIdx + 1}/{pages.length}</div>
    </div>
  )
}
