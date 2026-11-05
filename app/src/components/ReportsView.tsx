import { useState, useEffect } from 'react';
import { Clock, FileText, RefreshCw, Cpu, Download, Trash2, Copy, Check, Sparkles, Mail, Pencil } from 'lucide-react';
import { CoachCard } from './coachKinds';
import { useNotesAutosave } from './useNotesAutosave';
import TranscriptEditor from './TranscriptEditor';
import { parseSummary, inline, toHtml, toPlain } from './summaryFormat';

const API = 'http://127.0.0.1:8000';

interface Meeting {
  id: number;
  title: string;
  start_time: string;
  end_time: string | null;
  summary: string | null;
  mode?: string;
}

interface MeetingDetails extends Meeting {
  mode: string;
  agenda?: string;
  lps_score: number | null;
  transcripts: { id: number; speaker: string; text: string; timestamp: string }[];
  insights?: { id: number; kind: string; headline: string; body?: string | null; timestamp: string }[];
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
  transcript_filepath?: string | null;
  notes?: string | null;
  followup_email?: string | null;
}

type Tab = 'summary' | 'notes' | 'coaching' | 'transcript';

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const formatDuration = (start: string, end: string | null) => {
  if (!start || !end) return '—';
  const mins = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

export default function ReportsView({ initialMeetingId }: { initialMeetingId?: number | null }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(initialMeetingId || null);
  const [meetingDetails, setMeetingDetails] = useState<MeetingDetails | null>(null);
  const [tab, setTab] = useState<Tab>('summary');

  const [isLoadingMeetings, setIsLoadingMeetings] = useState(true);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [synthesizingId, setSynthesizingId] = useState<number | null>(null);
  const [synthesisError, setSynthesisError] = useState<{ id: number; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [draftingId, setDraftingId] = useState<number | null>(null);
  const [followupError, setFollowupError] = useState<{ id: number; message: string } | null>(null);
  const notes = useNotesAutosave(meetingDetails?.id ?? null, meetingDetails?.notes ?? '');

  const isSynthesizing = synthesizingId !== null && synthesizingId === selectedMeetingId;
  const busyElsewhere = synthesizingId !== null && synthesizingId !== selectedMeetingId;
  const errorText = synthesisError && synthesisError.id === selectedMeetingId ? synthesisError.message : null;

  useEffect(() => { fetchMeetings(); }, []);

  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !deleting) setConfirmDelete(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDelete, deleting]);

  useEffect(() => {
    if (initialMeetingId) setSelectedMeetingId(initialMeetingId);
  }, [initialMeetingId]);

  useEffect(() => {
    if (selectedMeetingId) {
      fetchMeetingDetails(selectedMeetingId, false);
      setConfirmDelete(false);
      setDeleteError(null);
    } else {
      setMeetingDetails(null);
    }
  }, [selectedMeetingId]);

  const fetchMeetings = async (): Promise<Meeting[]> => {
    try {
      const res = await fetch(`${API}/meetings`);
      const data: Meeting[] = await res.json();
      setMeetings(data);
      if (data.length > 0 && !selectedMeetingId && !initialMeetingId) setSelectedMeetingId(data[0].id);
      return data;
    } catch (err) {
      console.error('Failed to fetch meetings:', err);
      return [];
    } finally {
      setIsLoadingMeetings(false);
    }
  };

  const fetchMeetingDetails = async (id: number, silent = false) => {
    if (!silent) setIsLoadingDetails(true);
    try {
      const res = await fetch(`${API}/meetings/${id}`);
      setMeetingDetails(await res.json());
    } catch (err) {
      console.error('Failed to fetch details:', err);
    } finally {
      if (!silent) setIsLoadingDetails(false);
    }
  };

  const generateSynthesis = async () => {
    if (!selectedMeetingId || synthesizingId !== null) return;
    const id = selectedMeetingId;
    setSynthesizingId(id);
    setSynthesisError(null);
    await notes.flush();
    const fail = (message: string) => setSynthesisError({ id, message });
    try {
      const res = await fetch(`${API}/meetings/${id}/synthesize`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'success') {
        if (typeof data.summary === 'string' && /^(Failed to generate|Error generating|No transcript|Meeting not found)/.test(data.summary)) {
          fail(data.summary);
        } else {
          await fetchMeetingDetails(id, true);
          await fetchMeetings();
        }
      } else {
        fail(data.error || 'Failed to generate the executive summary.');
      }
    } catch (err) {
      console.error('Failed to synthesize:', err);
      fail('Could not reach the backend or your local LLM. Make sure LM Studio or Ollama is running.');
    } finally {
      setSynthesizingId(null);
    }
  };

  const draftFollowup = async () => {
    if (!selectedMeetingId || draftingId !== null || synthesizingId !== null) return;
    const id = selectedMeetingId;
    setDraftingId(id);
    setFollowupError(null);
    try {
      await notes.flush();
      const res = await fetch(`${API}/meetings/${id}/followup`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'success') await fetchMeetingDetails(id, true);
      else setFollowupError({ id, message: data.error || 'Could not draft the email.' });
    } catch {
      setFollowupError({ id, message: 'Could not reach the backend or your local LLM. Make sure LM Studio or Ollama is running.' });
    } finally {
      setDraftingId(null);
    }
  };

  const renameMeeting = async (id: number, title: string) => {
    const res = await fetch(`${API}/meetings/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Could not rename this meeting.');
    setMeetings(ms => ms.map(m => (m.id === id ? { ...m, title: data.title } : m)));
    setMeetingDetails(md => (md && md.id === id ? { ...md, title: data.title } : md));
  };

  const handleExportMarkdown = async () => {
    if (!selectedMeetingId) return;
    try {
      const res = await fetch(`${API}/meetings/${selectedMeetingId}/export`);
      const data = await res.json();
      if (data.export_markdown) {
        const blob = new Blob([data.export_markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const date = new Date(meetingDetails?.start_time || Date.now()).toISOString().slice(0, 10);
        const name = (data.title || `Meeting ${selectedMeetingId}`).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
        a.download = `${name} – ${date}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Failed to export:', err);
    }
  };

  // Rich text (bold headings, real bullets) for Slack and email, with a plain-text fallback.
  // Phrasing pivots are personal coaching, so they stay out of what gets shared.
  const copySummary = async () => {
    const md = meetingDetails;
    if (!md?.summary) return;
    const title = `${md.title || `Session #${md.id}`} · ${new Date(md.start_time).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
    const plain = toPlain(md.summary, title);
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([toHtml(md.summary, title)], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]);
    } catch {
      await navigator.clipboard.writeText(plain);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const deleteMeeting = async () => {
    if (!selectedMeetingId) return;
    const id = selectedMeetingId;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`${API}/meetings/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteError(data.detail || 'Could not delete this meeting.');
        return;
      }
      const idx = meetings.findIndex(m => m.id === id);
      const remaining = meetings.filter(m => m.id !== id);
      setMeetings(remaining);
      setConfirmDelete(false);
      const next = remaining[Math.min(idx, remaining.length - 1)];
      setSelectedMeetingId(next ? next.id : null);
    } catch {
      setDeleteError('Could not reach the backend.');
    } finally {
      setDeleting(false);
    }
  };

  if (isLoadingMeetings) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <RefreshCw className="pulse-animation" size={22} color="var(--text-tertiary)" />
      </div>
    );
  }

  if (meetings.length === 0) {
    return (
      <div className="fade-in" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
        <div style={{ textAlign: 'center' }}>
          <FileText size={40} style={{ marginBottom: '1rem', opacity: 0.4 }} />
          <h2 style={{ color: 'var(--text-secondary)', fontSize: '1.2rem' }}>No meetings yet</h2>
          <p>Your sessions appear here after you end them.</p>
        </div>
      </div>
    );
  }

  // Group the list by day, Apple Notes style.
  const groups: { label: string; items: Meeting[] }[] = [];
  for (const m of meetings) {
    const label = dayLabel(m.start_time);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(m); else groups.push({ label, items: [m] });
  }

  const d = meetingDetails;
  const insights = d?.insights ?? [];
  const metrics = d?.metrics?.[0];

  return (
    <div className="fade-in" style={{ height: '100%', display: 'flex', gap: '1.25rem' }}>

      {/* Meeting list */}
      <aside style={{ width: '260px', flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <h2 style={{ fontSize: '1.15rem', margin: '0.25rem 0.5rem 0.75rem' }}>Meeting History</h2>
        <div style={{ overflowY: 'auto', flex: 1, paddingRight: '0.25rem' }}>
          {groups.map(g => (
            <div key={g.label} style={{ marginBottom: '0.75rem' }}>
              <div className="eyebrow" style={{ fontSize: '0.68rem', padding: '0 0.5rem', marginBottom: '0.3rem' }}>{g.label}</div>
              {g.items.map(m => {
                const on = selectedMeetingId === m.id;
                return (
                  <button key={m.id} onClick={() => setSelectedMeetingId(m.id)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '0.6rem 0.7rem', borderRadius: '8px', border: 'none', cursor: 'pointer',
                      background: on ? 'rgba(59,130,246,0.18)' : 'transparent', marginBottom: '2px', transition: 'background 0.15s ease',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <span style={{ fontWeight: 500, fontSize: '0.9rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.title || `Session #${m.id}`}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', flexShrink: 0 }}>{timeOf(m.start_time)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.6rem', fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.15rem', alignItems: 'center' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}><Clock size={11} /> {formatDuration(m.start_time, m.end_time)}</span>
                      {m.mode && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.mode}</span>}
                      {m.summary && <span title="Summary generated" style={{ marginLeft: 'auto', color: '#a78bfa', display: 'flex' }}><Sparkles size={11} /></span>}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      {/* Detail */}
      <main className="glass-panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selectedMeetingId ? (
          <div style={{ margin: 'auto', color: 'var(--text-tertiary)' }}>Select a meeting</div>
        ) : isLoadingDetails || !d ? (
          <div style={{ margin: 'auto' }}><RefreshCw className="pulse-animation" size={22} color="var(--text-tertiary)" /></div>
        ) : (
          <>
            {/* Header */}
            <header style={{ padding: '1.4rem 1.6rem 1rem', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div style={{ minWidth: 0 }}>
                  <EditableTitle key={d.id} value={d.title || `Session #${d.id}`} onSave={t => renameMeeting(d.id, t)} />
                  <div style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
                    {new Date(d.start_time).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {' · '}{formatDuration(d.start_time, d.end_time)}{' · '}{d.mode}
                  </div>
                  {d.agenda && <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginTop: '0.4rem' }}>Goal: {d.agenda}</div>}
                </div>
                <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                  <button className="icon-btn" onClick={handleExportMarkdown} title="Export as Markdown (summary, live coaching, transcript)">
                    <Download size={17} />
                  </button>
                  <button className="icon-btn danger" onClick={() => setConfirmDelete(true)} title="Delete meeting" disabled={isSynthesizing}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>

              {metrics && (
                <div style={{ display: 'flex', gap: '1.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                  {d.lps_score != null && <Kpi label="Leadership score" value={`${d.lps_score}/10`} />}
                  <Kpi label="Questions" value={`${Math.round((metrics.question_ratio || 0) * 100)}%`} />
                  <Kpi label="Future focus" value={`${Math.round(metrics.future_focus_pct || 0)}%`} />
                  <Kpi label="Avg. pause" value={`${(metrics.wait_time_avg || 0).toFixed(1)}s`} />
                  <Kpi label="Interruptions" value={String(metrics.interruptions ?? 0)} />
                </div>
              )}

              <div className="segmented" style={{ marginTop: '1.1rem' }}>
                <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>Summary</button>
                <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>My Notes</button>
                <button className={tab === 'coaching' ? 'on' : ''} onClick={() => setTab('coaching')}>Live Coaching{insights.length ? ` · ${insights.length}` : ''}</button>
                <button className={tab === 'transcript' ? 'on' : ''} onClick={() => setTab('transcript')}>Transcript</button>
              </div>
            </header>

            {/* Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '1.4rem 1.6rem 2rem' }}>
              {tab === 'summary' && (
                <SummaryTab
                  d={d} isSynthesizing={isSynthesizing} busyElsewhere={busyElsewhere} errorText={errorText}
                  onGenerate={generateSynthesis} onCopy={copySummary} copied={copied}
                />
              )}

              {tab === 'summary' && (
                <FollowupEmail email={d.followup_email ?? null} drafting={draftingId === d.id}
                  busy={draftingId !== null || synthesizingId !== null}
                  error={followupError && followupError.id === d.id ? followupError.message : null}
                  onDraft={draftFollowup} />
              )}

              {tab === 'notes' && (
                <div style={{ maxWidth: '760px', height: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                    <span>Weighted most heavily when the summary and follow-up email are generated.</span>
                    <span>{notes.status}</span>
                  </div>
                  <textarea className="field" value={notes.value} onChange={e => notes.setValue(e.target.value)}
                    placeholder="Decisions, names, numbers, follow-ups…"
                    style={{ flex: 1, minHeight: '320px', resize: 'none', lineHeight: 1.6, fontSize: '0.95rem' }} />
                </div>
              )}

              {tab === 'coaching' && (
                insights.length === 0 ? (
                  <Empty text="No live coaching cards were generated in this meeting." />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: '760px' }}>
                    {insights.map(i => (
                      <CoachCard key={i.id} kind={i.kind} headline={i.headline} body={i.body} time={timeOf(i.timestamp)} />
                    ))}
                  </div>
                )
              )}

              {tab === 'transcript' && (
                d.transcripts.length === 0 ? (
                  <Empty text="No transcript for this meeting." />
                ) : (
                  <TranscriptEditor key={d.id} meetingId={d.id} lines={d.transcripts}
                    hasSummary={!!(d.summary || d.followup_email)}
                    onChange={lines => setMeetingDetails(md => (md && md.id === d.id ? { ...md, transcripts: lines } : md))} />
                )
              )}
            </div>
          </>
        )}
      </main>

      {confirmDelete && d && (
        <div className="sheet-backdrop" onClick={() => !deleting && setConfirmDelete(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3>Delete “{d.title || `Session #${d.id}`}”?</h3>
            <p>The transcript, your notes, live coaching cards, summary, follow-up email and metrics will be permanently deleted from this Mac. This can’t be undone.</p>
            {deleteError && <p style={{ color: 'var(--color-risk)', marginTop: '-0.75rem' }}>{deleteError}</p>}
            <div className="actions">
              <button className="btn btn-outline" onClick={() => setConfirmDelete(false)} disabled={deleting} autoFocus>Cancel</button>
              <button className="btn btn-danger" onClick={deleteMeeting} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ color: 'var(--text-tertiary)', padding: '3rem 0', textAlign: 'center', fontSize: '0.9rem' }}>{text}</div>;
}

function SummaryTab({ d, isSynthesizing, busyElsewhere, errorText, onGenerate, onCopy, copied }: {
  d: MeetingDetails; isSynthesizing: boolean; busyElsewhere: boolean; errorText: string | null;
  onGenerate: () => void; onCopy: () => void; copied: boolean;
}) {
  const busy = isSynthesizing || busyElsewhere;
  const isFireside = d.mode?.includes('Fireside') || d.mode?.includes('Guest');
  const reroutes = (d.strategic_alternatives || '').split('\n').filter(l => l.includes('|')).map(line => {
    const strip = (s = '') => (s.includes(':') ? s.substring(s.indexOf(':') + 1) : s).trim().replace(/^["']|["']$/g, '');
    const [o, a, r] = line.split('|');
    return { origin: strip(o), alternative: strip(a), rationale: strip(r) };
  });

  return (
    <div style={{ maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {isSynthesizing && (
        <div style={{ padding: '0.9rem 1rem', borderRadius: '10px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <RefreshCw className="pulse-animation" size={18} color="#60a5fa" />
          <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
            Writing the summary with your local LLM. Long meetings can take a few minutes; you can keep using the app.
          </div>
        </div>
      )}

      {errorText && (
        <div style={{ padding: '0.9rem 1rem', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
          <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--color-risk)' }}>Couldn’t generate the summary</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{errorText}</div>
        </div>
      )}

      {d.summary ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.25rem', marginBottom: '-0.5rem' }}>
            <button className="btn btn-outline" onClick={onCopy} title="Copy with headings and bullets, ready to paste into Slack or email" style={{ padding: '0.3rem 0.8rem', fontSize: '0.82rem' }}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy for Slack / email'}
            </button>
            <button className="icon-btn" onClick={onGenerate} disabled={busy} title={busyElsewhere ? 'Another summary is being generated' : 'Regenerate'}>
              <RefreshCw size={16} className={isSynthesizing ? 'pulse-animation' : undefined} />
            </button>
          </div>
          <FormattedSummary text={d.summary} />
        </>
      ) : !isSynthesizing && (
        <div style={{ padding: '3rem 1.5rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.9rem' }}>
          <Cpu size={30} style={{ opacity: 0.4 }} />
          <div>
            <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '0.25rem' }}>No summary yet</div>
            <div style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', maxWidth: '420px' }}>
              Decisions, action items, open questions and phrasing pivots, written by your local LLM on demand.
            </div>
          </div>
          <button className="btn btn-primary" onClick={onGenerate} disabled={busy} title={busyElsewhere ? 'Another summary is being generated' : undefined}>
            <Sparkles size={15} /> Generate Executive Summary
          </button>
        </div>
      )}

      {reroutes.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <div className="eyebrow" style={{ marginBottom: '0.6rem' }}>{isFireside ? 'Sharper questions to ask next time' : 'Phrasing pivots'}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {reroutes.map((r, i) => (
              <div key={i} style={{ padding: '0.9rem 1rem', borderRadius: '10px', background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: '0.88rem', color: 'var(--text-tertiary)', textDecoration: 'line-through', textDecorationColor: 'rgba(239,68,68,0.5)' }}>“{r.origin}”</div>
                <div style={{ fontSize: '0.98rem', color: 'var(--text-primary)', fontWeight: 600, margin: '0.3rem 0' }}>{r.alternative}</div>
                {r.rationale && <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{r.rationale}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  return <>{inline(text).map((g, i) => (g.bold ? <strong key={i}>{g.text}</strong> : <span key={i}>{g.text}</span>))}</>;
}

function FormattedSummary({ text }: { text: string }) {
  return (
    <div className="summary-doc">
      {parseSummary(text).map((b, i) =>
        b.kind === 'heading' ? <h3 key={i}>{b.text}</h3>
          : b.kind === 'para' ? <p key={i}><Inline text={b.text} /></p>
            : <ul key={i}>{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ul>)}
    </div>
  );
}

function FollowupEmail({ email, drafting, busy, error, onDraft }: {
  email: string | null; drafting: boolean; busy: boolean; error: string | null; onDraft: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const subject = email?.match(/^Subject:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const body = email ? email.replace(/^Subject:.*\n+/, '') : '';
  const copy = () => {
    if (!email) return;
    navigator.clipboard.writeText(email);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const openInMail = () => {
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <div style={{ maxWidth: '760px', marginTop: '2rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
        <div className="eyebrow">Follow-up email</div>
        {email && (
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <button className="icon-btn" onClick={copy} title="Copy email">{copied ? <Check size={16} /> : <Copy size={16} />}</button>
            <button className="icon-btn" onClick={openInMail} title="Open in Mail"><Mail size={16} /></button>
            <button className="icon-btn" onClick={onDraft} disabled={busy} title="Redraft">
              <RefreshCw size={16} className={drafting ? 'pulse-animation' : undefined} />
            </button>
          </div>
        )}
      </div>
      {error && <div style={{ fontSize: '0.85rem', color: 'var(--color-risk)', marginBottom: '0.6rem' }}>{error}</div>}
      {email ? (
        <div style={{ padding: '1rem 1.1rem', borderRadius: '10px', background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border-color)' }}>
          {subject && <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.6rem' }}>{subject}</div>}
          <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', fontSize: '0.92rem', lineHeight: 1.6 }}>{body}</div>
        </div>
      ) : (
        <button className="btn btn-outline" onClick={onDraft} disabled={busy}>
          {drafting ? <RefreshCw size={14} className="pulse-animation" /> : <Mail size={14} />}
          {drafting ? 'Drafting…' : 'Draft follow-up email'}
        </button>
      )}
    </div>
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = () => { setDraft(value); setError(null); setEditing(true); };
  const commit = async () => {
    const t = draft.replace(/\s+/g, ' ').trim();
    if (!t || t === value) { setEditing(false); setError(null); return; }
    setSaving(true);
    try {
      await onSave(t);
      setEditing(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename this meeting.');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div style={{ marginBottom: '0.3rem' }}>
        <input className="field" autoFocus value={draft} maxLength={120} disabled={saving}
          aria-label="Meeting title"
          onChange={e => setDraft(e.target.value)}
          onFocus={e => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); setError(null); }
          }}
          style={{ fontSize: '1.35rem', fontWeight: 600, padding: '0.2rem 0.5rem', width: 'min(560px, 100%)' }} />
        {error && <div style={{ fontSize: '0.8rem', color: 'var(--color-risk)', marginTop: '0.3rem' }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="editable-title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
      <h1 onClick={begin} title="Click to rename" style={{ fontSize: '1.5rem', margin: 0, cursor: 'text' }}>{value}</h1>
      <button className="icon-btn" onClick={begin} title="Rename meeting" aria-label="Rename meeting"><Pencil size={14} /></button>
    </div>
  );
}
