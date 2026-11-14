import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, Mic, Square, Trash2, Check } from 'lucide-react'
import { api, errText } from './leadershipApi'
import { postAudio, recordMic, VOICE_LABEL, type Recording, type Voice, type VoiceProfileInfo } from './voiceRecorder'

const PASSAGE = `Thanks, everyone. Let me start with the bottom line: we are on track for the launch, with two risks I want us to own today.
First, the data migration. It is the critical path, and I'd rather slow down for a week than ship something we can't support.
Second, hiring. We need two senior engineers by March. If that slips, I will come back with options, not surprises.
Here's what I need from this group: a clear owner for each risk and a decision on scope by Friday.
What am I missing? I want to hear the concerns now, while we still have room to act on them.`

const TEST_SECONDS = 6

type Mode = 'idle' | 'enrolling' | 'testing' | 'saving'

export default function VoiceProfilePanel() {
  const [info, setInfo] = useState<VoiceProfileInfo | null>(null)
  const [mode, setMode] = useState<Mode>('idle')
  const [secs, setSecs] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const rec = useRef<Recording | null>(null)
  const timer = useRef<number | null>(null)

  const load = useCallback(() => {
    api<VoiceProfileInfo>('/voice/profile').then(setInfo).catch(e => setError(errText(e)))
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => () => { rec.current?.cancel(); if (timer.current) window.clearTimeout(timer.current) }, [])

  const begin = async (next: Mode) => {
    setError(''); setNote(''); setSecs(0)
    try {
      const limit = (info?.max_seconds ?? 120) - 1
      rec.current = await recordMic((s, peak) => {
        setSecs(s); setLevel(peak)
        if (next === 'enrolling' && s >= limit && rec.current) void finishEnroll()
      })
      setMode(next)
      if (next === 'testing') timer.current = window.setTimeout(() => { void finishTest() }, TEST_SECONDS * 1000)
    } catch (e) {
      setError(`Couldn't open the microphone: ${errText(e)}`)
    }
  }

  const finishEnroll = async () => {
    const pcm = rec.current?.stop()
    rec.current = null
    if (!pcm) return
    setMode('saving')
    try {
      const r = await postAudio<{ message: string }>('/voice/enroll', pcm)
      setNote(r.message)
      load()
    } catch (e) { setError(errText(e)) } finally { setMode('idle') }
  }

  const finishTest = async () => {
    timer.current = null
    const pcm = rec.current?.stop()
    rec.current = null
    if (!pcm) return
    setMode('saving')
    try {
      const r = await postAudio<{ voice: Voice | null; similarity: number | null }>('/voice/test', pcm)
      const score = r.similarity == null ? '' : ` (match ${Math.round(r.similarity * 100)}%)`
      setNote(r.voice === 'me' ? `Recognised as you${score}.`
        : r.voice === 'uncertain' ? `Not sure it was you${score}. Speak for the full ${TEST_SECONDS} seconds, or re-record your profile.`
        : `Didn't match your profile${score}. Re-record it with the microphone you use in meetings.`)
    } catch (e) { setError(errText(e)) } finally { setMode('idle') }
  }

  const cancel = () => {
    rec.current?.cancel(); rec.current = null
    if (timer.current) window.clearTimeout(timer.current)
    setMode('idle')
  }

  const remove = async () => {
    if (!window.confirm('Delete your voice profile? Meetings will no longer tell your voice apart from others on the mic.')) return
    try { await api('/voice/profile', { method: 'DELETE' }); setNote('Voice profile deleted.'); load() } catch (e) { setError(errText(e)) }
  }

  const labels = info?.labels ?? {}
  const counted = (Object.keys(labels) as Voice[]).filter(k => labels[k])
  const min = info?.min_seconds ?? 20
  const max = info?.max_seconds ?? 120
  const recording = mode === 'enrolling' || mode === 'testing'

  return (
    <div className="glass-panel" style={{ padding: '2rem' }}>
      <h2 style={{ fontSize: '1.2rem', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <AudioLines size={20} color="var(--accent-primary)" /> Voice profile
      </h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.55, marginBottom: '1rem' }}>
        Your mic also picks up people in the room and remote voices from your speakers. With a voice profile, each thing the
        mic hears is labelled <b>You</b>, <b>Room</b> (someone else) or <b>Speaker echo</b>, so coaching and your growth
        trends only count what you said. Only a voiceprint (a list of numbers) is kept, encrypted in the local database.
        The recording itself is never saved.
      </p>

      {info?.enrolled ? (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem', fontSize: '0.88rem' }}>
          <span style={{ color: '#34d399', display: 'flex', alignItems: 'center', gap: '0.3rem' }}><Check size={16} /> Enrolled</span>
          <span style={{ color: 'var(--text-tertiary)' }}>
            {info.created_at && new Date(info.created_at + 'Z').toLocaleDateString()} · {Math.round(info.seconds ?? 0)} s of speech
            {info.quality != null && ` · consistency ${Math.round(info.quality * 100)}%`}
          </span>
          {counted.length > 0 && (
            <span style={{ color: 'var(--text-tertiary)' }}>
              Labelled so far: {counted.map(k => `${VOICE_LABEL[k]} ${labels[k]}`).join(' · ')}
            </span>
          )}
        </div>
      ) : (
        <div style={{ color: 'var(--text-tertiary)', fontSize: '0.88rem', marginBottom: '1rem' }}>
          Not set up. Without it, the app still drops speaker echo it can detect.
        </div>
      )}

      {mode === 'enrolling' && (
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
          <div className="eyebrow" style={{ marginBottom: '0.5rem' }}>Read this aloud at your normal meeting volume</div>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: '1rem' }}>{PASSAGE}</div>
        </div>
      )}

      {recording && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', fontSize: '0.88rem' }}>
          <span style={{ color: 'var(--color-risk)' }}>● {Math.floor(secs)} s</span>
          <div style={{ flex: 1, maxWidth: '240px', height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px' }}>
            <div style={{ width: `${Math.min(100, level * 250)}%`, height: '100%', background: level > 0.9 ? 'var(--color-risk)' : '#34d399', borderRadius: '3px' }} />
          </div>
          <span style={{ color: 'var(--text-tertiary)' }}>
            {mode === 'enrolling'
              ? secs < min + 10 ? `Keep reading: about ${Math.ceil(min + 10 - secs)} s to go` : 'Good. Stop when you finish the passage.'
              : `Say anything for ${TEST_SECONDS} seconds…`}
          </span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        {mode === 'idle' && (
          <>
            <button className="btn btn-primary" onClick={() => void begin('enrolling')}>
              <Mic size={16} /> {info?.enrolled ? 'Re-record profile' : 'Record voice profile'}
            </button>
            {info?.enrolled && (
              <>
                <button className="btn btn-outline" onClick={() => void begin('testing')}>Test recognition</button>
                <button className="btn btn-outline" onClick={() => void remove()} style={{ color: 'var(--color-risk)' }}>
                  <Trash2 size={16} /> Delete
                </button>
              </>
            )}
          </>
        )}
        {mode === 'enrolling' && (
          <>
            <button className="btn btn-primary" onClick={() => void finishEnroll()} disabled={secs < min + 5}>
              <Square size={14} /> Stop &amp; save
            </button>
            <button className="btn btn-outline" onClick={cancel}>Cancel</button>
          </>
        )}
        {mode === 'testing' && <button className="btn btn-outline" onClick={cancel}>Cancel</button>}
        {mode === 'saving' && <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Analysing… (the first time downloads a 40 MB voice model)</span>}
      </div>
      {mode === 'enrolling' && secs >= max - 5 && <div style={{ fontSize: '0.82rem', color: 'var(--text-tertiary)', marginTop: '0.5rem' }}>Recording stops at {max} s.</div>}

      {note && <div style={{ marginTop: '0.75rem', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{note}</div>}
      {error && <div style={{ marginTop: '0.75rem', fontSize: '0.88rem', color: 'var(--color-risk)' }}>{error}</div>}
      <small style={{ display: 'block', marginTop: '1rem', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
        Record with the microphone you use in meetings, somewhere quiet. Very short replies ("yes", "okay") can't be
        verified and are labelled <i>You?</i>; they are left out of your growth metrics. A headset still gives the cleanest result.
      </small>
    </div>
  )
}
