import { useState, useEffect, useRef, useCallback } from 'react';
import { Square, Mic, MicOff, AlertCircle, MessageSquare, List, Award, Activity, Copy, Check, HelpCircle, Minimize2, Maximize2, Lightbulb, BookOpen, UserCheck, Scale, Target } from 'lucide-react';
import { useDualChannelCapture } from '../hud/useDualChannelCapture';
import { useCoachEvents } from '../hud/useCoachEvents';
import { applyTranscript, type Line } from '../hud/transcriptStore';
import type { CoachEvent, AsrStatusEvent } from '../hud/protocol';

const API = 'http://127.0.0.1:8000';

interface Insight {
  id: string;
  category: string;
  text: string;
}

const EMPTY_METRICS = { talkTime: 0, pacing: 0, fillerCount: 0, sharePct: 0 };

export default function LiveMeetingView({ isRecording, mode, agenda = '', prepNotes = '', onStopMeeting }: { isRecording: boolean, mode: string, agenda?: string, prepNotes?: string, onStopMeeting: (meetingId?: number | null) => void }) {
  const [transcripts, setTranscripts] = useState<Line[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const [alerts, setAlerts] = useState<string[]>([]);
  const [asr, setAsr] = useState<AsrStatusEvent | null>(null);
  const [meetingId, setMeetingId] = useState<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isHudMode, setIsHudMode] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const isInitializingRef = useRef(false);
  const { start, stop } = useDualChannelCapture(isMuted);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

  const onCoachEvent = useCallback((e: CoachEvent) => {
    if (e.type === 'transcript') {
      setTranscripts(prev => applyTranscript(prev, e));
    } else if (e.type === 'card') {
      const text = e.body ? `${e.headline} — ${e.body}` : e.headline;
      setInsights(prev => [{ id: e.id, category: e.kind, text }, ...prev.filter(i => i.id !== e.id)].slice(0, 6));
    } else if (e.type === 'telemetry') {
      setMetrics({ talkTime: e.my_voiced_s / 60, pacing: e.my_wpm, fillerCount: e.fillers_total, sharePct: e.talk_share_pct });
      setAlerts(e.alerts);
    } else if (e.type === 'asr_status') {
      setAsr(e);
    }
  }, []);
  useCoachEvents(meetingId, onCoachEvent);

  const resetState = () => {
    setMeetingId(null);
    setTranscripts([]);
    setInsights([]);
    setMetrics(EMPTY_METRICS);
    setAlerts([]);
    setAsr(null);
    setConnectionStatus('connecting');
    setIsHudMode(false);
    isInitializingRef.current = false;
  };

  const startAudioCapture = async (id: number) => {
    try {
      setCaptureError(null);
      await start(id, setConnectionStatus);
    } catch (err) {
      console.error('Error accessing audio devices', err);
      setCaptureError(String(err));
      setConnectionStatus('disconnected');
    }
  };

  const stopAudioCapture = (id: number | null) => {
    stop();
    window.eloquent?.hideHud();
    if (id) fetch(`${API}/meetings/${id}/end`, { method: 'POST' }).catch(() => {});
  };

  useEffect(() => {
    if (isRecording && !meetingId && !isInitializingRef.current) {
      isInitializingRef.current = true;
      fetch(`${API}/meetings/?mode=${encodeURIComponent(mode)}&agenda=${encodeURIComponent(agenda)}&prep_notes=${encodeURIComponent(prepNotes)}`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
          setMeetingId(data.meeting_id);
          void startAudioCapture(data.meeting_id);
        })
        .catch(err => {
          console.error('Failed to start meeting', err);
          isInitializingRef.current = false;
        });
    }
    if (!isRecording && meetingId) {
      stopAudioCapture(meetingId);
      resetState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  const handleStop = () => {
    const currentId = meetingId;
    stopAudioCapture(currentId);
    resetState();
    onStopMeeting(currentId);
  };

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getInsightColor = (category: string) => {
    switch (category) {
      case 'question': return '#3b82f6';
      case 'counterpoint': return '#f59e0b';
      case 'alignment': return 'var(--color-structure)';
      case 'bluf': return 'var(--color-praise)';
      case 'context': return '#8b5cf6';
      case 'answer': return '#10b981';
      case 'bio': return '#f59e0b';
      case 'risk': return 'var(--color-risk)';
      default: return 'var(--accent-primary)';
    }
  };

  const getInsightIcon = (category: string) => {
    const c = getInsightColor(category);
    switch (category) {
      case 'question': return <HelpCircle size={16} color={c} />;
      case 'counterpoint': return <Scale size={16} color={c} />;
      case 'alignment': return <List size={16} color={c} />;
      case 'bluf': return <Target size={16} color={c} />;
      case 'context': return <Lightbulb size={16} color={c} />;
      case 'answer': return <BookOpen size={16} color={c} />;
      case 'bio': return <UserCheck size={16} color={c} />;
      case 'risk': return <AlertCircle size={16} color={c} />;
      default: return <Award size={16} color={c} />;
    }
  };

  const insightLabel = (category: string) => ({
    question: 'LEADING QUESTION FOR ROOM',
    counterpoint: 'STRATEGIC COUNTERPOINT',
    alignment: 'ALIGNMENT CUE',
    bluf: 'BOTTOM LINE FIRST',
    context: 'CONTEXT',
  } as Record<string, string>)[category] ?? category;

  // The HUD is a separate transparent, always-on-top window (electron/hudWindow.ts).
  const toggleHudMode = () => {
    if (!meetingId || !window.eloquent) return;
    if (isHudMode) window.eloquent.hideHud();
    else window.eloquent.showHud(meetingId, prepNotes);
    setIsHudMode(!isHudMode);
  };

  const asrLabel = asr
    ? Object.entries(asr.channels).map(([sp, c]) => `${sp === 'Me' ? 'Me' : 'Them'} ${c.device}/${c.profile}`).join(' · ')
    : null;

  return (
    <div className="fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div className="status-dot recording" />
          <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Live Executive Companion</h1>
          <span style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--color-risk)', padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>REC</span>
          <span style={{ 
            fontSize: '0.75rem', 
            padding: '0.2rem 0.6rem', 
            borderRadius: '4px',
            backgroundColor: connectionStatus === 'connected' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            color: connectionStatus === 'connected' ? 'var(--color-structure)' : 'var(--color-risk)',
            border: `1px solid ${connectionStatus === 'connected' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
          }}>
            {connectionStatus.toUpperCase()}
          </span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', background: 'rgba(255,255,255,0.05)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>
            Mode: <strong>{mode}</strong>
          </span>
          {asrLabel && (
            <span title={asr?.pressure ? 'ASR under pressure — adapting' : 'Adaptive ASR plan'} style={{ fontSize: '0.75rem', color: asr?.pressure ? '#f59e0b' : 'var(--text-tertiary)', background: 'rgba(255,255,255,0.05)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>
              ASR: {asrLabel}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <button 
            className="btn btn-outline"
            onClick={toggleHudMode}
            disabled={!meetingId || !window.eloquent}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            title={isHudMode ? "Hide teleprompter overlay" : "Show transparent teleprompter overlay (⌘⇧H)"}
          >
            {isHudMode ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
            {isHudMode ? "Hide HUD" : "Floating HUD"}
          </button>
          <button 
            className="btn btn-outline" 
            onClick={() => setIsMuted(!isMuted)}
            style={{ width: '40px', padding: 0 }}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button className="btn" style={{ backgroundColor: 'var(--color-risk)', color: 'white' }} onClick={handleStop}>
            <Square size={18} fill="currentColor" />
            End Meeting
          </button>
        </div>
      </header>

      {captureError && (
        <div style={{ marginBottom: '0.6rem', padding: '0.6rem 1rem', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.1)', color: 'var(--color-risk)', fontSize: '0.85rem' }}>
          Audio capture failed: {captureError}. Check microphone permission and the devices selected in Settings.
        </div>
      )}

      {alerts.length > 0 && (
        <div style={{ marginBottom: '0.6rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {alerts.map(a => (
            <span key={a} style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.2rem 0.6rem', borderRadius: '4px', background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', letterSpacing: '0.4px' }}>{a}</span>
          ))}
        </div>
      )}

      {agenda && (
        <div style={{ 
          marginBottom: '0.6rem', 
          padding: '0.6rem 1rem', 
          borderRadius: '8px', 
          background: 'rgba(59, 130, 246, 0.08)', 
          border: '1px solid rgba(59, 130, 246, 0.2)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          fontSize: '0.85rem'
        }}>
          <span style={{ fontWeight: 700, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active Agenda Guardrail:</span>
          <span style={{ color: 'var(--text-primary)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agenda}</span>
        </div>
      )}

      {prepNotes && (
        <div style={{ 
          marginBottom: '1rem', 
          padding: '0.6rem 1rem', 
          borderRadius: '8px', 
          background: 'rgba(16, 185, 129, 0.08)', 
          border: '1px solid rgba(16, 185, 129, 0.2)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          fontSize: '0.85rem'
        }}>
          <span style={{ fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Context & Prep Notes Loaded:</span>
          <span style={{ color: 'var(--text-primary)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{prepNotes}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '1.5rem', flex: 1, minHeight: 0 }}>
        {/* Left Column: Live Transcript */}
        <div className="glass-panel" style={{ flex: 2, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
            <h2 style={{ fontSize: '1rem', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <MessageSquare size={16} /> Live Audio Stream
            </h2>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {transcripts.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
                Listening for audio stream...
              </div>
            ) : (
              transcripts.map((t) => (
                <div key={t.id} className="slide-up" style={{ opacity: t.final ? 1 : 0.6 }}>
                  <div className="text-small" style={{ marginBottom: '0.2rem', color: t.speaker === 'Me' ? 'var(--accent-primary)' : 'var(--color-structure)', fontWeight: 600 }}>
                    {t.speaker === 'Me' ? 'Me (Leader)' : 'Participant'}
                  </div>
                  <div style={{ color: 'var(--text-primary)', fontSize: '1.05rem', lineHeight: 1.5 }}>
                    {t.text}
                  </div>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Right Column: Insights & Leading Questions */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Executive Insights & Leading Questions Panel */}
          <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-color)', background: 'rgba(59, 130, 246, 0.08)' }}>
              <h2 style={{ fontSize: '1rem', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#60a5fa' }}>
                <Activity size={16} /> Executive Leading Questions & Pivots
              </h2>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {insights.length === 0 ? (
                <div style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', textAlign: 'center', marginTop: '2rem' }}>
                  Coach is analyzing conversation flow for leading questions...
                </div>
              ) : (
                insights.map((insight) => (
                  <div key={insight.id} className="slide-up" style={{ 
                    background: insight.category === 'question'
                      ? 'rgba(59, 130, 246, 0.12)'
                      : `rgba(${insight.category === 'risk' ? '239, 68, 68' : insight.category === 'alignment' ? '16, 185, 129' : '139, 92, 246'}, 0.1)`,
                    borderLeft: `4px solid ${getInsightColor(insight.category)}`,
                    border: insight.category === 'question' ? '1px solid rgba(59, 130, 246, 0.3)' : undefined,
                    borderLeftWidth: '4px',
                    padding: '1rem', borderRadius: '8px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {getInsightIcon(insight.category)}
                        <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, color: getInsightColor(insight.category) }}>
                          {insightLabel(insight.category)}
                        </span>
                      </div>
                      <button 
                        onClick={() => handleCopyText(insight.id, insight.text)}
                        style={{ 
                          background: 'none', 
                          border: 'none', 
                          cursor: 'pointer', 
                          color: copiedId === insight.id ? 'var(--color-structure)' : 'var(--text-tertiary)',
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: '0.2rem',
                          fontSize: '0.75rem'
                        }}
                        title="Copy question text"
                      >
                        {copiedId === insight.id ? <Check size={14} /> : <Copy size={14} />}
                        {copiedId === insight.id ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div style={{ 
                      fontSize: insight.category === 'question' ? '1.05rem' : '0.95rem', 
                      fontWeight: insight.category === 'question' ? 600 : 400,
                      color: 'var(--text-primary)',
                      lineHeight: 1.4
                    }}>
                      {insight.text}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Live Metrics */}
          <div className="glass-panel" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Live Metrics</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
              <div>
                <div className="text-small">Talk Time</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {metrics.talkTime.toFixed(1)}m
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div className="text-small">Fillers</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 600, color: metrics.fillerCount > 5 ? 'var(--color-risk)' : 'var(--text-primary)' }}>
                  {metrics.fillerCount}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="text-small">Pacing</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--color-structure)' }}>
                  {metrics.pacing.toFixed(0)} <span style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-tertiary)' }}>wpm</span>
                </div>
              </div>
            </div>
            
            {/* My share of voiced airtime */}
            <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ 
                width: `${Math.min(100, metrics.sharePct)}%`, 
                height: '100%', 
                background: 'linear-gradient(90deg, var(--accent-primary), var(--color-praise))',
                transition: 'width 1s ease'
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
              <span>Listen</span>
              <span>{metrics.sharePct.toFixed(0)}% me</span>
              <span>Talk</span>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
