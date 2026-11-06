import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ScrollText, Plus, Trash2, Upload, WandSparkles, Play, Square, Timer, MicVocal, FlipHorizontal, RefreshCw,
} from 'lucide-react'
import { parseScript, spokenWordCount } from '../prompter/script'
import { loadPrompterSettings, savePrompterSettings, sanitizePrompter, type PrompterSettings } from '../prompter/settings'

const API = 'http://127.0.0.1:8000'

interface RunSummary {
  id: number; started_at: string | null; duration_s: number; avg_wpm: number | null; coverage_pct: number
  adlib_s: number; fillers: number; finished: boolean; details: { skipped?: string[]; paraphrased?: number; adlib_count?: number }
}
interface ScriptSummary { id: number; title: string; target_wpm: number; words: number; updated_at: string | null; runs_count: number; last_run: RunSummary | null }
interface ScriptFull extends ScriptSummary { content: string; runs: RunSummary[] }

const SAMPLE = `# Opening
Good morning, everyone. Thanks for making the time.
[look up]
Today I want to walk you through *three* things: where we are, what we learned, and what we need from you.

# Where we are
We closed the quarter at 112% of plan, and churn dropped to 2.1%.
> Pause here and let the number land.
[pause]
That's the best quarter we've had since 2021.

[next slide]
# The ask
So here's what I need: two more engineers by March, and a decision on pricing by Friday.
[slow]
If we get both, we hit the target. If we don't, we slip a full quarter.

# Close
Thank you. I'd love your questions.`

