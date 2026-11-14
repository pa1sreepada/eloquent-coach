import { useState, useEffect, useRef, useCallback } from 'react';
import { Square, Mic, MicOff, Copy, Check, MonitorUp, ArrowDown, Sparkles, X } from 'lucide-react';
import { useNotesAutosave } from './useNotesAutosave';
import { CoachCard } from './coachKinds';
import { useDualChannelCapture } from '../hud/useDualChannelCapture';
import { useCoachEvents } from '../hud/useCoachEvents';
import { applyTranscript, type Line } from '../hud/transcriptStore';
import type { CoachEvent, AsrStatusEvent } from '../hud/protocol';

const API = 'http://127.0.0.1:8000';

interface Insight {
  id: string;
  category: string;
  headline: string;
  body?: string;
  time: string;
  asked?: boolean;    // answer to "What do I say?"
  pending?: boolean;  // headline streamed, body still being written
}

const EMPTY_METRICS = { talkTime: 0, pacing: 0, fillerCount: 0, sharePct: 0 };

export default function LiveMeetingView({ isRecording, mode, agenda = '', prepNotes = '', title = '', attendees = '', onStopMeeting }: { isRecording: boolean, mode: string, agenda?: string, prepNotes?: string, title?: string, attendees?: string, onStopMeeting: (meetingId?: number | null) => void }) {
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
  const [asking, setAsking] = useState<'pending' | 'empty' | 'error' | null>(null);
  const [answerId, setAnswerId] = useState<string | null>(null);   // latest "What do I say?" answer, pinned on top
  const [llmError, setLlmError] = useState<string | null>(null);
  const [pane, setPane] = useState<'coaching' | 'notes'>('coaching');
  const notes = useNotesAutosave(meetingId);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const isInitializingRef = useRef(false);
  const { start, stop } = useDualChannelCapture(isMuted);

  // Scroll only the transcript pane (scrollIntoView also scrolled the page, pushing the header away),
  // and only while the user is at the bottom so they can scroll back to read.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [transcripts, following]);
  const onTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  // Lets the main process enable the global ⌘⇧↩ "what do I say now?" hotkey while live.
  useEffect(() => {
    window.eloquent?.setLiveMeeting(meetingId);
    return () => window.eloquent?.setLiveMeeting(null);
  }, [meetingId]);

  const askNow = () => {
    if (!meetingId || asking === 'pending') return;
    setAsking('pending');
    setAnswerId(null);
    fetch(`${API}/meetings/${meetingId}/ask`, { method: 'POST' })
      .then(res => { if (!res.ok) setAsking(null); })
      .catch(() => setAsking(null));
  };

  const onCoachEvent = useCallback((e: CoachEvent) => {
    if (e.type === 'ask') {
      setAsking(e.state === 'done' ? null : e.state);
      if (e.state === 'error' && e.message) setLlmError(e.message);
      if (e.state === 'empty' || e.state === 'error') {
        setTimeout(() => setAsking(a => (a === e.state ? null : a)), e.state === 'error' ? 6000 : 3000);
      }
    } else if (e.type === 'llm_status') {
      setLlmError(e.ok ? null : e.message);
    } else if (e.type === 'transcript') {
      setTranscripts(prev => applyTranscript(prev, e));
    } else if (e.type === 'card') {
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const asked = e.trigger === 'ask';
      setInsights(prev => [{ id: e.id, category: e.kind, headline: e.headline, body: e.body || undefined, time, asked, pending: !!e.partial },
        ...prev.filter(i => i.id !== e.id)].slice(0, 50));
      if (asked) setAnswerId(e.id);
    } else if (e.type === 'card_update') {
      setInsights(prev => prev.map(i => (i.id === e.id ? { ...i, body: e.body || undefined, pending: false } : i)));
    } else if (e.type === 'telemetry') {
      setMetrics({ talkTime: e.my_voiced_s / 60, pacing: e.my_wpm, fillerCount: e.fillers_total, sharePct: e.talk_share_pct });
      setAlerts(e.alerts);
    } else if (e.type === 'asr_status') {
      setAsr(e);
    }
  }, []);
  useCoachEvents(meetingId, onCoachEvent);
  const answer = answerId ? insights.find(i => i.id === answerId) ?? null : null;

  const resetState = () => {
    setMeetingId(null);
    setTranscripts([]);
    setInsights([]);
    setMetrics(EMPTY_METRICS);
    setAlerts([]);
    setAsr(null);
    setConnectionStatus('connecting');
    setIsHudMode(false);
    setAsking(null);
    setLlmError(null);
    setPane('coaching');
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
    void notes.flush();
    stop();
    window.eloquent?.hideHud();
    if (id) fetch(`${API}/meetings/${id}/end`, { method: 'POST' }).catch(() => {});
  };

  useEffect(() => {
    if (isRecording && !meetingId && !isInitializingRef.current) {
      isInitializingRef.current = true;
      fetch(`${API}/meetings/?mode=${encodeURIComponent(mode)}&agenda=${encodeURIComponent(agenda)}&prep_notes=${encodeURIComponent(prepNotes)}&title=${encodeURIComponent(title)}&attendees=${encodeURIComponent(attendees)}`, { method: 'POST' })
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

  const chip = (bg: string, color: string): React.CSSProperties => ({
    fontSize: '0.75rem', fontWeight: 500, padding: '3px 10px', borderRadius: '999px', background: bg, color, whiteSpace: 'nowrap',
  });
  const live = connectionStatus === 'connected';

  return (
    <div className="fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '1rem', overflow: 'hidden' }}>

      {/* Toolbar — fixed; only the panes below scroll */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flexWrap: 'wrap' }}>
          <div className="status-dot recording" />
          <h1 style={{ margin: 0, fontSize: '1.35rem' }}>Live Session</h1>
          <span style={chip(live ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)', live ? '#10b981' : '#f59e0b')}>
            {live ? 'Listening' : connectionStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
          <span style={chip('rgba(255,255,255,0.06)', 'var(--text-secondary)')}>{mode}</span>
          {asrLabel && (
            <span title="Adaptive speech recognition plan" style={chip('rgba(255,255,255,0.04)', asr?.pressure ? '#f59e0b' : 'var(--text-tertiary)')}>
              {asrLabel}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
          <button className="btn btn-outline" onClick={askNow} disabled={!meetingId || !live || asking === 'pending'}
            title="One suggestion for what to say right now. Works from any app with ⌘⇧↩."
            style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem', borderColor: 'rgba(246,210,122,0.45)', color: '#f6d27a' }}>
            <Sparkles size={14} className={asking === 'pending' ? 'pulse-animation' : undefined} />
            {asking === 'pending' ? 'Thinking…' : 'What do I say?'}
          </button>
          <div className="segmented">
            <button className={isHudMode ? 'on' : ''} onClick={toggleHudMode} disabled={!meetingId || !window.eloquent}
              title="Show the transparent overlay under the camera (⌘⇧H)">
              <MonitorUp size={14} /> HUD
            </button>
            <button className={isMuted ? 'on' : ''} onClick={() => setIsMuted(!isMuted)} title={isMuted ? 'Unmute microphone' : 'Mute microphone'}>
              {isMuted ? <MicOff size={14} /> : <Mic size={14} />} {isMuted ? 'Muted' : 'Mic'}
            </button>
          </div>
          <button className="btn btn-danger" onClick={handleStop} style={{ padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}>
            <Square size={12} fill="currentColor" /> End Session
          </button>
        </div>
      </header>

      {(captureError || llmError || alerts.length > 0 || agenda || prepNotes || asking === 'empty') && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
          {captureError && (
            <span style={chip('rgba(239,68,68,0.12)', 'var(--color-risk)')}>
              Audio capture failed: {captureError}. Check microphone permission and devices in Settings.
            </span>
          )}
          {llmError && (
            <span title={llmError} style={chip('rgba(239,68,68,0.12)', 'var(--color-risk)')}>
              Coaching unavailable: {llmError} Check the LLM in Settings.
            </span>
          )}
          {asking === 'empty' && <span style={chip('rgba(255,255,255,0.06)', 'var(--text-secondary)')}>Nothing new to add right now</span>}
          {alerts.map(a => <span key={a} style={chip('rgba(245,158,11,0.14)', '#f59e0b')}>{a}</span>)}
          {agenda && (
            <span title={agenda} style={{ ...chip('rgba(59,130,246,0.1)', '#93c5fd'), maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Agenda · {agenda}
            </span>
          )}
          {prepNotes && <span title={prepNotes} style={chip('rgba(16,185,129,0.1)', '#6ee7b7')}>Prep notes loaded</span>}
        </div>
      )}

      {answer && (
        <div className="slide-up" style={{ flexShrink: 0, padding: '0.85rem 1.1rem', borderRadius: '12px', display: 'flex', gap: '0.9rem', alignItems: 'flex-start',
          background: 'rgba(246,210,122,0.08)', border: '1px solid rgba(246,210,122,0.45)' }}>
          <Sparkles size={18} color="#f6d27a" style={{ marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em', color: '#f6d27a', textTransform: 'uppercase' }}>
              Say this now · {answer.time}
            </div>
            <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4, marginTop: '0.2rem' }}>{answer.headline}</div>
            {answer.body ? <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{answer.body}</div>
              : answer.pending && <div className="pulse-animation" style={{ color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>•••</div>}
          </div>
          <button className="icon-btn" style={{ width: 26, height: 26, color: copiedId === answer.id ? '#10b981' : undefined }} title="Copy"
            onClick={() => handleCopyText(answer.id, answer.body ? `${answer.headline}\n${answer.body}` : answer.headline)}>
            {copiedId === answer.id ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button className="icon-btn" style={{ width: 26, height: 26 }} title="Dismiss" onClick={() => setAnswerId(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: '1rem', flex: 1, minHeight: 0 }}>
        {/* Transcript */}
        <section className="glass-panel" style={{ flex: 1.15, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, position: 'relative' }}>
          <div className="eyebrow" style={{ padding: '0.9rem 1.25rem', borderBottom: '1px solid var(--border-color)' }}>Transcript</div>
          <div ref={transcriptRef} onScroll={onTranscriptScroll}
            style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {transcripts.length === 0 ? (
              <div style={{ margin: 'auto', color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>Listening…</div>
            ) : (
              transcripts.map((t) => (
                <div key={t.id} style={{ opacity: t.final ? 1 : 0.55 }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.15rem', color: t.speaker === 'Me' ? '#60a5fa' : '#34d399' }}>
                    {t.speaker === 'Me' ? 'You' : 'Participant'}
                  </div>
                  <div style={{ color: 'var(--text-primary)', fontSize: '0.98rem', lineHeight: 1.5 }}>{t.text}</div>
                </div>
              ))
            )}
          </div>
          {!following && (
            <button className="btn btn-outline" onClick={() => setFollowing(true)}
              style={{ position: 'absolute', bottom: '1rem', left: '50%', transform: 'translateX(-50%)', padding: '0.3rem 0.8rem', fontSize: '0.8rem', background: '#161c2b' }}>
              <ArrowDown size={13} /> Jump to live
            </button>
          )}
        </section>

        {/* Coaching + metrics */}
        <section style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: 0, minWidth: 0 }}>
          <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="segmented">
                <button className={pane === 'coaching' ? 'on' : ''} onClick={() => setPane('coaching')}>
                  Questions & Pivots{insights.length > 0 ? ` · ${insights.length}` : ''}
                </button>
                <button className={pane === 'notes' ? 'on' : ''} onClick={() => setPane('notes')}>My Notes</button>
              </div>
              {pane === 'notes' && <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>{notes.status}</span>}
            </div>
            {pane === 'notes' ? (
              <textarea value={notes.value} onChange={e => notes.setValue(e.target.value)} autoFocus
                placeholder={'Jot anything: decisions, names, numbers, follow-ups.\nYour notes steer live coaching and are weighted most heavily in the executive summary.'}
                style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)',
                  padding: '1rem 1.25rem', fontSize: '0.95rem', lineHeight: 1.6, fontFamily: 'inherit' }} />
            ) : (
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {insights.length === 0 ? (
                <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.9rem', maxWidth: '260px' }}>
                  Suggestions appear here as the conversation develops. Newest first.
                </div>
              ) : (
                insights.map((insight) => (
                  <CoachCard key={insight.id} kind={insight.category} headline={insight.headline} body={insight.body}
                    time={insight.asked ? `You asked · ${insight.time}` : insight.time}
                    action={
                      <button className="icon-btn" style={{ width: 26, height: 26, color: copiedId === insight.id ? '#10b981' : undefined }}
                        onClick={() => handleCopyText(insight.id, insight.body ? `${insight.headline}\n${insight.body}` : insight.headline)}
                        title="Copy">
                        {copiedId === insight.id ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    } />
                ))
              )}
            </div>
            )}
          </div>

          {/* Metrics strip */}
          <div className="glass-panel" style={{ padding: '0.9rem 1.25rem', flexShrink: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
              <Metric label="Talk time" value={`${metrics.talkTime.toFixed(1)}m`} />
              <Metric label="Fillers" value={String(metrics.fillerCount)} warn={metrics.fillerCount > 5} />
              <Metric label="Pace" value={`${metrics.pacing.toFixed(0)}`} unit="wpm" />
            </div>
            <div style={{ marginTop: '0.75rem', height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, metrics.sharePct)}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent-primary), var(--color-praise))', transition: 'width 1s ease' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.35rem', fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
              <span>Listening</span><span>You {metrics.sharePct.toFixed(0)}%</span><span>Talking</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value, unit, warn }: { label: string; value: string; unit?: string; warn?: boolean }) {
  return (
    <div>
      <div className="eyebrow" style={{ fontSize: '0.66rem' }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 600, color: warn ? 'var(--color-risk)' : 'var(--text-primary)' }}>
        {value}{unit && <span style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 3 }}>{unit}</span>}
      </div>
    </div>
  );
}
