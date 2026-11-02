import { useState, useEffect } from 'react';
import { Calendar, Clock, Star, FileText, RefreshCw, Cpu, Download } from 'lucide-react';

interface Meeting {
  id: number;
  title: string;
  start_time: string;
  end_time: string;
  summary: string | null;
  score: number;
}

interface MeetingDetails extends Meeting {
  mode: string;
  agenda?: string;
  lps_score: number | null;
  transcripts: { id: number; speaker: string; text: string; timestamp: string }[];
  metrics: { 
    talk_time: number; 
    pacing: number; 
    interruptions: number; 
    confidence_score?: number;
    wait_time_avg?: number;
    question_ratio?: number;
    we_i_ratio?: number;
    future_focus_pct?: number;
  }[];
  strategic_alternatives?: string;
}

export default function ReportsView({ initialMeetingId }: { initialMeetingId?: number | null }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(initialMeetingId || null);
  const [meetingDetails, setMeetingDetails] = useState<MeetingDetails | null>(null);
  
  const [isLoadingMeetings, setIsLoadingMeetings] = useState(true);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [synthesisError, setSynthesisError] = useState<string | null>(null);

  useEffect(() => {
    fetchMeetings();
  }, []);

  useEffect(() => {
    if (initialMeetingId) {
      setSelectedMeetingId(initialMeetingId);
    }
  }, [initialMeetingId]);

  useEffect(() => {
    if (selectedMeetingId) {
      fetchMeetingDetails(selectedMeetingId, false);
    }
  }, [selectedMeetingId]);

  const fetchMeetings = async () => {
    try {
      const res = await fetch('http://127.0.0.1:8000/meetings');
      const data = await res.json();
      setMeetings(data);
      if (data.length > 0 && !selectedMeetingId && !initialMeetingId) {
        setSelectedMeetingId(data[0].id);
      }
    } catch (err) {
      console.error("Failed to fetch meetings:", err);
    } finally {
      setIsLoadingMeetings(false);
    }
  };

  const fetchMeetingDetails = async (id: number, silent = false) => {
    if (!silent) setIsLoadingDetails(true);
    try {
      const res = await fetch(`http://127.0.0.1:8000/meetings/${id}`);
      const data = await res.json();
      setMeetingDetails(data);
    } catch (err) {
      console.error("Failed to fetch details:", err);
    } finally {
      if (!silent) setIsLoadingDetails(false);
    }
  };

  const generateSynthesis = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!selectedMeetingId) return;
    
    setIsSynthesizing(true);
    setSynthesisError(null);
    
    try {
      const res = await fetch(`http://127.0.0.1:8000/meetings/${selectedMeetingId}/synthesize`, {
        method: 'POST'
      });
      const data = await res.json();
      
      if (data.status === 'success') {
        if (typeof data.summary === 'string' && (data.summary.includes('Failed to generate') || data.summary.includes('Error generating'))) {
          setSynthesisError(data.summary);
        } else {
          await fetchMeetingDetails(selectedMeetingId, true);
          await fetchMeetings();
        }
      } else {
        setSynthesisError(data.error || "Failed to generate executive synthesis.");
      }
    } catch (err: any) {
      console.error("Failed to synthesize:", err);
      setSynthesisError("Could not reach backend server or LLM API. Make sure LM Studio or your local LLM server is running.");
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleExportMarkdown = async () => {
    if (!selectedMeetingId) return;
    try {
      const res = await fetch(`http://127.0.0.1:8000/meetings/${selectedMeetingId}/export`);
      const data = await res.json();
      if (data.export_markdown) {
        const blob = new Blob([data.export_markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Executive_Briefing_Session_${selectedMeetingId}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Failed to export briefing:", err);
    }
  };

  const formatDuration = (start: string, end: string | null) => {
    if (!start || !end) return "--";
    const diff = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  if (isLoadingMeetings) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <RefreshCw className="pulse-animation" size={24} />
      </div>
    );
  }

  if (meetings.length === 0) {
    return (
      <div className="fade-in" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
        <div style={{ textAlign: 'center' }}>
          <FileText size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
          <h2 style={{ color: 'var(--text-secondary)' }}>No meetings recorded yet</h2>
          <p>Start a Live Coaching session to see your post-meeting syntheses here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ height: '100%', display: 'flex', gap: '2rem' }}>
      
      {/* Sidebar List */}
      <div style={{ width: '300px', display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto' }}>
        <h2 style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>Recent Meetings</h2>
        {meetings.map((m) => (
          <div 
            key={m.id}
            onClick={() => setSelectedMeetingId(m.id)}
            style={{
              padding: '1rem',
              borderRadius: '8px',
              backgroundColor: selectedMeetingId === m.id ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${selectedMeetingId === m.id ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)'}`,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{m.title || `Session #${m.id}`}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                {new Date(m.start_time).toLocaleDateString()}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><Clock size={12} /> {formatDuration(m.start_time, m.end_time)}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: 'var(--color-praise)' }}><Star size={12} /> {m.score}/10</span>
            </div>
          </div>
        ))}
      </div>

      {/* Main Details Panel */}
      <div className="glass-panel" style={{ flex: 1, padding: '2rem', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {isLoadingDetails || !meetingDetails ? (
           <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
             <RefreshCw className="pulse-animation" size={24} />
           </div>
        ) : (
          <>
            <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h1 style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>{meetingDetails.title || `Session #${meetingDetails.id}`}</h1>
                <div style={{ display: 'flex', gap: '1.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Calendar size={14} /> {new Date(meetingDetails.start_time).toLocaleString()}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Clock size={14} /> {formatDuration(meetingDetails.start_time, meetingDetails.end_time)}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-primary)' }}>
                    <Star size={14} /> Persona: {meetingDetails.mode}
                  </span>
                  {meetingDetails.agenda && (
                    <span style={{ width: '100%', marginTop: '0.5rem', color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
                      <strong>Agenda / Objectives:</strong> {meetingDetails.agenda}
                    </span>
                  )}
                </div>
              </div>
              {meetingDetails.lps_score && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Session LPS</div>
                  <div style={{ fontSize: '2.5rem', fontWeight: 700, color: 'var(--color-praise)' }}>{meetingDetails.lps_score}</div>
                </div>
              )}
            </header>

            {/* Advanced Metrics Summary Bar */}
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(4, 1fr)', 
              gap: '1rem', 
              marginBottom: '2rem',
              padding: '1rem',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.05)'
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.2rem' }}>Inquiry Ratio</div>
                <div style={{ fontWeight: 600 }}>{Math.round((meetingDetails.metrics[0]?.question_ratio || 0) * 100)}%</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.2rem' }}>We/I Alignment</div>
                <div style={{ fontWeight: 600 }}>{Math.round((meetingDetails.metrics[0]?.we_i_ratio || 0.5) * 10)}/10</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.2rem' }}>Future Focus</div>
                <div style={{ fontWeight: 600 }}>{Math.round(meetingDetails.metrics[0]?.future_focus_pct || 0)}%</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.2rem' }}>Avg. Wait Time</div>
                <div style={{ fontWeight: 600 }}>{(meetingDetails.metrics[0]?.wait_time_avg || 0).toFixed(1)}s</div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '2rem', flex: 1, minHeight: 0 }}>
              
              {/* Left Column: Synthesis */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto', paddingRight: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, color: 'var(--text-secondary)' }}>
                    <Cpu size={16} /> Executive Briefing & Synthesis
                  </h3>
                  {meetingDetails.summary && (
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button 
                        className="btn btn-outline" 
                        onClick={handleExportMarkdown}
                        style={{ padding: '0.3rem 0.8rem', fontSize: '0.8rem', height: 'auto', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                      >
                        <Download size={12} />
                        Export .md
                      </button>
                      <button 
                        className="btn btn-outline" 
                        onClick={() => {
                          navigator.clipboard.writeText(`${meetingDetails.summary}\n\n${meetingDetails.strategic_alternatives || ''}`);
                        }}
                        style={{ padding: '0.3rem 0.8rem', fontSize: '0.8rem', height: 'auto' }}
                      >
                        Copy Briefing
                      </button>
                      <button 
                        type="button"
                        className="btn btn-outline" 
                        onClick={(e) => generateSynthesis(e)}
                        disabled={isSynthesizing}
                        style={{ padding: '0.3rem 0.8rem', fontSize: '0.8rem', height: 'auto' }}
                      >
                        {isSynthesizing ? <RefreshCw className="pulse-animation" size={12} /> : <RefreshCw size={12} />}
                        Regenerate
                      </button>
                    </div>
                  )}
                </div>
                
                {/* Status & Error Feedback Banners */}
                {isSynthesizing && (
                  <div style={{ 
                    padding: '1rem 1.2rem', 
                    borderRadius: '8px', 
                    background: 'rgba(59, 130, 246, 0.1)', 
                    border: '1px solid rgba(59, 130, 246, 0.3)', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.8rem' 
                  }}>
                    <RefreshCw className="pulse-animation" size={20} color="#60a5fa" />
                    <div>
                      <div style={{ fontWeight: 600, color: '#60a5fa', fontSize: '0.9rem' }}>Analyzing Meeting Transcript with Local LLM...</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Synthesizing key decisions, action items, and strategic phrasing pivots (approx 15-30 seconds).</div>
                    </div>
                  </div>
                )}

                {synthesisError && (
                  <div style={{ 
                    padding: '1rem 1.2rem', 
                    borderRadius: '8px', 
                    background: 'rgba(239, 68, 68, 0.1)', 
                    border: '1px solid rgba(239, 68, 68, 0.3)', 
                    color: 'var(--color-risk)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.3rem'
                  }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Synthesis Could Not Complete</div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{synthesisError}</div>
                  </div>
                )}

                {meetingDetails.summary ? (
                  <div style={{ 
                    backgroundColor: 'rgba(59, 130, 246, 0.05)', 
                    border: '1px solid rgba(59, 130, 246, 0.2)',
                    borderRadius: '8px',
                    padding: '1.5rem',
                    color: 'var(--text-primary)',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap'
                  }}>
                    {meetingDetails.summary}
                  </div>
                ) : (
                  <div style={{ 
                    backgroundColor: 'rgba(255,255,255,0.02)', 
                    border: '1px dashed rgba(255,255,255,0.1)',
                    borderRadius: '8px',
                    padding: '3rem 2rem',
                    textAlign: 'center',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem'
                  }}>
                    <FileText size={32} style={{ opacity: 0.5 }} />
                    <p style={{ color: 'var(--text-secondary)', margin: 0 }}>No synthesis has been generated for this meeting yet.</p>
                    <button 
                      type="button"
                      className="btn btn-primary"
                      onClick={(e) => generateSynthesis(e)}
                      disabled={isSynthesizing}
                      style={{ opacity: isSynthesizing ? 0.7 : 1 }}
                    >
                      {isSynthesizing ? <RefreshCw className="pulse-animation" size={16} /> : <Cpu size={16} />} 
                      {isSynthesizing ? 'Generating Executive Synthesis...' : 'Generate Executive Synthesis'}
                    </button>
                    <small style={{ color: 'var(--text-tertiary)' }}>This will analyze your transcript using your local LLM to extract key decisions, action items, and strategic pivots.</small>
                  </div>
                )}

                {/* Strategic Rerouting Section */}
                {meetingDetails.strategic_alternatives && (
                  <div style={{ marginTop: '1rem' }}>
                    <h3 style={{ fontSize: '1rem', color: 'var(--color-praise)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Star size={16} /> 
                      {meetingDetails.mode.includes("Fireside") || meetingDetails.mode.includes("Guest")
                        ? "Strategic Moderation Pivots & Experiential Wisdom Takeaways"
                        : "Strategic Executive Rerouting & Phrasing Pivots"}
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      {meetingDetails.strategic_alternatives.split('\n').filter(line => line.includes('|')).map((line, idx) => {
                        const parts = line.split('|');
                        let origin = parts[0] || "";
                        let alternative = parts[1] || "";
                        let rationale = parts[2] || "";
                        
                        if (origin.includes(":")) origin = origin.substring(origin.indexOf(":") + 1).trim();
                        if (alternative.includes(":")) alternative = alternative.substring(alternative.indexOf(":") + 1).trim();
                        if (rationale.includes(":")) rationale = rationale.substring(rationale.indexOf(":") + 1).trim();
                        
                        const isFireside = meetingDetails.mode.includes("Fireside") || meetingDetails.mode.includes("Guest");

                        return (
                          <div key={idx} className="glass-panel" style={{ padding: '1.2rem', borderLeft: '4px solid var(--color-praise)', backgroundColor: 'rgba(139, 92, 246, 0.04)' }}>
                            <div style={{ fontSize: '0.75rem', color: 'var(--color-risk)', marginBottom: '0.3rem', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.5px' }}>
                              {isFireside ? "Moderator Statement / Surface-Level Probe:" : "Instead of saying (Tentative/Vague):"}
                            </div>
                            <div style={{ color: 'var(--text-secondary)', marginBottom: '0.8rem', fontStyle: 'italic', background: 'rgba(239, 68, 68, 0.05)', padding: '0.5rem 0.8rem', borderRadius: '4px' }}>
                              "{origin.replace(/^["']|["']$/g, '')}"
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--color-structure)', marginBottom: '0.3rem', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.5px' }}>
                              {isFireside ? "High-Impact Probing Question / Pivot:" : "Executive Pivot (Authoritative & Strategic):"}
                            </div>
                            <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.8rem', background: 'rgba(16, 185, 129, 0.08)', padding: '0.5rem 0.8rem', borderRadius: '4px' }}>
                              {alternative.replace(/^["']|["']$/g, '')}
                            </div>
                            {rationale && (
                              <div style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', background: 'rgba(255,255,255,0.03)', padding: '0.5rem 0.8rem', borderRadius: '4px', borderLeft: '2px solid var(--accent-primary)' }}>
                                <strong>{isFireside ? "Mindful Learning Guidance:" : "Strategic Rationale:"}</strong> {rationale}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Column: Transcript */}
              <div style={{ width: '40%', display: 'flex', flexDirection: 'column', gap: '1rem', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '2rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, color: 'var(--text-secondary)' }}>
                    <FileText size={16} /> Raw Transcript
                  </h3>
                  <button 
                    className="btn btn-outline"
                    onClick={() => fetch(`http://127.0.0.1:8000/meetings/${selectedMeetingId}/open-folder`, { method: 'POST' })}
                    style={{ padding: '0.3rem 0.8rem', fontSize: '0.8rem', height: 'auto', border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)' }}
                  >
                    Open Folder
                  </button>
                </div>
                
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem', paddingRight: '1rem' }}>
                  {meetingDetails.transcripts.length === 0 ? (
                    <p style={{ color: 'var(--text-tertiary)' }}>No transcript data available.</p>
                  ) : (
                    meetingDetails.transcripts.map((t, i) => (
                      <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          {new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second:'2-digit' })}
                        </span>
                        <div style={{ 
                          backgroundColor: 'rgba(255,255,255,0.05)', 
                          padding: '0.8rem', 
                          borderRadius: '8px',
                          fontSize: '0.9rem',
                          color: 'var(--text-secondary)'
                        }}>
                          {t.text}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>
          </>
        )}
      </div>
      
    </div>
  );
}
