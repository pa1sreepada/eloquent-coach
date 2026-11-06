import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  PARAPHRASED, READ, SKIPPED, adlibSeconds, adlibText, createFollower, currentWpm, etaSeconds, hear, leadCursor,
  nextSentence, prevSentence, reentryText, report, seek, setPaused, type Follower, type RunReport,
} from './follower'
import { parseScript, sectionAt, type ParsedScript, type Token } from './script'
import { loadPrompterSettings, sanitizePrompter, savePrompterSettings, type PrompterPayload, type PrompterSettings } from './settings'
import { useDualChannelCapture } from '../hud/useDualChannelCapture'
import { useCoachEvents } from '../hud/useCoachEvents'
import type { CoachEvent, TranscriptEvent } from '../hud/protocol'
import './prompter.css'

const API = 'http://127.0.0.1:8000'
type Mic = 'off' | 'loading' | 'ready' | 'error' | 'meeting'

const CUES: Record<string, string> = {
  pause: '⏸ pause', breathe: '◌ breathe', slow: '🐢 slow', 'slow down': '🐢 slow', smile: '☺ smile',
  'look up': '👁 look up', 'look at camera': '👁 look up', 'next slide': '▶ next slide', slide: '▶ next slide',
  click: '▶ click', emphasis: '❗ emphasis', 'speed up': '⇢ pick up',
}
const SLIDE_CUE = /slide|click/

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s % 60))).padStart(2, '0')}`

export default function PrompterApp() {
  const [payload, setPayload] = useState<PrompterPayload | null>(null)
  const [settings, setSettings] = useState<PrompterSettings>(loadPrompterSettings)
  const [meetingId, setMeetingId] = useState<number | null>(null)
  const [runKey, setRunKey] = useState(0)

  useEffect(() => {
    const api = window.eloquent
    if (!api) return
    const offs = [
      api.onPrompterLoad((p) => { setPayload(p); setMeetingId(p.meetingId ?? null); setRunKey(k => k + 1) }),
      api.onPrompterSettings((s) => setSettings(sanitizePrompter(s))),
      api.onPrompterMeeting((id) => setMeetingId(id)),
    ]
    void api.getPrompterState().then((p) => { if (p) { setPayload(prev => prev ?? p); setMeetingId(p.meetingId ?? null) } })
    const onStorage = (e: StorageEvent) => { if (e.key === 'prompterSettings') setSettings(loadPrompterSettings()) }
    window.addEventListener('storage', onStorage)
    return () => { offs.forEach(off => off()); window.removeEventListener('storage', onStorage) }
  }, [])

  const updateSettings = useCallback((patch: Partial<PrompterSettings>) => {
    setSettings(prev => {
      const next = sanitizePrompter({ ...prev, ...patch })
      savePrompterSettings(next)
      return next
    })
  }, [])

  if (!payload) {
    return <div className="pr" style={{ ['--bg' as string]: settings.opacity }}><div className="pr-empty">Open a script from Teleprompter in Second Chair.</div></div>
  }
  return <Session key={runKey} payload={payload} settings={settings} meetingId={meetingId}
    onSettings={updateSettings} onRestart={() => setRunKey(k => k + 1)} />
}

/** One read-through of one script. Remounted (fresh follower) on restart or a new script. */
function Session({ payload, settings, meetingId, onSettings, onRestart }: {
  payload: PrompterPayload; settings: PrompterSettings; meetingId: number | null
  onSettings: (p: Partial<PrompterSettings>) => void; onRestart: () => void
}) {
  const script: ParsedScript = useMemo(() => parseScript(payload.content), [payload.content])
  // The engine is a plain mutable object (hot path: every partial transcript); `version` re-renders after it changes.
  const [f] = useState<Follower>(() => createFollower(script))
  const [version, bumpVersion] = useReducer((x: number) => x + 1, 0)
  const [ownMic, setOwnMic] = useState<Mic>('loading')
  const [now, setNow] = useState(() => Date.now())
  const [notice, setNotice] = useState<string | null>(null)
  const [bridge, setBridge] = useState<{ drift: number; line: string | null; loading: boolean } | null>(null)
  const [wrap, setWrap] = useState<RunReport | null>(null)
  const saved = useRef(false)
  const lastCursor = useRef(0)
  const mic: Mic = meetingId != null ? 'meeting' : ownMic

  useEffect(() => window.eloquent?.onPrompterNotice((m) => setNotice(m)), [])

  const saveRun = useCallback(async () => {
    if (saved.current || f.startedAt === null || !payload.scriptId) return
    saved.current = true
    const r = report(f, Date.now())
    try {
      await fetch(`${API}/scripts/${payload.scriptId}/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_s: r.duration_s, avg_wpm: r.avg_wpm, coverage_pct: r.coverage_pct,
          adlib_s: r.adlib_s, fillers: r.fillers, finished: r.finished, details: r }),
      })
      window.eloquent?.prompterRunSaved(payload.scriptId)
    } catch { /* backend down: the run just isn't recorded */ }
  }, [f, payload.scriptId])

  // After the follower moves: fire [next slide] cues I just read past, and wrap up at the end.
  const afterChange = useCallback(() => {
    const prev = lastCursor.current
    if (f.cursor > prev && settings.advanceSlides) {
      const crossed = script.tokens.some(t => t.kind === 'cue' && SLIDE_CUE.test(t.text) && t.unitStart > prev && t.unitStart <= f.cursor)
      if (crossed) window.eloquent?.advanceSlide()
    }
    lastCursor.current = f.cursor
    if (f.mode === 'done' && !saved.current) {
      setWrap(report(f, Date.now()))
      void saveRun()
    }
    bumpVersion()
  }, [f, script, settings.advanceSlides, saveRun])

  // ---- speech in
  const onTranscript = useCallback((e: TranscriptEvent) => {
    if (e.speaker !== 'Me') return
    if (hear(f, { id: e.utterance_id, text: e.text, final: e.kind === 'final', t0_ms: e.t0_ms, t1_ms: e.t1_ms }, Date.now())) afterChange()
  }, [f, afterChange])

  // In a live meeting, follow its mic transcript; otherwise open my own mic-only stream.
  useCoachEvents(meetingId, (e: CoachEvent) => { if (e.type === 'transcript') onTranscript(e) })
  const { start, stop } = useDualChannelCapture(false)
  const scriptId = payload.scriptId
  useEffect(() => {
    if (meetingId != null) return
    let cancelled = false
    const url = `ws://127.0.0.1:8000/ws/prompter${scriptId != null ? `?script_id=${scriptId}` : ''}`
    start(0, (s) => { if (s === 'disconnected' && !cancelled) setOwnMic('error') }, {
      url, micOnly: true,
      onMessage: (data) => {
        try {
          const e = JSON.parse(data)
          if (e.type === 'prompter_status') setOwnMic(e.state === 'ready' ? 'ready' : 'loading')
          else if (e.type === 'transcript') onTranscript(e as TranscriptEvent)
        } catch { /* ignore */ }
      },
    }).then(() => { if (cancelled) stop() }).catch((err: unknown) => {
      if (cancelled) return
      setOwnMic('error')
      setNotice(`Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`)
    })
    return () => { cancelled = true; stop() }
  }, [meetingId, scriptId, start, stop, onTranscript])

  // ---- clock: glide, ad-lib timer, pace, ETA, and a bridge-back line after a long ad-lib
  const bridgeFor = useRef<number | null>(null)
  const bridgeOpts = useRef({ on: settings.bridge, after: settings.bridgeAfterS, title: payload.title })
  useEffect(() => { bridgeOpts.current = { on: settings.bridge, after: settings.bridgeAfterS, title: payload.title } })
  useEffect(() => {
    const t = window.setInterval(() => {
      const ts = Date.now()
      setNow(ts)
      const { on, after, title } = bridgeOpts.current
      const drift = f.driftAt
      if (!on || f.mode !== 'offscript' || drift === null || bridgeFor.current === drift || adlibSeconds(f, ts) < after) return
      bridgeFor.current = drift
      setBridge({ drift, line: null, loading: true })
      fetch(`${API}/prompter/bridge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ said: adlibText(f), next: reentryText(f, 30), title }),
      }).then(r => r.json()).then((j: { line: string | null }) => {
        setBridge(b => (b?.drift === drift ? { drift, line: j.line, loading: false } : b))
      }).catch(() => setBridge(b => (b?.drift === drift ? { drift, line: null, loading: false } : b)))
    }, 250)
    return () => window.clearInterval(t)
  }, [f])

  // ---- controls
  const act = useCallback((cmd: 'pause' | 'prev' | 'next' | 'finish' | 'restart') => {
    const t = Date.now()
    if (cmd === 'pause') setPaused(f, f.mode !== 'paused', t)
    else if (cmd === 'prev') prevSentence(f, t)
    else if (cmd === 'next') nextSentence(f, t)
    else if (cmd === 'restart') { void saveRun().then(onRestart); return }
    else if (cmd === 'finish') { void saveRun().finally(() => window.eloquent?.closePrompter()); return }
    afterChange()
  }, [f, saveRun, onRestart, afterChange])
  useEffect(() => window.eloquent?.onPrompterCommand((c) => act(c)), [act])

  const onSeek = useCallback((unit: number) => { seek(f, unit, Date.now()); afterChange() }, [f, afterChange])

  // ---- scroll: keep the line I'm on at the eye line
  const viewport = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const units = script.units.length
  const lead = leadCursor(f, now)
  const scrollTok = units ? script.units[Math.min(units - 1, Math.floor(lead))].tok : 0
  useLayoutEffect(() => {
    const el = text.current?.querySelector<HTMLElement>(`[data-t="${scrollTok}"]`)
    const vp = viewport.current
    if (!el || !vp || !text.current) return
    const y = settings.eyeLine * vp.clientHeight - el.offsetTop
    text.current.style.transform = `translateY(${Math.round(y)}px)`
  }, [scrollTok, settings.fontSize, settings.eyeLine, settings.width, settings.height, version])

  const mode = f.mode
  const adlibS = adlibSeconds(f, now)
  const drift = f.driftAt
  const section = script.sections[sectionAt(script, Math.min(f.cursor, Math.max(0, units - 1)))]
  const progress = units ? f.cursor / units : 0
  const wpm = currentWpm(f, now)
  const target = payload.targetWpm
  const pace = wpm == null ? null : wpm > target + settings.paceBand ? 'fast' : wpm < target - settings.paceBand ? 'slow' : 'ok'
  const eta = etaSeconds(f, now, target)
  const hover = (on: boolean) => window.eloquent?.setPrompterInteractive(on)

  return (
    <div className={`pr mode-${mode}`} style={{ ['--bg' as string]: settings.opacity, fontSize: settings.fontSize }}
      onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
      <header className="pr-bar">
        <Status mode={mode} mic={mic} adlibS={adlibS} />
        <span className="pr-section" title={section?.title}>{section?.title}</span>
        <div className="pr-progress" title={`${Math.round(progress * 100)}%`}>
          <div style={{ width: `${progress * 100}%` }} />
          {script.sections.slice(1).map((s, i) => <i key={i} style={{ left: `${(s.unitStart / Math.max(1, units)) * 100}%` }} />)}
        </div>
        {wpm != null && <span className={`pr-chip pace-${pace}`} title={`Target ${target} wpm`}>{wpm} wpm</span>}
        {f.startedAt !== null && mode !== 'done' && <span className="pr-chip">~{mmss(eta)} left</span>}
        <div className="pr-controls">
          <button title="Previous sentence (⌥⌘↑)" onClick={() => act('prev')}>↑</button>
          <button title={mode === 'paused' ? 'Resume following (⌥⌘P)' : 'Pause following, e.g. for Q&A (⌥⌘P)'} onClick={() => act('pause')}>{mode === 'paused' ? '▶' : '⏸'}</button>
          <button title="Next sentence (⌥⌘↓)" onClick={() => act('next')}>↓</button>
          <button title="Smaller text" onClick={() => onSettings({ fontSize: settings.fontSize - 2 })}>A−</button>
          <button title="Larger text" onClick={() => onSettings({ fontSize: settings.fontSize + 2 })}>A+</button>
          <button title="Mirror for teleprompter glass" className={settings.mirror ? 'on' : ''} onClick={() => onSettings({ mirror: !settings.mirror })}>⇋</button>
          <button title="Start over" onClick={() => act('restart')}>↺</button>
          <button title="Close and save this read-through" onClick={() => act('finish')}>✕</button>
        </div>
      </header>

      <div className="pr-viewport" ref={viewport}>
        <div className="pr-eye" style={{ top: `calc(${settings.eyeLine * 100}% + 0.7em)` }} />
        <div className={settings.mirror ? 'pr-mirror' : undefined} style={{ height: '100%' }}>
          <div className="pr-text" ref={text}>
            <ScriptText script={script} cursor={f.cursor} status={f.status} version={version} mode={mode} onSeek={onSeek} />
          </div>
        </div>
      </div>

      {mode === 'offscript' && (
        <div className="pr-banner">
          <div>Ad-lib {mmss(adlibS)} · pick up with <b>“{reentryText(f, 8)}…”</b></div>
          {bridge?.drift === drift && (bridge.loading
            ? <div className="pr-bridge dim">✦ finding a way back…</div>
            : bridge.line && <div className="pr-bridge">✦ Bridge: “{bridge.line}”</div>)}
        </div>
      )}
      {mode === 'ready' && mic !== 'loading' && mic !== 'error' && <div className="pr-banner soft">Start reading whenever you’re ready. I’ll follow your voice.</div>}
      {notice && <div className="pr-banner warn" onClick={() => setNotice(null)}>{notice}</div>}
      {wrap && <Wrap r={wrap} onAgain={() => act('restart')} onClose={() => act('finish')} />}
    </div>
  )
}

function Status({ mode, mic, adlibS }: { mode: string; mic: Mic; adlibS: number }) {
  if (mic === 'error') return <span className="pr-status err">● Mic off</span>
  if (mic === 'loading') return <span className="pr-status wait">● Warming up the mic…</span>
  const src = mic === 'meeting' ? ' · meeting mic' : ''
  if (mode === 'tracking') return <span className="pr-status ok">● Following{src}</span>
  if (mode === 'offscript') return <span className="pr-status adlib">● Ad-lib {adlibS ? mmss(adlibS) : ''}</span>
  if (mode === 'paused') return <span className="pr-status wait">⏸ Paused</span>
  if (mode === 'done') return <span className="pr-status ok">✓ Done</span>
  return <span className="pr-status wait">● Listening{src}</span>
}

const ScriptText = memo(function ScriptText({ script, cursor, status, mode, onSeek }: {
  script: ParsedScript; cursor: number; status: Uint8Array; version: number; mode: string; onSeek: (u: number) => void
}) {
  const curTok = cursor < script.units.length ? script.units[cursor].tok : -1
  const out: React.ReactNode[] = []
  let para: React.ReactNode[] = []
  const flush = (key: string) => { if (para.length) out.push(<p key={key}>{para}</p>); para = [] }
  script.tokens.forEach((t: Token, i: number) => {
    if (t.kind === 'para') { flush(`p${i}`); return }
    if (t.kind === 'heading') { flush(`p${i}`); out.push(<div key={i} data-t={i} className="pr-heading">{t.text}</div>); return }
    if (t.kind === 'note') { flush(`p${i}`); out.push(<div key={i} data-t={i} className="pr-note">✎ {t.text}</div>); return }
    if (t.kind === 'cue') {
      const now = t.unitStart === cursor && mode === 'tracking'
      para.push(<span key={i} data-t={i} className={`pr-cue ${now ? 'now' : ''}`}>{CUES[t.text] ?? t.text}</span>, ' ')
      return
    }
    let cls = ''
    if (t.unitEnd > t.unitStart) {
      if (i === curTok) cls = 'cur'
      else if (t.unitEnd <= cursor) {
        const st = status[t.unitStart]
        cls = st === SKIPPED ? 'skip' : st === PARAPHRASED ? 'para' : st === READ ? 'read' : 'read'
      }
    } else if (t.unitStart <= cursor && t.unitStart > 0) cls = 'read'
    para.push(<span key={i} data-t={i} className={`${cls}${t.emph ? ' emph' : ''}`}
      onClick={t.unitEnd > t.unitStart ? () => onSeek(t.unitStart) : undefined}>{t.text}</span>, ' ')
  })
  flush('end')
  return <>{out}</>
})

function Wrap({ r, onAgain, onClose }: { r: RunReport; onAgain: () => void; onClose: () => void }) {
  return (
    <div className="pr-wrap">
      <div className="pr-wrap-title">That’s a wrap · {mmss(r.duration_s)}</div>
      <div className="pr-wrap-grid">
        <Stat v={`${r.coverage_pct}%`} l="of the script" />
        <Stat v={r.avg_wpm != null ? `${r.avg_wpm}` : '—'} l="words / min" />
        <Stat v={`${r.adlib_count}`} l={`ad-libs · ${mmss(r.adlib_s)}`} />
        <Stat v={`${r.paraphrased}`} l="said in your words" />
        <Stat v={`${r.fillers}`} l="fillers" />
      </div>
      {r.skipped.length > 0 && <div className="pr-wrap-skip">Skipped: {r.skipped.slice(0, 2).map(s => `“${s.slice(0, 60)}”`).join(' · ')}{r.skipped.length > 2 ? ` +${r.skipped.length - 2}` : ''}</div>}
      <div className="pr-wrap-actions">
        <button onClick={onAgain}>↺ Run it again</button>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

function Stat({ v, l }: { v: string; l: string }) {
  return <div><b>{v}</b><span>{l}</span></div>
}
