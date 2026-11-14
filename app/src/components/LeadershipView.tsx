import { useCallback, useEffect, useState } from 'react';
import { Check, Plus, RefreshCw, Trash2, X, Sparkles } from 'lucide-react';
import { api, errText, type Commitment } from './leadershipApi';
import { CopyButton, ErrorLine, MiniMarkdown, Muted, Panel, Tabs } from './leadershipUi';

type Tab = 'commitments' | 'team' | 'digest' | 'narrative';

export default function LeadershipView() {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('leadershipTab') as Tab) || 'commitments');
  useEffect(() => { localStorage.setItem('leadershipTab', tab); }, [tab]);
  return (
    <div className="fade-in" style={{ maxWidth: '960px', margin: '0 auto', padding: '1.5rem 0 2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <header>
        <h1 style={{ fontSize: '1.7rem', marginBottom: '0.25rem' }}>Leadership</h1>
        <p style={{ margin: 0 }}>What you owe, what others owe you, how your team is doing, and the story you're telling.</p>
      </header>
      <Tabs value={tab} onChange={setTab} options={[['commitments', 'Commitments'], ['team', 'Team radar'], ['digest', 'Weekly digest'], ['narrative', 'Narrative check']]} />
      {tab === 'commitments' && <CommitmentLedger />}
      {tab === 'team' && <TeamRadar />}
      {tab === 'digest' && <DocTool kind="digest" />}
      {tab === 'narrative' && <DocTool kind="narrative" />}
    </div>
  );
}

// ---------------------------------------------------------------- commitments
function CommitmentLedger() {
  const [rows, setRows] = useState<Commitment[]>([]);
  const [filter, setFilter] = useState<'mine' | 'others' | 'all' | 'done'>('mine');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ action: '', owner: 'Me', due_text: '' });

  const load = useCallback(() => {
    const status = filter === 'done' ? 'done' : 'open';
    const mine = filter === 'mine' ? '&mine=true' : filter === 'others' ? '&mine=false' : '';
    return api<Commitment[]>(`/commitments?status=${status}${mine}`)
      .then(r => { setRows(r); setError(null); }).catch(e => setError(errText(e)));
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  const sync = async () => {
    try { const r = await api<{ added: number }>('/commitments/sync', { body: {} }); await load(); setError(r.added ? null : 'No new action items found in your meetings.'); }
    catch (e) { setError(errText(e)); }
  };
  const patch = async (id: number, body: Record<string, unknown>) => {
    try { await api(`/commitments/${id}`, { method: 'PATCH', body }); await load(); } catch (e) { setError(errText(e)); }
  };
  const add = async () => {
    if (!draft.action.trim()) return;
    try { await api('/commitments', { body: { ...draft, due_text: draft.due_text || null } }); setDraft({ action: '', owner: 'Me', due_text: '' }); await load(); }
    catch (e) { setError(errText(e)); }
  };
  const remove = async (id: number) => { await api(`/commitments/${id}`, { method: 'DELETE' }).catch(() => {}); await load(); };

  return (
    <Panel title="Commitment ledger" action={
      <button className="btn" onClick={sync} title="Pull action items from meeting summaries and the live tracker"><RefreshCw size={14} /> Sync from meetings</button>}>
      <Tabs value={filter} onChange={setFilter} options={[['mine', 'I owe'], ['others', 'Owed to me'], ['all', 'All open'], ['done', 'Done']]} />
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <input className="field" style={{ flex: '3 1 260px' }} placeholder="New commitment, e.g. Send pricing proposal to Sarah"
          value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
        <input className="field" style={{ flex: '1 1 110px' }} placeholder="Owner" value={draft.owner} onChange={e => setDraft({ ...draft, owner: e.target.value })} />
        <input className="field" style={{ flex: '1 1 110px' }} placeholder="Due (Fri, Nov 20…)" value={draft.due_text} onChange={e => setDraft({ ...draft, due_text: e.target.value })} />
        <button className="btn btn-primary" onClick={add}><Plus size={14} /> Add</button>
      </div>
      <ErrorLine error={error} />
      {rows.length === 0 ? <Muted>{filter === 'done' ? 'Nothing completed yet.' : 'Nothing open. Sync to pull action items from your meeting summaries.'}</Muted> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {rows.map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.55rem 0.7rem', borderRadius: '8px',
              background: c.overdue ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)' }}>
              {c.status === 'open'
                ? <button className="icon-btn" title="Mark done" onClick={() => patch(c.id, { status: 'done' })}><Check size={15} /></button>
                : <button className="icon-btn" title="Reopen" onClick={() => patch(c.id, { status: 'open' })}><RefreshCw size={14} /></button>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.9rem', textDecoration: c.status === 'done' ? 'line-through' : undefined }}>{c.action}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                  <strong style={{ color: c.is_mine ? '#93c5fd' : c.owner === 'Unassigned' ? '#f59e0b' : 'var(--text-secondary)' }}>{c.owner}</strong>
                  {c.meeting_title && ` · ${c.meeting_title}`}
                </div>
              </div>
              <input className="field" defaultValue={c.due_date ?? c.due_text ?? ''} placeholder="Due" title="Type a date or 'Friday', 'next week'…"
                style={{ width: '120px', padding: '0.3rem 0.5rem', fontSize: '0.8rem', color: c.overdue ? '#f87171' : undefined }}
                onBlur={e => { if (e.target.value !== (c.due_date ?? c.due_text ?? '')) void patch(c.id, { due_text: e.target.value }); }} />
              {c.overdue && <span style={{ fontSize: '0.72rem', color: '#f87171', whiteSpace: 'nowrap' }}>{c.days_overdue}d late</span>}
              {c.status === 'open' && <button className="icon-btn" title="Drop (no longer needed)" onClick={() => patch(c.id, { status: 'dropped' })}><X size={15} /></button>}
              <button className="icon-btn danger" title="Delete" onClick={() => remove(c.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- team radar
interface RadarPerson {
  person: string; meetings: number; one_on_ones: number; last_met: string; days_since: number;
  sentiment: { date: string; value: number }[]; share: number[]; concerns: string[]; flags: string[];
}

function TeamRadar() {
  const [data, setData] = useState<{ people: RadarPerson[]; rising_concerns: { term: string; recent: number; before: number }[]; coverage: { meetings: number; with_attendees: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<typeof data>('/team/radar').then(setData).catch(e => setError(errText(e))); }, []);
  if (error) return <ErrorLine error={error} />;
  if (!data) return <Muted>Loading…</Muted>;
  return (
    <>
      <Panel title="Rising concerns across meetings">
        {data.rising_concerns.length
          ? <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>{data.rising_concerns.map(r => (
            <span key={r.term} className="chip" style={{ padding: '0.25rem 0.6rem', borderRadius: '999px', background: 'rgba(245,158,11,0.12)', color: '#fbbf24', fontSize: '0.82rem' }}>
              {r.term} · {r.recent} recent vs {r.before} before</span>))}</div>
          : <Muted>No topic is trending up in the last two weeks.</Muted>}
      </Panel>
      <Panel title="People">
        {data.coverage.with_attendees === 0 && (
          <Muted>Add attendees to meetings (Meeting History, under the title, or when you start a session) to see who's getting quieter, recurring concerns and overdue 1:1s.</Muted>)}
        {data.coverage.with_attendees > 0 && data.coverage.with_attendees < data.coverage.meetings && (
          <Muted>{data.coverage.with_attendees} of {data.coverage.meetings} recent meetings have attendees.</Muted>)}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.75rem' }}>
          {data.people.map(p => (
            <div key={p.person} className="glass-panel" style={{ padding: '0.9rem 1rem', borderColor: p.flags.length ? 'rgba(245,158,11,0.4)' : undefined }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong>{p.person}</strong>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{p.days_since === 0 ? 'today' : `${p.days_since}d ago`}</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0.2rem 0 0.4rem' }}>
                {p.meetings} meetings · {p.one_on_ones} 1:1s{p.share.length ? ` · talks ${Math.round(p.share[p.share.length - 1])}% in 1:1s` : ''}
              </div>
              <Spark values={p.sentiment.map(s => s.value)} />
              {p.flags.map(f => <div key={f} style={{ fontSize: '0.8rem', color: '#fbbf24', marginTop: '0.3rem' }}>⚑ {f}</div>)}
              {!p.flags.length && <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '0.3rem' }}>No signals worth acting on.</div>}
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

export function Spark({ values, height = 26 }: { values: number[]; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), w = 120;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${height - ((v - min) / (max - min || 1)) * (height - 4) - 2}`).join(' ');
  return <svg width={w} height={height} aria-hidden><polyline points={pts} fill="none" stroke="var(--accent-primary)" strokeWidth={1.5} /></svg>;
}

// ---------------------------------------------------------------- digest & narrative
interface Doc { id: number; content: string; ref: string; created_at: string }

function DocTool({ kind }: { kind: 'digest' | 'narrative' }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [days, setDays] = useState(kind === 'digest' ? 7 : 30);
  const [topics, setTopics] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(0);
  const load = useCallback(() => api<Doc[]>(`/generated-docs?kind=${kind}`).then(setDocs).catch(() => {}), [kind]);
  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      await (kind === 'digest' ? api('/digest/weekly', { body: { days } }) : api('/narrative/check', { body: { days, topics } }));
      await load(); setOpen(0);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const remove = async (id: number) => { await api(`/generated-docs/${id}`, { method: 'DELETE' }).catch(() => {}); await load(); };
  const doc = docs[open];

  return (
    <Panel title={kind === 'digest' ? 'Weekly executive digest' : 'Narrative consistency check'}>
      <Muted>{kind === 'digest'
        ? 'A forwardable summary of your week: themes, decisions, risks, open loops, team pulse and one communication focus. Written by your LLM from your own meeting records.'
        : 'Compares what you said about the same topics to different audiences (exec staff, your team, vendors) and flags drift in numbers, dates, priorities or confidence.'}</Muted>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="type-select" value={days} onChange={e => setDays(Number(e.target.value))}>
          {(kind === 'digest' ? [7, 14, 31] : [14, 30, 60, 90]).map(d => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        {kind === 'narrative' && <input className="field" style={{ flex: '1 1 260px' }} value={topics} onChange={e => setTopics(e.target.value)}
          placeholder="Topics (optional): pricing, reorg, Q3 roadmap" />}
        <button className="btn btn-primary" onClick={run} disabled={busy}><Sparkles size={14} /> {busy ? 'Writing…' : kind === 'digest' ? 'Write digest' : 'Check my narrative'}</button>
      </div>
      <ErrorLine error={error} />
      {docs.length > 1 && (
        <select className="type-select" value={open} onChange={e => setOpen(Number(e.target.value))} style={{ alignSelf: 'flex-start' }}>
          {docs.map((d, i) => <option key={d.id} value={i}>{new Date(d.created_at + 'Z').toLocaleString()} · {d.ref}</option>)}
        </select>
      )}
      {doc ? (
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.8rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }}>
            <CopyButton text={doc.content} />
            <button className="icon-btn danger" title="Delete" onClick={() => remove(doc.id)}><Trash2 size={14} /></button>
          </div>
          <MiniMarkdown text={doc.content} />
        </div>
      ) : <Muted>Nothing written yet.</Muted>}
    </Panel>
  );
}
