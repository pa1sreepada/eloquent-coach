import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CalendarClock, Handshake, MessageSquareText, Search, ScrollText, User, Zap } from 'lucide-react';
import { api } from './leadershipApi';

interface SearchResult {
  meetings: { id: number; title: string; when: string | null; field: string; snippet: string }[];
  transcripts: { meeting_id: number; title: string; when: string | null; count: number; speaker: string; snippet: string }[];
  commitments: { id: number; owner: string; action: string; status: string; due: string | null; meeting_id: number | null }[];
  people: { id: number; name: string; role: string | null }[];
  scripts: { id: number; title: string; snippet: string }[];
}

export interface PaletteAction { id: string; label: string; hint?: string; icon: ReactNode; keywords?: string; run: () => void }
interface Row { key: string; group: string; label: string; detail?: string; icon: ReactNode; run: () => void }

const when = (w: string | null) => (w ? new Date(w).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');

/** ⌘K: jump anywhere, run an action, or search every meeting, transcript, commitment, person and script. */
export default function CommandPalette({ actions, onClose, onOpenMeeting, onOpenTab }: {
  actions: PaletteAction[];
  onClose: () => void;
  onOpenMeeting: (id: number) => void;
  onOpenTab: (tab: 'leadership' | 'teleprompter') => void;
}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seq = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onQuery = (value: string) => {
    setQ(value); setSel(0);
    clearTimeout(timer.current);
    const n = ++seq.current;
    const term = value.trim();
    if (term.length < 2) { setRes(null); setBusy(false); return; }
    setBusy(true);
    // Debounced; only the latest query's answer is shown.
    timer.current = setTimeout(() => {
      api<SearchResult>(`/search?q=${encodeURIComponent(term)}&limit=6`)
        .then(r => { if (n === seq.current) setRes(r); }).catch(() => { if (n === seq.current) setRes(null); })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 180);
  };

  const rows = useMemo<Row[]>(() => {
    const term = q.trim().toLowerCase();
    const done = (run: () => void) => () => { onClose(); run(); };
    const acts = actions
      .filter(a => !term || `${a.label} ${a.keywords ?? ''}`.toLowerCase().includes(term))
      .map(a => ({ key: `a-${a.id}`, group: 'Actions', label: a.label, detail: a.hint, icon: a.icon, run: done(a.run) }));
    if (!res) return acts;
    return [
      ...acts,
      ...res.meetings.map(m => ({ key: `m-${m.id}`, group: 'Meetings', label: m.title || 'Untitled meeting', detail: `${when(m.when)} · ${m.snippet}`,
        icon: <CalendarClock size={15} />, run: done(() => onOpenMeeting(m.id)) })),
      ...res.transcripts.map(t => ({ key: `t-${t.meeting_id}`, group: 'Said in meetings', label: t.snippet,
        detail: `${t.title || 'Untitled'} · ${when(t.when)} · ${t.speaker}${t.count > 1 ? ` · ${t.count} mentions` : ''}`,
        icon: <MessageSquareText size={15} />, run: done(() => onOpenMeeting(t.meeting_id)) })),
      ...res.commitments.map(c => ({ key: `c-${c.id}`, group: 'Commitments', label: c.action, detail: `${c.owner}${c.due ? ` · due ${c.due}` : ''} · ${c.status}`,
        icon: <Handshake size={15} />, run: done(() => (c.meeting_id ? onOpenMeeting(c.meeting_id) : onOpenTab('leadership'))) })),
      ...res.people.map(p => ({ key: `p-${p.id}`, group: 'People', label: p.name, detail: p.role ?? undefined,
        icon: <User size={15} />, run: done(() => onOpenTab('leadership')) })),
      ...res.scripts.map(s => ({ key: `s-${s.id}`, group: 'Scripts', label: s.title, detail: s.snippet,
        icon: <ScrollText size={15} />, run: done(() => onOpenTab('teleprompter')) })),
    ];
  }, [q, res, actions, onClose, onOpenMeeting, onOpenTab]);

  const active = Math.min(sel, rows.length - 1);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(active + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter' && rows[active]) { e.preventDefault(); rows[active].run(); }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose} style={{ alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div className="sheet palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={e => e.stopPropagation()} onKeyDown={onKey}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.9rem 1rem', borderBottom: '1px solid var(--border-color)' }}>
          <Search size={17} color="var(--text-tertiary)" />
          <input autoFocus value={q} onChange={e => onQuery(e.target.value)} placeholder="Search meetings, what was said, commitments, people… or type a command"
            aria-label="Search" style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '0.98rem' }} />
          {busy && <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>Searching…</span>}
        </div>
        <div ref={listRef} role="listbox" style={{ maxHeight: '56vh', overflowY: 'auto', padding: '0.4rem 0' }}>
          {rows.length === 0 && (
            <div style={{ padding: '1.2rem', color: 'var(--text-tertiary)', fontSize: '0.88rem', textAlign: 'center' }}>
              {q.trim().length < 2 ? 'Type to search.' : busy ? 'Searching…' : 'Nothing matches. Every word must appear; use "quotes" for a phrase.'}
            </div>
          )}
          {rows.map((r, i) => {
            const header = i === 0 || rows[i - 1].group !== r.group ? r.group : null;
            return (
              <div key={r.key}>
                {header && <div className="eyebrow" style={{ padding: '0.55rem 1rem 0.25rem' }}>{header}</div>}
                <div data-i={i} role="option" aria-selected={i === active} className={`palette-row${i === active ? ' active' : ''}`}
                  onMouseMove={() => setSel(i)} onClick={r.run}>
                  <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, display: 'flex' }}>{r.icon}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="palette-label">{r.label}</div>
                    {r.detail && <div className="palette-detail">{r.detail}</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: '1rem', padding: '0.55rem 1rem', borderTop: '1px solid var(--border-color)', fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
          <span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span>
          <span style={{ flex: 1, textAlign: 'right' }}><Zap size={11} /> Searched on this Mac only</span>
        </div>
      </div>
    </div>
  );
}
