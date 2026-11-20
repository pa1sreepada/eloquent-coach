import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ExternalLink, Play, RefreshCw } from 'lucide-react';
import { api } from './leadershipApi';

export interface CalEvent {
  uid: string; title: string; start: string; end: string; all_day: boolean;
  attendees: string[]; location: string; agenda: string; join_url: string | null;
}
interface EventsResponse { connected: boolean; events: CalEvent[]; error?: string | null }

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const NUDGE_MS = 2 * 60 * 1000;

/**
 * Today's calendar on the Dashboard. "Use" fills the session form; "Start" begins coaching straight away.
 * Shortly before a meeting begins (and only when nothing is recording) it nudges once per event.
 */
export default function TodayPanel({ isRecording, onUse, onStart, onConnect }: {
  isRecording: boolean;
  onUse: (e: CalEvent) => void;
  onStart: (e: CalEvent) => void;
  onConnect: () => void;
}) {
  const [data, setData] = useState<EventsResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [nudge, setNudge] = useState<CalEvent | null>(null);
  const nudged = useRef(new Set<string>());

  const load = (refresh = false) =>
    api<EventsResponse>(`/calendar/events${refresh ? '?refresh=true' : ''}`).then(setData).catch(() => setData(null));
  useEffect(() => {
    void load();
    const reload = setInterval(() => void load(), 5 * 60 * 1000);
    const tick = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => { clearInterval(reload); clearInterval(tick); };
  }, []);

  useEffect(() => {
    if (isRecording || !data?.events) return;
    const soon = data.events.find(e => {
      if (e.all_day || nudged.current.has(e.uid)) return false;
      const until = new Date(e.start).getTime() - now;
      return until <= NUDGE_MS && until > -NUDGE_MS;
    });
    if (!soon) return;
    nudged.current.add(soon.uid);
    setNudge(soon);
    if ('Notification' in window && Notification.permission !== 'denied') {
      new Notification('Starting soon', { body: `${soon.title} at ${time(soon.start)}. Open Eloquent Coach to start coaching.` });
    }
  }, [now, data, isRecording]);

  if (!data) return null;
  if (!data.connected) {
    return (
      <section className="glass-panel" style={{ padding: '1rem 1.4rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <CalendarDays size={18} color="var(--accent-primary)" />
        <div style={{ flex: 1, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>Connect your calendar to see today's meetings here and start coaching in one click.</div>
        <button className="btn btn-outline" onClick={onConnect}>Connect</button>
      </section>
    );
  }

  const upcoming = data.events.filter(e => e.all_day || new Date(e.end).getTime() > now);
  return (
    <section className="glass-panel" style={{ padding: '1.1rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="eyebrow">Today</div>
        <button className="icon-btn" title="Refresh calendar" onClick={() => void load(true)}><RefreshCw size={14} /></button>
      </div>
      {nudge && !isRecording && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.8rem', borderRadius: '10px', background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.4)' }}>
          <div style={{ flex: 1, fontSize: '0.88rem' }}><strong>{nudge.title}</strong> starts at {time(nudge.start)}.</div>
          <button className="btn btn-primary" onClick={() => { setNudge(null); onStart(nudge); }}><Play size={13} fill="currentColor" /> Coach me</button>
          <button className="btn" onClick={() => setNudge(null)}>Not this one</button>
        </div>
      )}
      {data.error && <div style={{ color: '#fbbf24', fontSize: '0.8rem' }}>Couldn't refresh the calendar: {data.error}</div>}
      {upcoming.length === 0 ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: '0.88rem' }}>No more meetings today.</div>
      ) : upcoming.map(e => {
        const live = !e.all_day && new Date(e.start).getTime() <= now;
        return (
          <div key={e.uid} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.45rem 0', borderTop: '1px solid var(--border-color)' }}>
            <div style={{ width: '4.6rem', fontSize: '0.82rem', color: live ? '#34d399' : 'var(--text-secondary)', flexShrink: 0 }}>
              {e.all_day ? 'All day' : live ? 'Now' : time(e.start)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</div>
              {e.attendees.length > 0 && (
                <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.attendees.slice(0, 5).join(', ')}{e.attendees.length > 5 ? ` +${e.attendees.length - 5}` : ''}
                </div>
              )}
            </div>
            {e.join_url && (
              <a className="icon-btn" href={e.join_url} target="_blank" rel="noreferrer" title="Join (opens in your browser or meeting app)"><ExternalLink size={14} /></a>
            )}
            <button className="btn" onClick={() => onUse(e)} title="Fill the session form with this meeting">Use</button>
            <button className="btn btn-primary" onClick={() => onStart(e)} title="Start coaching for this meeting"><Play size={13} fill="currentColor" /> Start</button>
          </div>
        );
      })}
    </section>
  );
}
