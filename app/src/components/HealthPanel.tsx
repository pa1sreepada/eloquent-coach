import { Activity, AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { STATUS_COLOR, useHealth, type CallStats, type Health } from './health';

const LABEL = { good: 'All systems normal', warning: 'Needs attention', problem: 'Something is wrong' } as const;
const secs = (v: number | null) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} s`);

function calls(c: CallStats) {
  if (!c.calls) return 'No calls yet';
  return `${secs(c.p50_s)} typical · ${secs(c.p90_s)} slow · ${c.failures}/${c.calls} failed`;
}

function Metric({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'good' | 'warning' | 'problem' }) {
  return (
    <div style={{ padding: '0.7rem 0.85rem', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
      <div className="eyebrow" style={{ marginBottom: '0.3rem' }}>{label}</div>
      <div style={{ fontSize: '0.95rem', color: tone ? STATUS_COLOR[tone] : 'var(--text-primary)' }}>{value}</div>
      {note && <div style={{ fontSize: '0.74rem', color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>{note}</div>}
    </div>
  );
}

export function Issues({ health }: { health: Health }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {health.issues.map(i => (
        <div key={i.title} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
          {i.level === 'problem' ? <XCircle size={16} color={STATUS_COLOR.problem} style={{ marginTop: 2, flexShrink: 0 }} />
            : <AlertTriangle size={16} color={STATUS_COLOR.warning} style={{ marginTop: 2, flexShrink: 0 }} />}
          <div style={{ fontSize: '0.88rem' }}>
            <div style={{ fontWeight: 500 }}>{i.title}</div>
            <div style={{ color: 'var(--text-secondary)' }}>{i.detail}</div>
            <div style={{ color: 'var(--text-tertiary)' }}>Fix: {i.fix}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Settings → System health: what the coach depends on, and whether it is fast enough for live coaching. */
export default function HealthPanel() {
  const { health, error, refresh } = useHealth(15000);
  const m = health?.memory;
  const swap = m?.swap_used_gb ?? null;
  return (
    <div id="settings-health" className="glass-panel" style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.2rem', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Activity size={20} color="var(--accent-primary)" /> System health
        </h2>
        <button className="btn btn-outline" onClick={() => void refresh()}><RefreshCw size={14} /> Check now</button>
      </div>
      {!health ? <div style={{ color: 'var(--text-tertiary)', fontSize: '0.88rem' }}>{error ? 'The backend is not answering yet.' : 'Checking…'}</div> : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: STATUS_COLOR[health.status], fontWeight: 500 }}>
            {health.status === 'good' ? <CheckCircle2 size={18} /> : health.status === 'warning' ? <AlertTriangle size={18} /> : <XCircle size={18} />}
            {LABEL[health.status]}
          </div>
          {health.issues.length > 0 && <Issues health={health} />}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '0.6rem' }}>
            <Metric label="LLM server" value={health.llm.reachable ? `Reachable${health.llm.probe_ms != null ? ` (${health.llm.probe_ms} ms)` : ''}` : 'Not reachable'}
              tone={health.llm.reachable ? 'good' : 'problem'} note={`${health.llm.model}${health.llm.thinking ? ' · thinking on' : ''}`} />
            <Metric label="Live coaching calls" value={calls(health.llm_calls.coach)} note={`Cards slower than ${health.llm_calls.live_timeout_s} s are dropped`}
              tone={health.llm_calls.coach.calls && health.llm_calls.coach.failures / health.llm_calls.coach.calls >= 0.3 ? 'problem' : undefined} />
            <Metric label="Summaries, briefs, rephrase" value={calls(health.llm_calls.task)}
              note={health.llm.external ? `External model for post-meeting work${health.llm.external_model ? `: ${health.llm.external_model}` : ''}` : 'Local model'} />
            <Metric label="Memory" value={m?.pressure ? `${m.pressure[0].toUpperCase()}${m.pressure.slice(1)} pressure` : '—'}
              tone={m?.pressure === 'critical' ? 'problem' : m?.pressure === 'warning' ? 'warning' : m?.pressure ? 'good' : undefined}
              note={`${m?.total_gb ?? '—'} GB RAM · ${swap ?? '—'} GB swap in use`} />
            <Metric label="Speech recognition" value={health.asr.calibrating ? 'Calibrating…' : health.asr.calibrated ? 'Calibrated for this Mac' : 'Not calibrated yet'}
              note={health.asr.live.length ? `Live lag ${health.asr.live.map(l => l.asr_lag_ms == null ? '—' : `${(l.asr_lag_ms / 1000).toFixed(1)} s`).join(', ')}` : 'On-device (Parakeet)'} />
            <Metric label="Data at rest" value={health.security.encryption ? 'Encrypted' : 'Unknown'} tone={health.security.encryption ? 'good' : 'warning'}
              note={health.security.encryption ? `${health.security.encryption} (AES-256)` : undefined} />
          </div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-tertiary)' }}>
            Timings cover the last 40 calls since the backend started; no meeting content is recorded.
          </div>
        </>
      )}
    </div>
  );
}

/** Dashboard strip: shown only when something needs attention, with a link to the full panel. */
export function HealthBanner({ onOpen }: { onOpen: () => void }) {
  const { health } = useHealth(60000);
  if (!health || health.status === 'good' || !health.issues.length) return null;
  const top = health.issues[0];
  return (
    <section className="glass-panel" style={{ padding: '0.9rem 1.2rem', display: 'flex', gap: '0.7rem', alignItems: 'center',
      borderColor: health.status === 'problem' ? 'rgba(248,113,113,0.45)' : 'rgba(251,191,36,0.4)' }}>
      {health.status === 'problem' ? <XCircle size={18} color={STATUS_COLOR.problem} /> : <AlertTriangle size={18} color={STATUS_COLOR.warning} />}
      <div style={{ flex: 1, fontSize: '0.88rem' }}>
        <div style={{ fontWeight: 500 }}>{top.title}{health.issues.length > 1 ? ` (+${health.issues.length - 1} more)` : ''}</div>
        <div style={{ color: 'var(--text-tertiary)' }}>{top.fix}</div>
      </div>
      <button className="btn btn-outline" onClick={onOpen}>Details</button>
    </section>
  );
}
