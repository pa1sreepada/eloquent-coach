import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Plus, Send, Sparkles, Trash2, Flag, Save } from 'lucide-react';
import { api, errText, usePeople } from './leadershipApi';
import { CopyButton, ErrorLine, MiniMarkdown, Muted, Panel, PeopleList, Tabs } from './leadershipUi';
import { MODES } from './meetingModes';

type Tab = 'brief' | 'rehearse' | 'stakeholders';
export interface StartArgs { mode: string; agenda: string; prepNotes: string; title: string; attendees: string }

export default function PrepareView({ onStartMeeting }: { onStartMeeting: (a: StartArgs) => void }) {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('prepareTab') as Tab) || 'brief');
  useEffect(() => { localStorage.setItem('prepareTab', tab); }, [tab]);
  return (
    <div className="fade-in" style={{ maxWidth: '960px', margin: '0 auto', padding: '1.5rem 0 2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <header>
        <h1 style={{ fontSize: '1.7rem', marginBottom: '0.25rem' }}>Prepare</h1>
        <p style={{ margin: 0 }}>Walk in knowing the history, rehearse the hard conversation, and know your audience.</p>
      </header>
      <Tabs value={tab} onChange={setTab} options={[['brief', 'Pre-meeting brief'], ['rehearse', 'Rehearse'], ['stakeholders', 'Stakeholder map']]} />
      {tab === 'brief' && <BriefTool onStartMeeting={onStartMeeting} />}
      {tab === 'rehearse' && <Rehearse />}
      {tab === 'stakeholders' && <Stakeholders />}
    </div>
  );
}

// ---------------------------------------------------------------- brief
function BriefTool({ onStartMeeting }: { onStartMeeting: (a: StartArgs) => void }) {
  const people = usePeople();
  const [f, setF] = useState({ title: '', mode: 'General Executive', attendees: '', agenda: '' });
  const [brief, setBrief] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = async (useLlm: boolean) => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await api<{ brief: string; meeting_ids: number[]; llm_error: string | null }>('/brief', { body: { ...f, use_llm: useLlm } });
      setBrief(r.brief);
      setNote(r.llm_error ? `The LLM couldn't write it (${r.llm_error}), so here is the raw context.`
        : r.meeting_ids.length ? `Based on ${r.meeting_ids.length} earlier meeting${r.meeting_ids.length === 1 ? '' : 's'}.` : 'No earlier meetings with these people yet.');
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <Panel title="Pre-meeting brief">
      <Muted>Pulls your past meetings with these people, open commitments both ways, unresolved questions and stakeholder profiles into a one-pager.</Muted>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
        <input className="field" placeholder="Meeting title, e.g. Q3 pricing review" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
        <select className="field" value={f.mode} onChange={e => setF({ ...f, mode: e.target.value })}>
          {MODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <input className="field" list="brief-people" placeholder="Attendees, e.g. Sarah Lee, Raj" value={f.attendees} onChange={e => setF({ ...f, attendees: e.target.value })} />
        <input className="field" placeholder="Goal: what outcome do you need?" value={f.agenda} onChange={e => setF({ ...f, agenda: e.target.value })} />
      </div>
      <PeopleList id="brief-people" people={people} />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="btn btn-primary" onClick={() => build(true)} disabled={busy}><Sparkles size={14} /> {busy ? 'Building…' : 'Build brief'}</button>
        <button className="btn" onClick={() => build(false)} disabled={busy} title="No LLM: just the facts the brief would use">Facts only</button>
      </div>
      <ErrorLine error={error} />
      {brief && (
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {note && <Muted>{note}</Muted>}
          <MiniMarkdown text={brief} />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <CopyButton text={brief} />
            <button className="btn btn-primary" onClick={() => onStartMeeting({ mode: f.mode, agenda: f.agenda, prepNotes: brief, title: f.title, attendees: f.attendees })}>
              <Play size={14} fill="currentColor" /> Start this meeting with the brief
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- rehearsal
interface Persona { id: string; label: string; description: string }
interface TurnFeedback { words: number; hedge_rate: number | null; filler_rate: number | null; answer_first: boolean; tips: string[] }
interface Turn { role: 'me' | 'them'; text: string; feedback?: TurnFeedback }
interface RehearsalT {
  id: number; persona: string; persona_label: string; scenario: string; turns: Turn[];
  scores: { stats: Record<string, number | null>; scores: Record<string, number> } | null; feedback: string | null; created_at: string;
}
interface RehearsalSummary { id: number; persona_label: string; scenario: string; turns: number; scores: RehearsalT['scores']; created_at: string }

function Rehearse() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [persona, setPersona] = useState('skeptical_cfo');
  const [custom, setCustom] = useState('');
  const [scenario, setScenario] = useState('');
  const [r, setR] = useState<RehearsalT | null>(null);
  const [history, setHistory] = useState<RehearsalSummary[]>([]);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(() => api<RehearsalSummary[]>('/rehearsals').then(setHistory).catch(() => {}), []);
  useEffect(() => { api<Persona[]>('/rehearsals/personas').then(setPersonas).catch(() => {}); void loadHistory(); }, [loadHistory]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [r?.turns.length, r?.feedback]);

  const step = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(null); }
  };
  const start = () => step('start', async () => {
    setR(await api<RehearsalT>('/rehearsals', { body: { persona, custom_persona: custom, scenario } }));
  });
  const send = () => r && answer.trim() && step('turn', async () => {
    const text = answer.trim();
    const res = await api<{ reply: string; feedback: TurnFeedback }>(`/rehearsals/${r.id}/turn`, { body: { text } });
    setAnswer('');
    setR({ ...r, turns: [...r.turns, { role: 'me', text, feedback: res.feedback }, { role: 'them', text: res.reply }] });
  });
  const finish = () => r && step('finish', async () => { setR(await api<RehearsalT>(`/rehearsals/${r.id}/finish`, { body: {} })); void loadHistory(); });
  const open = (id: number) => step('open', async () => { setR(await api<RehearsalT>(`/rehearsals/${id}`)); });
  const remove = async (id: number) => { await api(`/rehearsals/${id}`, { method: 'DELETE' }).catch(() => {}); if (r?.id === id) setR(null); void loadHistory(); };

  return (
    <>
      <Panel title="Rehearse a hard conversation">
        {!r ? (
          <>
            <Muted>An AI plays the other side and presses harder when you hedge or ramble. Type your answers as you'd say them aloud; you get quick tips after each one and a scorecard at the end.</Muted>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {[...personas, { id: 'custom', label: 'Custom…', description: '' }].map(p => (
                <button key={p.id} title={p.description} onClick={() => setPersona(p.id)} className="btn"
                  style={{ borderColor: persona === p.id ? 'rgba(59,130,246,0.7)' : undefined, background: persona === p.id ? 'rgba(59,130,246,0.15)' : undefined }}>{p.label}</button>
              ))}
            </div>
            {persona === 'custom' && <input className="field" placeholder="Describe who you're facing, e.g. a new CRO who wants my team's budget" value={custom} onChange={e => setCustom(e.target.value)} />}
            <textarea className="field" rows={3} placeholder="Scenario: what's the conversation about? e.g. I'm asking for $2M to rebuild the data platform; payback in 18 months."
              value={scenario} onChange={e => setScenario(e.target.value)} />
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={start} disabled={!!busy || (persona === 'custom' && !custom.trim())}>
              <Play size={14} fill="currentColor" /> {busy === 'start' ? 'Starting…' : 'Start rehearsal'}</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>{r.persona_label}</strong> · {r.scenario}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: '420px', overflow: 'auto', paddingRight: '0.3rem' }}>
              {r.turns.map((t, i) => (
                <div key={i} style={{ alignSelf: t.role === 'me' ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                  <div style={{ padding: '0.55rem 0.8rem', borderRadius: '10px', fontSize: '0.9rem',
                    background: t.role === 'me' ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.05)' }}>{t.text}</div>
                  {t.feedback && (
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-tertiary)', marginTop: '0.2rem', textAlign: 'right' }}>
                      {t.feedback.words} words · {t.feedback.answer_first ? 'answer first ✓' : 'buried the answer'}
                      {t.feedback.tips.length > 0 && <span style={{ color: '#fbbf24' }}> · {t.feedback.tips.join(' ')}</span>}
                    </div>
                  )}
                </div>
              ))}
              <div ref={bottom} />
            </div>
            {r.feedback ? (
              <Scorecard r={r} />
            ) : (
              <>
                <textarea className="field" rows={3} placeholder="Your answer… (⌘↩ to send)" value={answer} onChange={e => setAnswer(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                  <button className="btn" onClick={finish} disabled={!!busy || !r.turns.some(t => t.role === 'me')}>
                    <Flag size={14} /> {busy === 'finish' ? 'Scoring…' : 'Finish & score'}</button>
                  <button className="btn btn-primary" onClick={send} disabled={!!busy || !answer.trim()}><Send size={14} /> {busy === 'turn' ? '…' : 'Send'}</button>
                </div>
              </>
            )}
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setR(null)}><Plus size={14} /> New rehearsal</button>
          </>
        )}
        <ErrorLine error={error} />
      </Panel>
      {history.length > 0 && (
        <Panel title="Past rehearsals">
          {history.map(h => (
            <div key={h.id} style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', fontSize: '0.85rem' }}>
              <span style={{ width: '90px', color: 'var(--text-tertiary)' }}>{h.created_at.slice(0, 10)}</span>
              <button onClick={() => open(h.id)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <strong>{h.persona_label}</strong> · {h.scenario}</button>
              <span style={{ color: 'var(--text-tertiary)' }}>{h.scores ? avgScore(h.scores.scores) : `${h.turns} turns`}</span>
              <button className="icon-btn danger" title="Delete" onClick={() => remove(h.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}

function avgScore(s: Record<string, number>) {
  const v = Object.values(s);
  return v.length ? `${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}/10` : 'scored';
}

function Scorecard({ r }: { r: RehearsalT }) {
  const s = r.scores;
  return (
    <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {s && Object.keys(s.scores).length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {Object.entries(s.scores).map(([k, v]) => (
            <div key={k} className="glass-panel" style={{ padding: '0.5rem 0.8rem', textAlign: 'center', minWidth: '90px' }}>
              <div style={{ fontSize: '1.3rem', fontWeight: 600, color: v >= 7 ? '#34d399' : v >= 5 ? '#fbbf24' : '#f87171' }}>{v}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', textTransform: 'capitalize' }}>{k}</div>
            </div>
          ))}
        </div>
      )}
      {s?.stats && (
        <Muted>Measured: {s.stats.hedge_rate ?? '—'} hedges/100 words · {s.stats.filler_rate ?? '—'} fillers/100 words · answer-first {s.stats.answer_first_pct ?? '—'}% · {s.stats.avg_turn_words ?? '—'} words per answer</Muted>
      )}
      {r.feedback && <MiniMarkdown text={r.feedback} />}
    </div>
  );
}

// ---------------------------------------------------------------- stakeholders
interface StakeholderT {
  id: number; name: string; role: string; relationship_type: string; priorities: string; pushback_style: string; persuaders: string; notes: string;
  meetings: number; last_met: string | null; their_open_commitments: number; recent_concerns: string[];
}
const EMPTY = { name: '', role: '', relationship_type: '', priorities: '', pushback_style: '', persuaders: '', notes: '' };
const RELS = ['Manager', 'Peer', 'Direct report', 'Executive', 'Board', 'Customer', 'Vendor', 'Partner'];

function Stakeholders() {
  const [data, setData] = useState<{ stakeholders: StakeholderT[]; suggested: string[] } | null>(null);
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<typeof data>('/stakeholders').then(setData).catch(e => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!edit?.name.trim()) return;
    setError(null);
    try {
      const { id, ...body } = edit;
      await (id ? api(`/stakeholders/${id}`, { method: 'PUT', body }) : api('/stakeholders', { body }));
      setEdit(null); await load();
    } catch (e) { setError(errText(e)); }
  };
  const learn = async () => {
    if (!edit?.id) return;
    setBusy(true); setError(null);
    try {
      const s = await api<{ priorities: string; pushback_style: string; persuaders: string; notes: string }>(`/stakeholders/${edit.id}/learn`, { body: {} });
      const keep = (cur: string, sug: string) => (cur.trim() ? cur : /^unknown/i.test(sug) ? '' : sug);
      setEdit({ ...edit, priorities: keep(edit.priorities, s.priorities), pushback_style: keep(edit.pushback_style, s.pushback_style),
        persuaders: keep(edit.persuaders, s.persuaders), notes: keep(edit.notes, s.notes) });
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const remove = async (id: number) => { await api(`/stakeholders/${id}`, { method: 'DELETE' }).catch(() => {}); setEdit(null); await load(); };

  return (
    <>
      <Panel title="Stakeholder map" action={<button className="btn" onClick={() => setEdit({ ...EMPTY })}><Plus size={14} /> Add person</button>}>
        <Muted>A private profile per person: what they care about, how they push back and what persuades them. Used in your pre-meeting briefs. Stays on this Mac, encrypted.</Muted>
        <ErrorLine error={error} />
        {edit && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem', padding: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
            <input className="field" placeholder="Name" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} />
            <input className="field" placeholder="Role, e.g. CFO" value={edit.role} onChange={e => setEdit({ ...edit, role: e.target.value })} />
            <select className="field" value={edit.relationship_type} onChange={e => setEdit({ ...edit, relationship_type: e.target.value })}>
              <option value="">Relationship…</option>{RELS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            {([['priorities', 'What they care about / are measured on'], ['pushback_style', 'How they push back'],
              ['persuaders', 'What persuades them'], ['notes', 'Notes']] as const).map(([k, ph]) => (
              <textarea key={k} className="field" rows={2} placeholder={ph} style={{ gridColumn: k === 'notes' ? 'span 3' : undefined }}
                value={edit[k]} onChange={e => setEdit({ ...edit, [k]: e.target.value })} />
            ))}
            <div style={{ gridColumn: 'span 3', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              {edit.id && <button className="btn" onClick={learn} disabled={busy} title="Suggest from your meetings with them (fills empty fields only)">
                <Sparkles size={14} /> {busy ? 'Reading meetings…' : 'Suggest from meetings'}</button>}
              {edit.id && <button className="btn" onClick={() => remove(edit.id as number)}><Trash2 size={14} /> Delete</button>}
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save}><Save size={14} /> Save</button>
            </div>
          </div>
        )}
        {data && data.stakeholders.length === 0 && !edit && <Muted>No one yet.</Muted>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem' }}>
          {data?.stakeholders.map(s => (
            <button key={s.id} className="glass-panel" onClick={() => setEdit({ id: s.id, name: s.name, role: s.role || '', relationship_type: s.relationship_type || '',
              priorities: s.priorities || '', pushback_style: s.pushback_style || '', persuaders: s.persuaders || '', notes: s.notes || '' })}
              style={{ padding: '0.9rem 1rem', textAlign: 'left', cursor: 'pointer', color: 'var(--text-primary)' }}>
              <div><strong>{s.name}</strong> <span style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>{[s.role, s.relationship_type].filter(Boolean).join(' · ')}</span></div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0.2rem 0 0.4rem' }}>
                {s.meetings} meetings{s.last_met ? ` · last ${s.last_met}` : ''}{s.their_open_commitments ? ` · owes you ${s.their_open_commitments}` : ''}
              </div>
              {s.priorities && <div style={{ fontSize: '0.82rem' }}><span style={{ color: 'var(--text-tertiary)' }}>Cares about:</span> {s.priorities}</div>}
              {s.persuaders && <div style={{ fontSize: '0.82rem' }}><span style={{ color: 'var(--text-tertiary)' }}>Persuaded by:</span> {s.persuaders}</div>}
              {s.recent_concerns.length > 0 && <div style={{ fontSize: '0.78rem', color: '#fbbf24', marginTop: '0.3rem' }}>Recent concerns: {s.recent_concerns.join(', ')}</div>}
            </button>
          ))}
        </div>
      </Panel>
      {data && data.suggested.length > 0 && (
        <Panel title="From your meetings, not on the map yet">
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {data.suggested.map(n => <button key={n} className="btn" onClick={() => setEdit({ ...EMPTY, name: n })}><Plus size={12} /> {n}</button>)}
          </div>
        </Panel>
      )}
    </>
  );
}