const CUE_BUTTONS = [
  { label: 'Pause', text: '[pause]' }, { label: 'Look up', text: '[look up]' }, { label: 'Slow', text: '[slow]' },
  { label: 'Smile', text: '[smile]' }, { label: 'Next slide', text: '[next slide]' },
  { label: 'Section', text: '\n# ' }, { label: 'Note', text: '\n> ' }, { label: '*Emphasis*', text: '*' },
]

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const ago = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  const m = Math.round((Date.now() - d.getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.round(m / 60)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function TeleprompterView() {
  const [scripts, setScripts] = useState<ScriptSummary[]>([])
  const [current, setCurrent] = useState<ScriptFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [polish, setPolish] = useState<{ loading: boolean; content: string | null; error: string | null } | null>(null)
  const [settings, setSettings] = useState<PrompterSettings>(loadPrompterSettings)
  const [running, setRunning] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const pending = useRef<Partial<ScriptFull> | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const currentId = useRef<number | null>(null)
  useEffect(() => { currentId.current = current?.id ?? null }, [current?.id])

  const loadList = useCallback(() =>
    fetch(`${API}/scripts`).then(r => r.json()).then((list: ScriptSummary[]) => { setScripts(list); setError(null); return list })
      .catch(() => { setError('Could not reach the backend.'); return [] as ScriptSummary[] }), [])

  const open = useCallback((id: number) =>
    fetch(`${API}/scripts/${id}`).then(r => (r.ok ? r.json() : null)).then((s: ScriptFull | null) => { if (s) setCurrent(s) }).catch(() => {}), [])

  useEffect(() => {
    void loadList().then(list => { if (list.length) void open(list[0].id) })
  }, [loadList, open])

  // Prompter window lifecycle and saved read-throughs.
  useEffect(() => {
    const api = window.eloquent
    if (!api) return
    void api.isPrompterOpen?.().then(setRunning)
    const offs = [
      api.onPrompterClosed(() => setRunning(false)),
      api.onPrompterRunSaved((id) => { void loadList(); if (currentId.current === id) void open(id) }),
    ]
    return () => offs.forEach(off => off())
  }, [loadList, open])

  // ---- persistence
  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const p = pending.current
    if (!p || !current) return
    pending.current = null
    setSaving('saving')
    try {
      await fetch(`${API}/scripts/${current.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: p.title, content: p.content, target_wpm: p.target_wpm }),
      })
      setSaving('saved')
      void loadList()
    } catch { setSaving('idle'); setError('Couldn’t save. Is the backend running?') }
  }, [current, loadList])

  const edit = (patch: Partial<ScriptFull>) => {
    if (!current) return
    setCurrent({ ...current, ...patch })
    pending.current = { title: current.title, content: current.content, target_wpm: current.target_wpm, ...pending.current, ...patch }
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { void flush() }, 700)
  }

  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  const create = async (title: string, content: string) => {
    await flush()
    const r = await fetch(`${API}/scripts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) })
      .catch(() => null)
    if (!r?.ok) { setError('Couldn’t create the script.'); return }
    const s: ScriptFull = await r.json()
    setCurrent(s)
    setPolish(null)
    void loadList()
    setTimeout(() => editor.current?.focus(), 50)
  }

  const remove = async () => {
    if (!current) return
    window.clearTimeout(saveTimer.current)
    pending.current = null
    await fetch(`${API}/scripts/${current.id}`, { method: 'DELETE' }).catch(() => {})
    setConfirmDelete(false)
    setCurrent(null)
    const list = await loadList()
    if (list.length) void open(list[0].id)
  }

  const importFile = async (file: File) => {
    const text = await file.text()
    await create(file.name.replace(/\.(txt|md|markdown)$/i, ''), text.slice(0, 200_000))
  }

  const select = async (id: number) => { await flush(); setPolish(null); void open(id) }

  // ---- cues
  const insert = (snippet: string) => {
    const ta = editor.current
    if (!ta || !current) return
    const { selectionStart: a, selectionEnd: b, value } = ta
    let next: string, caret: number
    if (snippet === '*') {
      next = `${value.slice(0, a)}*${value.slice(a, b)}*${value.slice(b)}`
      caret = b + 2
    } else {
      const pad = snippet.startsWith('[') && a > 0 && !/\s$/.test(value.slice(0, a)) ? ' ' : ''
      next = value.slice(0, a) + pad + snippet + (snippet.startsWith('[') ? ' ' : '') + value.slice(b)
      caret = a + pad.length + snippet.length + (snippet.startsWith('[') ? 1 : 0)
    }
    edit({ content: next })
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(caret, caret) })
  }

  // ---- LLM polish
  const runPolish = async () => {
    if (!current?.content.trim()) return
    setPolish({ loading: true, content: null, error: null })
    try {
      const r = await fetch(`${API}/prompter/polish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: current.content }) })
      const j: { content: string | null; error: string | null } = await r.json()
      setPolish({ loading: false, content: j.content, error: j.error })
    } catch { setPolish({ loading: false, content: null, error: 'Could not reach the backend.' }) }
  }

  // ---- settings and the prompter window
  const updateSettings = (patch: Partial<PrompterSettings>) => {
    const next = sanitizePrompter({ ...settings, ...patch })
    setSettings(next)
    savePrompterSettings(next)
    if (running) window.eloquent?.updatePrompterSettings(next)
  }

  const startPrompter = async () => {
    if (!current?.content.trim()) return
    await flush()
    window.eloquent?.openPrompter({ scriptId: current.id, title: current.title, content: current.content, targetWpm: current.target_wpm, settings })
    setRunning(true)
  }
  const stopPrompter = () => { window.eloquent?.stopPrompter(); setRunning(false) }

  const stats = useMemo(() => {
    if (!current) return null
    const words = spokenWordCount(current.content)
    const parsed = parseScript(current.content)
    return { words, minutes: words / Math.max(60, current.target_wpm), sections: parsed.sections.length, cues: parsed.tokens.filter(t => t.kind === 'cue').length }
  }, [current])

  const hasBridge = !!window.eloquent

  return (
    <div className="fade-in" style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1.25rem', height: '100%', minHeight: 0 }}>
      {/* Library */}
      <div className="glass-panel" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: '0.75rem' }}>
          <ScrollText size={18} color="var(--accent-primary)" />
          <h2 style={{ fontSize: '1.05rem', flex: 1 }}>Scripts</h2>
          <button className="icon-btn" title="New script" onClick={() => void create('Untitled script', '')}><Plus size={16} /></button>
          <button className="icon-btn" title="Import a .txt or .md file" onClick={() => fileInput.current?.click()}><Upload size={16} /></button>
          <input ref={fileInput} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = '' }} />
        </div>
        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {scripts.map(s => (
            <button key={s.id} className={`tp-item ${current?.id === s.id ? 'on' : ''}`} onClick={() => void select(s.id)}>
              <div className="tp-item-title">{s.title}</div>
              <div className="tp-item-meta">
                {s.words} words · ~{mmss((s.words / s.target_wpm) * 60)}
                {s.last_run && <> · {s.last_run.coverage_pct}% last run</>}
              </div>
            </button>
          ))}
          {!scripts.length && !error && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', padding: '0.5rem' }}>
              No scripts yet.
              <button className="btn btn-outline" style={{ marginTop: '0.75rem', width: '100%' }} onClick={() => void create('Sample: quarterly update', SAMPLE)}>
                Try a sample script
              </button>
            </div>
          )}
          {error && <div style={{ color: 'var(--color-risk)', fontSize: '0.85rem', padding: '0.5rem' }}>{error}</div>}
        </div>
      </div>

      {/* Editor */}
      {current ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
          <div className="glass-panel" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <input className="field" style={{ fontSize: '1.1rem', fontWeight: 600, flex: 1 }} value={current.title} maxLength={200}
                onChange={(e) => edit({ title: e.target.value })} placeholder="Script title" />
              {running
                ? <button className="btn btn-danger" onClick={stopPrompter}><Square size={16} /> Stop</button>
                : <button className="btn btn-primary" onClick={() => void startPrompter()} disabled={!current.content.trim() || !hasBridge}
                    title={hasBridge ? 'Float the script under your camera and follow your voice' : 'Available in the desktop app'}>
                    <Play size={16} /> Start teleprompter
                  </button>}
              <button className="icon-btn" title="Delete script" onClick={() => setConfirmDelete(true)}><Trash2 size={16} /></button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className="eyebrow" style={{ marginRight: 4 }}>Insert</span>
              {CUE_BUTTONS.map(c => (
                <button key={c.label} className="tp-chip" onClick={() => insert(c.text)} title={`Insert ${c.text.trim()}`}>{c.label}</button>
              ))}
              <span style={{ flex: 1 }} />
              <button className="btn btn-outline" style={{ padding: '0.35rem 0.8rem', fontSize: '0.85rem' }} onClick={() => void runPolish()}
                disabled={polish?.loading || !current.content.trim()} title="Rewrite with the local LLM so it sounds spoken, not written">
                <WandSparkles size={15} className={polish?.loading ? 'pulse-animation' : undefined} /> {polish?.loading ? 'Polishing…' : 'Make it speakable'}
              </button>
            </div>

            <textarea ref={editor} className="field tp-editor" value={current.content} spellCheck
              onChange={(e) => edit({ content: e.target.value })} onBlur={() => void flush()}
              placeholder={'Paste or write what you want to say.\n\n# Section headings\n> notes to yourself (not read aloud)\n[pause] [look up] [next slide] cues\n*emphasis*'} />

            {stats && (
              <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                <span><b style={{ color: 'var(--text-primary)' }}>{stats.words}</b> words</span>
                <span><Timer size={13} style={{ verticalAlign: -2 }} /> ~{mmss(stats.minutes * 60)} at</span>
                <input type="number" className="field" style={{ width: 80, padding: '0.25rem 0.5rem', marginLeft: -12 }} min={60} max={260} step={5}
                  value={current.target_wpm} onChange={(e) => edit({ target_wpm: Math.min(260, Math.max(60, Number(e.target.value) || 150)) })} />
                <span style={{ marginLeft: -12 }}>wpm</span>
                <span>{stats.sections} section{stats.sections === 1 ? '' : 's'}</span>
                <span>{stats.cues} cue{stats.cues === 1 ? '' : 's'}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: 'var(--text-tertiary)' }}>{saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : ''}</span>
              </div>
            )}

            {polish && !polish.loading && (
              <div className="tp-polish">
                {polish.error
                  ? <div style={{ color: 'var(--color-risk)' }}>{polish.error}</div>
                  : <>
                      <div className="eyebrow" style={{ marginBottom: 6 }}>Speakable version</div>
                      <pre>{polish.content}</pre>
                    </>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  {polish.content && <button className="btn btn-primary" onClick={() => { edit({ content: polish.content! }); setPolish(null) }}>Use this version</button>}
                  <button className="btn btn-outline" onClick={() => setPolish(null)}>{polish.content ? 'Keep mine' : 'Close'}</button>
                </div>
              </div>
            )}
          </div>

          <PrompterSettingsPanel settings={settings} onChange={updateSettings} />
          <RunHistory runs={current.runs} target={current.target_wpm} onRefresh={() => void open(current.id)} />
        </div>
      ) : (
        <div className="glass-panel flex-center" style={{ flexDirection: 'column', gap: '0.75rem', color: 'var(--text-secondary)' }}>
          <MicVocal size={36} color="var(--accent-primary)" />
          <div style={{ fontSize: '1.05rem', color: 'var(--text-primary)' }}>A teleprompter that listens</div>
          <div style={{ maxWidth: 440, textAlign: 'center', fontSize: '0.9rem' }}>
            It floats under your camera, hidden from screen share, and scrolls as you speak. Go off script and it waits for you, then picks up where you rejoin.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button className="btn btn-primary" onClick={() => void create('Untitled script', '')}><Plus size={16} /> New script</button>
            <button className="btn btn-outline" onClick={() => void create('Sample: quarterly update', SAMPLE)}>Try a sample</button>
          </div>
        </div>
      )}

      {confirmDelete && current && (
        <div className="sheet-backdrop" onClick={() => setConfirmDelete(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{current.title}”?</h3>
            <p style={{ color: 'var(--text-secondary)' }}>The script and its {current.runs.length} rehearsal{current.runs.length === 1 ? '' : 's'} will be removed.</p>
            <div className="actions">
              <button className="btn btn-outline" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => void remove()}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PrompterSettingsPanel({ settings: s, onChange }: { settings: PrompterSettings; onChange: (p: Partial<PrompterSettings>) => void }) {
  const slider = (label: string, key: 'fontSize' | 'width' | 'height' | 'eyeLine' | 'opacity', min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="tp-setting">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={s[key]} onChange={(e) => onChange({ [key]: Number(e.target.value) })} />
      <span className="tp-val">{fmt(s[key])}</span>
    </label>
  )
  const toggle = (label: string, key: 'mirror' | 'bridge' | 'advanceSlides', hint: string) => (
    <label className="tp-setting" title={hint}>
      <span>{label}</span>
      <input type="checkbox" checked={s[key]} onChange={(e) => onChange({ [key]: e.target.checked })} />
      <span className="tp-hint">{hint}</span>
    </label>
  )
  return (
    <div className="glass-panel" style={{ padding: '1.25rem' }}>
      <div className="eyebrow" style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: 6 }}><FlipHorizontal size={14} /> Prompter display</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.5rem 1.5rem' }}>
        {slider('Text size', 'fontSize', 16, 72, 1, v => `${v}px`)}
        {slider('Eye line', 'eyeLine', 0.12, 0.6, 0.02, v => `${Math.round(v * 100)}%`)}
        {slider('Width', 'width', 420, 1400, 10, v => `${v}px`)}
        {slider('Height', 'height', 160, 800, 10, v => `${v}px`)}
        {slider('Background', 'opacity', 0.4, 1, 0.02, v => `${Math.round(v * 100)}%`)}
        <label className="tp-setting" title="How far from your target pace before the WPM chip turns amber or blue">
          <span>Pace band</span>
          <input type="range" min={5} max={60} step={5} value={s.paceBand} onChange={(e) => onChange({ paceBand: Number(e.target.value) })} />
          <span className="tp-val">±{s.paceBand}</span>
        </label>
        {toggle('Mirror', 'mirror', 'Flip for beam-splitter glass')}
        {toggle('Bridge back', 'bridge', `After ${s.bridgeAfterS}s off script, suggest a line to rejoin`)}
        {toggle('Advance slides', 'advanceSlides', 'Press → at [next slide] cues (macOS Accessibility)')}
      </div>
    </div>
  )
}

function RunHistory({ runs, target, onRefresh }: { runs: RunSummary[]; target: number; onRefresh: () => void }) {
  if (!runs.length) {
    return (
      <div className="glass-panel" style={{ padding: '1.25rem', color: 'var(--text-tertiary)', fontSize: '0.88rem' }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Rehearsals</div>
        Each read-through is scored here: how much you covered, your pace, ad-libs and what you skipped.
      </div>
    )
  }
  const chrono = [...runs].reverse()
  const max = Math.max(...chrono.map(r => r.duration_s), 1)
  return (
    <div className="glass-panel" style={{ padding: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div className="eyebrow" style={{ flex: 1 }}>Rehearsals · {runs.length}</div>
        <button className="icon-btn" title="Refresh" onClick={onRefresh}><RefreshCw size={14} /></button>
      </div>
      <div className="tp-spark" title="Coverage per run (bar height) and duration (bar width)">
        {chrono.slice(-20).map(r => (
          <div key={r.id} style={{ height: `${Math.max(6, r.coverage_pct)}%`, flexGrow: Math.max(0.3, r.duration_s / max) }}
            className={r.coverage_pct >= 90 ? 'good' : r.coverage_pct >= 60 ? 'ok' : 'low'} />
        ))}
      </div>
      <table className="tp-runs">
        <thead><tr><th>When</th><th>Time</th><th>Covered</th><th>Pace</th><th>Ad-libs</th><th>Fillers</th><th>Skipped</th></tr></thead>
        <tbody>
          {runs.slice(0, 10).map(r => {
            const pace = r.avg_wpm == null ? '' : Math.abs(r.avg_wpm - target) <= 20 ? 'ok' : r.avg_wpm > target ? 'fast' : 'slow'
            const skipped = r.details?.skipped ?? []
            return (
              <tr key={r.id}>
                <td>{ago(r.started_at)}{!r.finished && <span className="tp-tag">partial</span>}</td>
                <td>{mmss(r.duration_s)}</td>
                <td>{r.coverage_pct}%</td>
                <td className={`pace-${pace}`}>{r.avg_wpm ?? '—'}</td>
                <td>{r.details?.adlib_count ?? 0}{r.adlib_s ? ` · ${mmss(r.adlib_s)}` : ''}</td>
                <td>{r.fillers}</td>
                <td title={skipped.join('\n')} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {skipped.length ? `“${skipped[0]}”${skipped.length > 1 ? ` +${skipped.length - 1}` : ''}` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
