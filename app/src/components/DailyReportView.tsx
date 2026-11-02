import { useState, useEffect } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Activity, Clock, MessageSquare, TrendingUp, RefreshCw } from 'lucide-react';

interface DailyReport {
  date: string;
  count: number;
  total_duration: number;
  avg_talk_time: number;
  avg_pacing: number;
  highlights: string[];
}

export default function DailyReportView() {
  const [reportDate, setReportDate] = useState(new Date().toISOString().split('T')[0]);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchReport();
  }, [reportDate]);

  const fetchReport = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`http://127.0.0.1:8000/reports/daily/${reportDate}`);
      const data = await res.json();
      setReport(data);
    } catch (err) {
      console.error("Failed to fetch report:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const changeDate = (days: number) => {
    const d = new Date(reportDate);
    d.setDate(d.getDate() + days);
    setReportDate(d.toISOString().split('T')[0]);
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <RefreshCw className="pulse-animation" size={24} />
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Header with Date Selection */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ marginBottom: '0.2rem' }}>Daily Communication Audit</h1>
          <p style={{ color: 'var(--text-tertiary)' }}>Patterns and trends from your meetings on {new Date(reportDate).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', backgroundColor: 'rgba(255,255,255,0.05)', padding: '0.5rem 1rem', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
          <button onClick={() => changeDate(-1)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><ChevronLeft size={20} /></button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
            <Calendar size={18} color="var(--accent-primary)" />
            {reportDate}
          </div>
          <button onClick={() => changeDate(1)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><ChevronRight size={20} /></button>
        </div>
      </header>

      {report && report.count > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', flex: 1 }}>
          
          {/* Top Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.5rem' }}>
            <MetricBox icon={<Activity size={18} />} label="Total Meetings" value={report.count.toString()} sub="Sessions" />
            <MetricBox icon={<Clock size={18} />} label="Total Duration" value={`${report.total_duration}`} sub="Minutes" />
            <MetricBox icon={<MessageSquare size={18} />} label="Avg Talk Time" value={`${report.avg_talk_time}%`} sub={report.avg_talk_time > 60 ? "Too high" : "Healthy"} color={report.avg_talk_time > 60 ? "var(--color-risk)" : "var(--color-praise)"} />
            <MetricBox icon={<TrendingUp size={18} />} label="Avg Pacing" value={`${report.avg_pacing}`} sub="WPM" />
          </div>

          <div style={{ display: 'flex', gap: '2rem', flex: 1, minHeight: 0 }}>
            
            {/* Pattern Analysis */}
            <div className="glass-panel" style={{ flex: 1, padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <TrendingUp size={20} color="var(--accent-primary)" /> Pattern Visualization
              </h3>
              
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', padding: '1rem 0', gap: '1rem' }}>
                {/* Mock trend chart using divs */}
                {[45, 65, 30, 85, 45, 55, 40].map((h, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                    <div style={{ 
                      width: '100%', 
                      height: `${h}%`, 
                      background: i === 3 ? 'linear-gradient(to top, var(--accent-primary), var(--accent-secondary))' : 'rgba(255,255,255,0.1)',
                      borderRadius: '4px 4px 0 0',
                      transition: 'height 1s ease-out'
                    }}></div>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>M{i+1}</span>
                  </div>
                ))}
              </div>
              
              <div style={{ padding: '1rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  <strong>Trend Analysis:</strong> Your talk time peaked during your 4th meeting of the day. You tended to be more structured in the morning sessions.
                </p>
              </div>
            </div>

            {/* Daily Synthesis */}
            <div className="glass-panel" style={{ width: '400px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={20} color="var(--color-praise)" /> Daily Synthesis
              </h3>
              
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {report.highlights.map((h, i) => (
                  <div key={i} style={{ 
                    padding: '1rem', 
                    backgroundColor: 'rgba(255,255,255,0.03)', 
                    borderRadius: '8px',
                    borderLeft: '3px solid var(--accent-primary)',
                    fontSize: '0.9rem',
                    lineHeight: '1.5'
                  }}>
                    {h}
                  </div>
                ))}
              </div>
            </div>

          </div>

        </div>
      ) : (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', color: 'var(--text-tertiary)' }}>
          <Calendar size={48} style={{ opacity: 0.3 }} />
          <p>No activity recorded for this day.</p>
        </div>
      )}
      
    </div>
  );
}

function MetricBox({ icon, label, value, sub, color }: { icon: any, label: string, value: string, sub: string, color?: string }) {
  return (
    <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '1.8rem', fontWeight: 700, color: color || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{sub}</div>
    </div>
  );
}

const FileText = ({ size, style, color }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color || "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <line x1="10" y1="9" x2="8" y2="9" />
  </svg>
);
