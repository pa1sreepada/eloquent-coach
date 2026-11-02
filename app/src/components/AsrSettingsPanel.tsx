import { useEffect, useState } from 'react'
import { Cpu, RefreshCw, AlertTriangle } from 'lucide-react'
import type { AsrDevice, AsrProfile } from '../hud/protocol'

const API = 'http://127.0.0.1:8000'

export interface AsrSettings {
  asr_profile: 'auto' | AsrProfile
  asr_backend: 'auto' | AsrDevice
  asr_adaptive: 'true' | 'false'
}

interface ChannelPlan { device: AsrDevice; profile: AsrProfile; duty: number | null; est_latency_ms: number }
interface AsrPlan {
  channels: Record<'Me' | 'Participant', ChannelPlan>
  source: 'calibrated' | 'heuristic' | 'manual'
  reasons: string[]
  warnings: string[]
}
interface AsrOption { device: AsrDevice; profile: AsrProfile; est_latency_ms: number; within_budget: boolean | null }
interface AsrStatus {
  hardware: { chip: string; memory_gb: number; gpu: { kind: string } | null }
  power: { on_battery: boolean; constrained: boolean }
  calibration: { created_at: number; seconds_taken: number } | null
  calibrating: boolean
  recommended: AsrPlan
  options: AsrOption[]
}

const PROFILES: AsrProfile[] = ['ultra', 'low', 'balanced', 'accurate']
const label = (p: string) => p[0].toUpperCase() + p.slice(1)
const ms = (v: number) => (v < 0 ? 'falls behind' : `~${Math.round(v / 10) * 10} ms`)
const fmtPlan = (c: ChannelPlan) => `${label(c.profile)} on ${c.device.toUpperCase()} (${ms(c.est_latency_ms)})`

/**
 * Hardware-aware transcription settings. "Auto" is the default and the recommendation; manual
 * choices are allowed but validated against this machine's calibration before saving.
 */
export default function AsrSettingsPanel({ value, onChange }: {
  value: AsrSettings
  onChange: (patch: Partial<AsrSettings>) => void
}) {
  const [status, setStatus] = useState<AsrStatus | null>(null)
  const [preview, setPreview] = useState<AsrPlan | null>(null)
  const [error, setError] = useState('')

  const load = () => fetch(`${API}/asr/status`).then(r => r.json()).then(setStatus).catch(() => setError('Backend not reachable'))
  useEffect(() => { load() }, [])

  // Poll while calibration runs (~25 s).
  useEffect(() => {
    if (!status?.calibrating) return
    const t = window.setInterval(load, 3000)
    return () => window.clearInterval(t)
  }, [status?.calibrating])

  // Validate manual choices live.
  const manual = value.asr_profile !== 'auto' || value.asr_backend !== 'auto'
  useEffect(() => {
    if (!manual) { setPreview(null); return }
    const ctl = new AbortController()
    fetch(`${API}/asr/validate`, {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asr_profile: value.asr_profile, asr_backend: value.asr_backend }),
    }).then(r => r.json()).then(setPreview).catch(() => {})
    return () => ctl.abort()
  }, [value.asr_profile, value.asr_backend, manual, status?.calibration?.created_at])

  const recalibrate = () =>
    fetch(`${API}/asr/calibrate`, { method: 'POST' })
      .then(r => (r.ok ? load() : r.json().then(j => setError(j.detail))))

  const option = (p: AsrProfile) => {
    const dev: AsrDevice = value.asr_backend === 'cpu' || !status?.hardware.gpu ? 'cpu' : 'gpu'
    const o = status?.options.find(x => x.device === dev && x.profile === p)
    if (!o || o.within_budget === null) return label(p)
    return `${label(p)} · ${ms(o.est_latency_ms)}${o.within_budget ? '' : ' · may lag'}`
  }

  const rec = status?.recommended
  const shown = preview ?? rec
  const field = { width: '100%', padding: '0.6rem', borderRadius: 8 } as const

  return (
    <div className="glass-panel" style={{ padding: '2rem' }}>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 0 }}><Cpu size={20} /> Live Transcription Engine</h3>

      {status && (
        <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
          {status.hardware.chip} · {status.hardware.gpu ? status.hardware.gpu.kind.toUpperCase() : 'CPU only'} · {Math.round(status.hardware.memory_gb)} GB
          {status.power.on_battery && ' · on battery'}{status.power.constrained && ' · low-power/thermal'}
          {' · '}{status.calibrating ? 'measuring this machine…' : status.calibration
            ? `measured in ${Math.round(status.calibration.seconds_taken)} s` : 'not measured yet'}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Latency profile (your voice)</label>
          <select style={field} value={value.asr_profile}
            onChange={e => onChange({ asr_profile: e.target.value as AsrSettings['asr_profile'] })}>
            <option value="auto">Auto (recommended){rec ? ` — ${label(rec.channels.Me.profile)}` : ''}</option>
            {PROFILES.map(p => <option key={p} value={p}>{option(p)}</option>)}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Compute device</label>
          <select style={field} value={value.asr_backend}
            onChange={e => onChange({ asr_backend: e.target.value as AsrSettings['asr_backend'] })}>
            <option value="auto">Auto (recommended)</option>
            <option value="gpu" disabled={status != null && !status.hardware.gpu}>GPU</option>
            <option value="cpu">CPU</option>
          </select>
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: '1rem' }}>
        <input type="checkbox" checked={value.asr_adaptive !== 'false'}
          onChange={e => onChange({ asr_adaptive: e.target.checked ? 'true' : 'false' })} />
        Adapt during meetings — step down automatically if this machine falls behind, recover when it's calm
      </label>

      {shown && (
        <div style={{ marginTop: '1rem', fontSize: 14 }}>
          <div><b>You:</b> {fmtPlan(shown.channels.Me)} · <b>Room:</b> {fmtPlan(shown.channels.Participant)}</div>
          {shown.reasons.map(r => <div key={r} style={{ color: 'var(--text-secondary)' }}>· {r}</div>)}
          {shown.warnings.map(w => (
            <div key={w} style={{ color: '#ffb86b', display: 'flex', gap: 6, marginTop: 6 }}>
              <AlertTriangle size={16} style={{ flexShrink: 0 }} /> {w}
            </div>
          ))}
          {manual && <button className="btn" style={{ marginTop: 8 }}
            onClick={() => onChange({ asr_profile: 'auto', asr_backend: 'auto' })}>Use recommended</button>}
        </div>
      )}

      <button className="btn" style={{ marginTop: '1rem' }} onClick={recalibrate} disabled={status?.calibrating}>
        <RefreshCw size={16} /> {status?.calibrating ? 'Measuring…' : 'Re-measure this machine'}
      </button>
      {error && <div style={{ color: '#ff7b7b', marginTop: 8 }}>{error}</div>}
    </div>
  )
}
