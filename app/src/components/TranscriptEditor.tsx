import { useState } from 'react';
import { Pencil, Trash2, CheckSquare, X } from 'lucide-react';

const API = 'http://127.0.0.1:8000';

export interface TranscriptLine { id: number; speaker: string; text: string; timestamp: string }

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function request(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Request failed (HTTP ${res.status}).`);
  return data;
}

/** Transcript with per-line correction (text, speaker) and single or multi-line deletion. */
export default function TranscriptEditor({ meetingId, lines, hasSummary, onChange }: {
  meetingId: number;
  lines: TranscriptLine[];
  hasSummary: boolean;
  onChange: (lines: TranscriptLine[]) => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const remove = async (ids: number[]) => {
    setBusy(true);
    setError(null);
    try {
      await request(`${API}/meetings/${meetingId}/transcripts/delete`, { method: 'POST', body: JSON.stringify({ ids }) });
      const gone = new Set(ids);
      onChange(lines.filter(l => !gone.has(l.id)));
      setChanged(true);
      setConfirmId(null);
      setConfirmBulk(false);
      setSelected(new Set());
      setSelecting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete.');
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: number, text: string, speaker: string) => {
    const updated: TranscriptLine = await request(`${API}/meetings/${meetingId}/transcripts/${id}`, {
      method: 'PATCH', body: JSON.stringify({ text, speaker }),
    });
    onChange(lines.map(l => (l.id === id ? { ...l, ...updated } : l)));
    setChanged(true);
    setEditingId(null);
  };

  const toggle = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const exitSelect = () => { setSelecting(false); setSelected(new Set()); setConfirmBulk(false); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', maxWidth: '760px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
        {selecting ? (
          <>
            <span>{selected.size ? `${selected.size} selected` : 'Select the lines to delete'}</span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-outline" onClick={() => setSelected(new Set(lines.map(l => l.id)))} disabled={busy}>Select all</button>
              {confirmBulk ? (
                <button className="btn btn-danger" onClick={() => remove([...selected])} disabled={busy}>
                  {busy ? 'Deleting…' : `Delete ${selected.size} permanently`}
                </button>
              ) : (
                <button className="btn btn-danger" onClick={() => setConfirmBulk(true)} disabled={!selected.size || busy}>
                  <Trash2 size={14} /> Delete
                </button>
              )}
              <button className="btn btn-outline" onClick={exitSelect} disabled={busy}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <span>Hover a line to correct or delete it.</span>
            <button className="btn btn-outline" onClick={() => { setSelecting(true); setEditingId(null); setConfirmId(null); }}>
              <CheckSquare size={14} /> Select lines
            </button>
          </>
        )}
      </div>

      {changed && hasSummary && (
        <div style={{ fontSize: '0.82rem', padding: '0.6rem 0.8rem', borderRadius: '8px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', color: 'var(--text-secondary)' }}>
          Transcript changed. Regenerate the summary and follow-up email to include your edits.
        </div>
      )}
      {error && <div style={{ fontSize: '0.82rem', color: 'var(--color-risk)' }}>{error}</div>}

      {lines.map(t => {
        const me = t.speaker === 'Me';
        const header = (
          <div style={{ fontSize: '0.75rem', marginBottom: '0.15rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, color: me ? '#60a5fa' : '#34d399' }}>{me ? 'You' : 'Participant'}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>{timeOf(t.timestamp)}</span>
          </div>
        );

        if (editingId === t.id) {
          return <LineEditor key={t.id} line={t} onSave={save} onCancel={() => setEditingId(null)} />;
        }

        return (
          <div key={t.id} className={`tx-line${selected.has(t.id) ? ' selected' : ''}`}
            onClick={selecting ? () => toggle(t.id) : undefined} style={{ cursor: selecting ? 'pointer' : undefined }}>
            {selecting && (
              <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)}
                onClick={e => e.stopPropagation()} aria-label="Select line" style={{ marginTop: '0.2rem' }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              {header}
              <div style={{ fontSize: '0.95rem', color: 'var(--text-primary)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{t.text}</div>
              {confirmId === t.id && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.4rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                  Delete this line permanently?
                  <button className="btn btn-danger" onClick={() => remove([t.id])} disabled={busy} style={{ padding: '0.25rem 0.7rem' }}>
                    {busy ? 'Deleting…' : 'Delete'}
                  </button>
                  <button className="btn btn-outline" onClick={() => setConfirmId(null)} disabled={busy} style={{ padding: '0.25rem 0.7rem' }}>Cancel</button>
                </div>
              )}
            </div>
            {!selecting && confirmId !== t.id && (
              <div className="tx-actions">
                <button className="icon-btn" title="Edit line" aria-label="Edit line"
                  onClick={() => { setEditingId(t.id); setConfirmId(null); setError(null); }}><Pencil size={14} /></button>
                <button className="icon-btn danger" title="Delete line" aria-label="Delete line"
                  onClick={() => { setConfirmId(t.id); setEditingId(null); setError(null); }}><Trash2 size={14} /></button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LineEditor({ line, onSave, onCancel }: {
  line: TranscriptLine;
  onSave: (id: number, text: string, speaker: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(line.text);
  const [speaker, setSpeaker] = useState(line.speaker === 'Me' ? 'Me' : 'Participant');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async () => {
    if (!text.trim()) { setError("Text can't be empty. Use delete to remove the line."); return; }
    if (text.trim() === line.text && speaker === line.speaker) { onCancel(); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(line.id, text, speaker);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setSaving(false);
    }
  };

  return (
    <div className="tx-line editing" style={{ flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.75rem' }}>
        <select className="field" value={speaker} onChange={e => setSpeaker(e.target.value)} disabled={saving}
          aria-label="Speaker" style={{ width: 'auto', padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}>
          <option value="Me">You</option>
          <option value="Participant">Participant</option>
        </select>
        <span style={{ color: 'var(--text-tertiary)' }}>{timeOf(line.timestamp)}</span>
      </div>
      <textarea className="field" autoFocus value={text} disabled={saving} aria-label="Transcript text"
        rows={Math.min(10, Math.max(2, Math.ceil(text.length / 80)))}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }}
        style={{ resize: 'vertical', lineHeight: 1.55, fontSize: '0.95rem' }} />
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
        <button className="btn btn-primary" onClick={commit} disabled={saving} style={{ padding: '0.3rem 0.9rem' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-outline" onClick={onCancel} disabled={saving} style={{ padding: '0.3rem 0.9rem' }}>
          <X size={13} /> Cancel
        </button>
        <span>Enter to save · Shift+Enter for a new line · Esc to cancel</span>
        {error && <span style={{ color: 'var(--color-risk)' }}>{error}</span>}
      </div>
    </div>
  );
}
