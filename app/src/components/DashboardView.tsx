import { useState, useEffect } from 'react';
import { Play, TrendingUp, Clock, Calendar, ChevronRight, Zap } from 'lucide-react';

interface DashboardStats {
  avg_score: number;
  talk_time_pct: number;
  confidence_score: number;
  recent_meetings: {
    id: number;
    title: string;
    date: string;
    score: number;
    duration: string;
  }[];
}

export default function DashboardView({ onStartMeeting, onViewHistory }: { onStartMeeting: (mode: string, agenda: string, prepNotes?: string) => void, onViewHistory: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedMode, setSelectedMode] = useState('General Executive');
  const [agendaInput, setAgendaInput] = useState('');
  const [prepNotesInput, setPrepNotesInput] = useState('');
  const [showPrepNotes, setShowPrepNotes] = useState(false);

  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    // The backend can take a while to start (first-run model download), so retry until it answers.
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      fetch('http://127.0.0.1:8000/dashboard/stats')
        .then(res => res.json())
        .then(data => {
          if (cancelled) return;
          setStats(data);
          setLoadError(false);
          setIsLoading(false);
        })
        .catch(err => {
          if (cancelled) return;
          attempts += 1;
          if (attempts >= 5) setLoadError(true);
          if (attempts === 5) console.error("Failed to load dashboard stats:", err);
          timer = setTimeout(load, 2000);
        });
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  if (isLoading || !stats) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div className="pulse-animation" style={{ textAlign: 'center' }}>
          {loadError
            ? <>Waiting for the backend to start…<br /><small style={{ color: 'var(--text-secondary)' }}>The first launch can take a few minutes while speech models download. Check the terminal for errors.</small></>
            : 'Loading Efficacy Data...'}
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column', paddingRight: '1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ marginBottom: '0.2rem', fontSize: '2rem' }}>Executive Command Center</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem' }}>Real-time strategic communication, Contextual 4-Cue assistance, and post-meeting briefings.</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', alignItems: 'flex-end', width: '560px' }}>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', width: '100%', justifyContent: 'flex-end' }}>
            <select 
              value={selectedMode} 
              onChange={(e) => setSelectedMode(e.target.value)}
              style={{ 
                padding: '0.8rem 1rem', 
                borderRadius: '8px', 
                background: 'rgba(255,255,255,0.08)', 
                border: '1px solid rgba(255,255,255,0.15)',
                color: 'white',
                fontSize: '0.95rem',
                outline: 'none',
                flex: 1
              }}
            >
              <option value="General Executive">General Executive Alignment</option>
              <option value="Fireside Chat & Guest Speaker">Fireside Chat & Guest Speaker Moderation</option>
              <option value="Board & Investor Pitch">Board & Investor Pitch Mode</option>
              <option value="1:1 Coaching & Feedback">1:1 Coaching & Feedback Mode</option>
              <option value="Negotiation & Deal Mode">Negotiation & Deal Mode</option>
              <option value="Conflict Resolution">Conflict Resolution & De-escalation</option>
              <option value="OKR & Delivery Review">OKR & Delivery Accountability</option>
            </select>
            <button 
              className="btn btn-primary" 
              onClick={() => onStartMeeting(selectedMode, agendaInput, prepNotesInput)}
              style={{ 
                padding: '0.8rem 1.8rem', 
                fontSize: '1rem', 
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                boxShadow: '0 8px 20px -6px var(--accent-primary)',
                whiteSpace: 'nowrap'
              }}
            >
              <Play size={18} fill="currentColor" />
              Start Live Session
            </button>
          </div>
          
          {/* Agenda & Prep Notes Inputs */}
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <input 
              type="text" 
              placeholder="Optional Agenda / Goals (e.g. Align on Q3 Roadmap, finalize hiring budget)..."
              value={agendaInput}
              onChange={(e) => setAgendaInput(e.target.value)}
              style={{
                width: '100%',
                padding: '0.6rem 0.9rem',
                borderRadius: '6px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
                fontSize: '0.85rem'
              }}
            />

            {/* Collapsible Context & Prep Notes Section */}
            <div style={{ width: '100%' }}>
              <button
                type="button"
                onClick={() => setShowPrepNotes(!showPrepNotes)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#60a5fa',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  fontWeight: 500
                }}
              >
                {showPrepNotes ? '▲ Hide Prep Notes & References' : '▼ Add Context & Prep Notes (Bios, Materials, Key Metrics)'}
              </button>

              {showPrepNotes && (
                <textarea
                  placeholder="Paste prep notes, attendee bios, key metrics, or reference facts here. The AI will surface exact Answers, Concepts, and Bios during your call..."
                  value={prepNotesInput}
                  onChange={(e) => setPrepNotesInput(e.target.value)}
                  rows={3}
                  style={{
                    width: '100%',
                    marginTop: '0.4rem',
                    padding: '0.6rem 0.9rem',
                    borderRadius: '6px',
                    background: 'rgba(59, 130, 246, 0.06)',
                    border: '1px solid rgba(59, 130, 246, 0.2)',
                    color: 'var(--text-primary)',
                    fontSize: '0.82rem',
                    resize: 'vertical',
                    fontFamily: 'inherit'
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Stats Overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2rem', marginBottom: '3rem' }}>
        <StatCard 
          icon={<TrendingUp size={22} color="var(--color-structure)" />} 
          label="LPS Proficiency Score" 
          value={`${stats.avg_score ?? 0}/10`} 
          trend="+0.4 from last week"
          trendColor="var(--color-structure)"
        />
        <StatCard 
          icon={<Clock size={22} color="var(--accent-primary)" />} 
          label="Talk Time %" 
          value={`${stats.talk_time_pct ?? 0}%`} 
          trend="Target: 30-40%"
          trendColor="var(--text-tertiary)"
        />
        <StatCard 
          icon={<Zap size={22} color="#F59E0B" />} 
          label="Confidence" 
          value={String(stats.confidence_score ?? 0)} 
          trend="Optimal pacing"
          trendColor="var(--color-structure)"
        />
      </div>

      {/* Advanced Executive Metrics */}
      <div style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.4rem', marginBottom: '1.5rem' }}>Executive Presence</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2rem' }}>
          <div className="glass-panel" style={{ padding: '1.5rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>We/I Alignment</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 600 }}>8.4</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-structure)', marginTop: '0.5rem' }}>Strongly Collaborative</div>
          </div>
          <div className="glass-panel" style={{ padding: '1.5rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Future Focus</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 600 }}>72%</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-structure)', marginTop: '0.5rem' }}>Strategic Velocity High</div>
          </div>
          <div className="glass-panel" style={{ padding: '1.5rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Avg. Wait Time</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 600 }}>2.4s</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-structure)', marginTop: '0.5rem' }}>Optimal space given</div>
          </div>
        </div>
      </div>

      {/* Recent Strategic Sessions */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.4rem', margin: 0 }}>Recent Strategic Sessions</h2>
          <span 
            onClick={onViewHistory}
            style={{ fontSize: '0.9rem', color: 'var(--accent-primary)', fontWeight: 600, cursor: 'pointer' }}
          >
            View All History
          </span>
        </div>
        
        {!stats.recent_meetings?.length ? (
          <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem', opacity: 0.8 }}>
            <Calendar size={48} style={{ marginBottom: '1.5rem', opacity: 0.3 }} />
            <h3 style={{ margin: '0 0 0.5rem 0', color: 'var(--text-secondary)' }}>Your history is quiet</h3>
            <p style={{ margin: 0, textAlign: 'center', maxWidth: '350px', color: 'var(--text-tertiary)' }}>
              Complete your first coached session to see performance analytics here.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto', paddingBottom: '1rem' }}>
            {stats.recent_meetings.map((m) => (
              <MeetingRow 
                key={m.id}
                title={m.title}
                date={m.date}
                score={m.score}
                duration={m.duration}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, trend, trendColor }: any) {
  return (
    <div className="glass-panel" style={{ padding: '2rem', position: 'relative', overflow: 'hidden' }}>
      <div style={{ 
        position: 'absolute', top: '-10px', right: '-10px', width: '60px', height: '60px', 
        background: 'var(--accent-primary)', opacity: 0.03, borderRadius: '50%' 
      }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ 
          width: '44px', height: '44px', borderRadius: '12px', 
          background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid rgba(255,255,255,0.08)'
        }}>
          {icon}
        </div>
        <span style={{ color: 'var(--text-secondary)', fontWeight: 600, fontSize: '1rem' }}>{label}</span>
      </div>
      <div style={{ fontSize: '2.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem', letterSpacing: '-1px' }}>
        {value}
      </div>
      <div style={{ fontSize: '0.9rem', color: trendColor, fontWeight: 500 }}>
        {trend}
      </div>
    </div>
  );
}

function MeetingRow({ title, date, score, duration }: any) {
  return (
    <div className="glass-panel glass-panel-hover" style={{ 
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '1.2rem 1.5rem', cursor: 'pointer', transition: 'transform 0.2s'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(59, 130, 246, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Zap size={18} color="var(--accent-primary)" />
        </div>
        <div>
          <h3 style={{ fontSize: '1.1rem', margin: 0, fontWeight: 600 }}>{title}</h3>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>{date}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '3rem' }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}>Duration</div>
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{duration}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}>Score</div>
          <div style={{ fontWeight: 700, color: 'var(--color-structure)' }}>{score}/10</div>
        </div>
        <ChevronRight size={20} color="var(--text-tertiary)" />
      </div>
    </div>
  );
}
