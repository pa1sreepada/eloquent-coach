import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Sparkles, X } from 'lucide-react';
import { api, errText } from './leadershipApi';
import { audioConfigured, useHealth } from './health';
import CalendarPanel from './CalendarPanel';

/** Settings section each step jumps to when it can't be finished inside the wizard. */
const SECTION: Record<string, string> = { audio: 'settings-audio', llm: 'settings-llm', voice: 'settings-voice' };

/** First-run checklist. Steps that need a full panel (audio, LLM, voice) link to Settings; name and calendar are done inline. */
export default function SetupWizard({ onClose, onSettings }: { onClose: () => void; onSettings: (section: string) => void }) {
  const { health, refresh } = useHealth(5000);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audio] = useState(audioConfigured);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const saveName = async () => {
    setSaving(true); setError(null);
    try {
      await api('/settings/leader-name', { method: 'PUT', body: { leader_name: name.trim() } });
      await refresh();
    } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  };

  const steps = [
    ...(health?.setup.slice(0, 1) ?? []),
    { id: 'audio', label: 'Pick your microphone and meeting audio', done: audio, hint: 'Headphones plus “Mac system audio” give the cleanest You/Others split.' },
    ...(health?.setup.slice(1) ?? []),
  ];
  const done = steps.filter(s => s.done).length;
  const go = (section: string) => { onClose(); onSettings(section); };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Set up Eloquent Coach" onClick={e => e.stopPropagation()}
        style={{ width: 'min(620px, 92vw)', maxHeight: '86vh', overflowY: 'auto', padding: '1.6rem 1.8rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.4rem' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.2rem' }}><Sparkles size={18} color="var(--accent-primary)" /> Welcome to Eloquent Coach</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p style={{ marginBottom: '1.1rem' }}>
          A few steps so coaching works in your first meeting. Everything stays on this Mac. {health ? `${done} of ${steps.length} done.` : 'Checking…'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          {steps.map(s => (
            <div key={s.id} style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-start', padding: '0.8rem 0.9rem', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
              {s.done ? <CheckCircle2 size={18} color="#34d399" style={{ marginTop: 2, flexShrink: 0 }} />
                : <Circle size={18} color="var(--text-tertiary)" style={{ marginTop: 2, flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '0.92rem' }}>{s.label}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: s.done ? 0 : '0.55rem' }}>{s.hint}</div>
                {!s.done && s.id === 'name' && (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input className="field" value={name} onChange={e => setName(e.target.value)} placeholder="Your name as it appears in meetings"
                      onKeyDown={e => { if (e.key === 'Enter' && name.trim()) void saveName(); }} />
                    <button className="btn btn-primary" disabled={!name.trim() || saving} onClick={() => void saveName()}>Save</button>
                  </div>
                )}
                {!s.done && s.id === 'calendar' && <CalendarPanel compact onChange={() => void refresh()} />}
                {!s.done && SECTION[s.id] && (
                  <button className="btn btn-outline" onClick={() => go(SECTION[s.id])}>Open in Settings</button>
                )}
              </div>
            </div>
          ))}
        </div>
        {error && <div style={{ color: '#ef4444', fontSize: '0.85rem', marginTop: '0.6rem' }}>{error}</div>}

        <div className="actions" style={{ marginTop: '1.2rem', alignItems: 'center' }}>
          <span style={{ flex: 1, fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>Reopen any time from Settings → Setup guide or ⌘K.</span>
          <button className="btn btn-primary" onClick={onClose}>{done === steps.length ? 'Done' : 'Finish later'}</button>
        </div>
      </div>
    </div>
  );
}
