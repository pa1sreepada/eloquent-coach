import { useState, useEffect } from 'react';
import { Play, ChevronDown, ChevronRight } from 'lucide-react';
import { MODES } from './meetingModes';

interface DashboardStats {
  sessions: number;
  sessions_this_week: number;
  hours: number;
  avg_score: number | null;
  talk_share_pct: number | null;
  question_pct: number | null;
  fillers_per_session: number | null;
}

export default function DashboardView({ onStartMeeting, onViewHistory }: { onStartMeeting: (mode: string, agenda: string, prepNotes?: string) => void, onViewHistory: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState(() => localStorage.getItem('lastMode') || 'General Executive');
  const [agenda, setAgenda] = useState('');
  const [prepNotes, setPrepNotes] = useState('');
  const [showPrep, setShowPrep] = useState(false);

  useEffect(() => {
    // The backend can take a while to start (first-run model download), so retry until it answers.
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      fetch('http://127.0.0.1:8000/dashboard/stats')
        .then(res => res.json())
        .then(data => { if (!cancelled) { setStats(data); setLoadError(false); } })
        .catch(err => {
          if (cancelled) return;
          attempts += 1;
          if (attempts >= 5) setLoadError(true);
          if (attempts === 5) console.error('Failed to load dashboard stats:', err);
          timer = setTimeout(load, 2000);
        });
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const start = () => {
    localStorage.setItem('lastMode', mode);
    onStartMeeting(mode, agenda.trim(), prepNotes.trim());
  };

  const fmt = (v: number | null | undefined, suffix = '') => (v == null ? '—' : `${v}${suffix}`);

  return (
    <div className="fade-in" style={{ maxWidth: '880px', margin: '0 auto', padding: '1.5rem 0 2rem', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <header>
        <h1 style={{ fontSize: '1.9rem', marginBottom: '0.25rem' }}>{greeting()}</h1>
        <p style={{ margin: 0, fontSize: '1rem' }}>Set the context, then start. Coaching appears live and in the HUD.</p>
      </header>

      {/* New session */}
      <section className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: '0.5rem' }}>Meeting type</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {MODES.map(([value, label]) => (
              <button key={value} onClick={() => setMode(value)}
                style={{
                  padding: '0.4rem 0.85rem', borderRadius: '999px', fontSize: '0.85rem', cursor: 'pointer',
                  border: `1px solid ${mode === value ? 'rgba(59,130,246,0.7)' : 'var(--border-color)'}`,
                  background: mode === value ? 'rgba(59,130,246,0.15)' : 'transparent',
                  color: mode === value ? '#bfdbfe' : 'var(--text-secondary)', transition: 'all 0.15s ease',
                }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: '0.5rem' }}>Goal <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(optional)</span></div>
          <input className="field" value={agenda} onChange={(e) => setAgenda(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start(); }}
            placeholder="e.g. Align on the Q3 roadmap and agree the hiring budget" />
        </div>

        <div>
          <button onClick={() => setShowPrep(!showPrep)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            {showPrep ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Prep notes {prepNotes && !showPrep ? '· added' : ''}
          </button>
          {showPrep && (
            <textarea className="field" rows={4} value={prepNotes} onChange={(e) => setPrepNotes(e.target.value)}
              style={{ marginTop: '0.5rem', resize: 'vertical' }}
              placeholder="Attendee bios, key numbers, decisions needed. The coach only cites facts from here or the conversation." />
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={start} title="Start session (⌘↩ from the goal field)"
            style={{ padding: '0.65rem 1.4rem', borderRadius: '10px', boxShadow: '0 6px 18px -6px var(--accent-primary)' }}>
            <Play size={15} fill="currentColor" /> Start Session
          </button>
        </div>
      </section>

      {/* Your trends (real data only) */}
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
          <div className="eyebrow">Your trends</div>
          <button onClick={onViewHistory} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#60a5fa', fontSize: '0.85rem' }}>
            Meeting History
          </button>
        </div>
        {!stats ? (
          <div className="glass-panel" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
            {loadError
              ? <>Waiting for the backend to start…<br /><small>The first launch can take a few minutes while speech models download. Check the terminal for errors.</small></>
              : 'Loading…'}
          </div>
        ) : stats.sessions === 0 ? (
          <div className="glass-panel" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
            Trends appear after your first session.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' }}>
            <Stat label="Sessions" value={String(stats.sessions)} note={`${stats.sessions_this_week} this week · ${stats.hours}h total`} />
            <Stat label="Leadership score" value={fmt(stats.avg_score, '/10')} note="Average across sessions" />
            <Stat label="Your talk share" value={fmt(stats.talk_share_pct, '%')} note="Aim for 30–40%"
              tone={stats.talk_share_pct == null ? undefined : stats.talk_share_pct > 50 ? 'warn' : 'good'} />
            <Stat label="Questions asked" value={fmt(stats.question_pct, '%')} note="Share of your sentences" />
          </div>
        )}
      </section>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Stat({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="glass-panel" style={{ padding: '1rem 1.1rem' }}>
      <div className="eyebrow" style={{ fontSize: '0.68rem' }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 600, letterSpacing: '-0.02em', margin: '0.2rem 0',
        color: tone === 'warn' ? '#f59e0b' : 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>{note}</div>
    </div>
  );
}
