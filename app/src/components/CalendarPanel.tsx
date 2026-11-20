import { useEffect, useState } from 'react';
import { CalendarDays, Link2, Unlink } from 'lucide-react';
import { api, errText } from './leadershipApi';

interface CalStatus { connected: boolean; synced_at: string | null; error: string | null }

const HOWTO: [string, string][] = [
  ['Outlook', 'Outlook on the web → Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link.'],
  ['Google', 'Google Calendar → Settings → your calendar → Integrate calendar → copy “Secret address in iCal format”.'],
  ['iCloud', 'Calendar app → right-click the calendar → Share Calendar → Public Calendar → copy the webcal:// link.'],
];

/** Connects a published ICS feed. The address is kept in the OS credential store and never shown again. */
export default function CalendarPanel({ compact = false, onChange }: { compact?: boolean; onChange?: (connected: boolean) => void }) {
  const [status, setStatus] = useState<CalStatus | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<CalStatus>('/calendar/status').then(setStatus).catch(() => {}); }, []);

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const s = await api<CalStatus>('/calendar/source', { method: 'PUT', body: { url } });
      setStatus(s); setUrl(''); onChange?.(s.connected);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    const s = await api<CalStatus>('/calendar/source', { method: 'DELETE' }).catch(() => null);
    if (s) { setStatus(s); onChange?.(false); }
  };

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
      {status?.connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ color: '#34d399', fontSize: '0.9rem' }}>● Connected</span>
          {status.synced_at && <span style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>Last synced {new Date(status.synced_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          {status.error && <span style={{ color: '#fbbf24', fontSize: '0.8rem' }}>{status.error}</span>}
          <button className="btn btn-outline" onClick={() => void disconnect()}><Unlink size={14} /> Disconnect</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input className="field" type="password" autoComplete="off" spellCheck={false} value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://… or webcal://… (your calendar's secret ICS address)" style={{ flex: 1 }}
              onKeyDown={e => { if (e.key === 'Enter' && url.trim()) void connect(); }} />
            <button className="btn btn-primary" disabled={!url.trim() || busy} onClick={() => void connect()}>
              <Link2 size={14} /> {busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
          {error && <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>{error}</div>}
          <details style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            <summary style={{ cursor: 'pointer' }}>Where do I find it?</summary>
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {HOWTO.map(([k, v]) => <li key={k}><strong>{k}:</strong> {v}</li>)}
            </ul>
          </details>
        </>
      )}
      <small style={{ color: 'var(--text-tertiary)' }}>
        Read-only. The address is stored in your Mac's Keychain; events are read when you open the app and never saved.
        If your company blocks publishing calendars, you can still type meetings in by hand.
      </small>
    </div>
  );
  if (compact) return body;
  return (
    <div id="settings-calendar" className="glass-panel" style={{ padding: '2rem' }}>
      <h2 style={{ fontSize: '1.2rem', marginBottom: '1.2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <CalendarDays size={20} color="var(--accent-primary)" /> Calendar
      </h2>
      {body}
    </div>
  );
}
