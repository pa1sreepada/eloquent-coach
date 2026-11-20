import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Plus, Send, Sparkles, Trash2, Flag, Save, Volume2 } from 'lucide-react';
import { speak, stopSpeaking, useDictation } from './useDictation';
import DictationBox from './DictationBox';
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
  const [pending, setPending] = useState<string | null>(null);   // my answer, shown while they think
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState(() => localStorage.getItem('rehearsalVoiceMode') === '1');
  const bottom = useRef<HTMLDivElement>(null);
  const scenarioMic = useDictation(setScenario);
  const answerMic = useDictation(setAnswer);

  useEffect(() => { localStorage.setItem('rehearsalVoiceMode', voiceMode ? '1' : '0'); if (!voiceMode) stopSpeaking(); }, [voiceMode]);
  useEffect(() => () => stopSpeaking(), []);
  const loadHistory = useCallback(() => api<RehearsalSummary[]>('/rehearsals').then(setHistory).catch(() => {}), []);
  useEffect(() => { api<Persona[]>('/rehearsals/personas').then(setPersonas).catch(() => {}); void loadHistory(); }, [loadHistory]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [r?.turns.length, r?.feedback, pending, busy]);

  const label = r?.persona_label ?? personas.find(p => p.id === persona)?.label ?? 'They';
  // Voice mode: they speak their line, then the mic opens for my answer.
  const theySay = async (text: string) => {
    if (!voiceMode) return;
    await speak(text);
    void answerMic.begin('');
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setError(null);
    try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(null); }
  };
  const start = () => step('start', async () => {
    scenarioMic.end();
    const res = await api<RehearsalT>('/rehearsals', { body: { persona, custom_persona: custom, scenario } });
    setR(res);
    void theySay(res.turns[0]?.text ?? '');
  });
  const send = () => {
    const text = answer.trim();
    if (!r || !text || busy) return;
    answerMic.end(); stopSpeaking();
    setPending(text); setAnswer('');
    void step('turn', async () => {
      try {
        const res = await api<{ reply: string; feedback: TurnFeedback }>(`/rehearsals/${r.id}/turn`, { body: { text } });
        setR({ ...r, turns: [...r.turns, { role: 'me', text, feedback: res.feedback }, { role: 'them', text: res.reply }] });
        void theySay(res.reply);
      } catch (e) { setAnswer(text); throw e; } finally { setPending(null); }
    });
  };
  const finish = () => r && step('finish', async () => {
    answerMic.end(); stopSpeaking();
    setR(await api<RehearsalT>(`/rehearsals/${r.id}/finish`, { body: {} })); void loadHistory();
  });
  const open = (id: number) => step('open', async () => { setR(await api<RehearsalT>(`/rehearsals/${id}`)); });
  const reset = () => { answerMic.end(); stopSpeaking(); setR(null); setAnswer(''); };
  const remove = async (id: number) => { await api(`/rehearsals/${id}`, { method: 'DELETE' }).catch(() => {}); if (r?.id === id) reset(); void loadHistory(); };

  return (
    <>
      <Panel title="Rehearse a hard conversation">
        {!r ? (
          <>
            <ol style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              <li><strong>Pick who you're facing.</strong> The AI plays that person and only that person.</li>
              <li><strong>Describe the situation from your side</strong>: who they are, what happened, what you need. "I" and "we" mean you.</li>
              <li><strong>They speak first. Answer by talking or typing</strong>, exactly as you'd say it in the room. Each answer gets a quick tip; they push harder when you hedge or ramble.</li>
              <li><strong>Finish & score</strong> for a scorecard with better lines to try.</li>
            </ol>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {[...personas, { id: 'custom', label: 'Custom…', description: 'Describe the person yourself' }].map(p => (
                <button key={p.id} title={p.description} onClick={() => setPersona(p.id)} className="btn"
                  style={{ borderColor: persona === p.id ? 'rgba(59,130,246,0.7)' : undefined, background: persona === p.id ? 'rgba(59,130,246,0.15)' : undefined }}>{p.label}</button>
              ))}
            </div>
            {persona === 'custom' && <input className="field" placeholder="Who are you facing? e.g. a new CRO who wants my team's budget" value={custom} onChange={e => setCustom(e.target.value)} />}
            <DictationBox value={scenario} rows={3} mic={scenarioMic} onChange={setScenario}
              placeholder="The situation, in your words. e.g. My Product peer is upset that we locked the Deals page in the CMS during the CDUI pilot without telling business users. I want to own the gap and agree a comms plan." />
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={start} disabled={!!busy || (persona === 'custom' && !custom.trim())}>
              <Play size={14} fill="currentColor" /> {busy === 'start' ? `${label} is getting ready…` : 'Start rehearsal'}</button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>You're talking with <strong>{r.persona_label}</strong> · {r.scenario}</div>
              {!r.feedback && (
                <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  title="They speak their lines aloud, then your mic opens for the answer">
                  <input type="checkbox" checked={voiceMode} onChange={e => setVoiceMode(e.target.checked)} /> <Volume2 size={14} /> Voice conversation
                </label>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: '440px', overflow: 'auto', paddingRight: '0.3rem' }}>
              {r.turns.map((t, i) => <Bubble key={i} turn={t} who={t.role === 'me' ? 'You' : r.persona_label} />)}
              {pending && <Bubble turn={{ role: 'me', text: pending }} who="You" />}
              {busy === 'turn' && <Bubble turn={{ role: 'them', text: '…' }} who={`${r.persona_label} is thinking`} faint />}
              <div ref={bottom} />
            </div>
            {r.feedback ? (
              <Scorecard r={r} />
            ) : (
              <>
                <DictationBox value={answer} rows={3} mic={answerMic} onChange={setAnswer} onSubmit={send}
                  placeholder={answerMic.listening ? 'Listening… speak your answer' : 'Your answer: press the mic and talk, or type. Enter sends, Shift+Enter for a new line.'} />
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                  <button className="btn" onClick={finish} disabled={!!busy || !r.turns.some(t => t.role === 'me')}>
                    <Flag size={14} /> {busy === 'finish' ? 'Scoring…' : 'Finish & score'}</button>
                  <button className="btn btn-primary" onClick={send} disabled={!!busy || !answer.trim()}><Send size={14} /> Send</button>
                </div>
              </>
            )}
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={reset}><Plus size={14} /> New rehearsal</button>
          </>
        )}
        <ErrorLine error={error ?? scenarioMic.error ?? answerMic.error} />
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

function Bubble({ turn, who, faint }: { turn: Turn; who: string; faint?: boolean }) {
  const me = turn.role === 'me';
  return (
    <div style={{ alignSelf: me ? 'flex-end' : 'flex-start', maxWidth: '80%', opacity: faint ? 0.6 : 1 }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.15rem', textAlign: me ? 'right' : 'left', color: me ? '#60a5fa' : '#34d399' }}>{who}</div>
      <div style={{ padding: '0.55rem 0.8rem', borderRadius: '10px', fontSize: '0.9rem', whiteSpace: 'pre-wrap',
        background: me ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.05)' }}>{turn.text}</div>
      {turn.feedback && (
        <div style={{ fontSize: '0.74rem', color: 'var(--text-tertiary)', marginTop: '0.2rem', textAlign: 'right' }}>
          {turn.feedback.words} words · {turn.feedback.answer_first ? 'answer first ✓' : 'buried the answer'}
          {turn.feedback.tips.length > 0 && <span style={{ color: '#fbbf24' }}> · {turn.feedback.tips.join(' ')}</span>}
        </div>
      )}
    </div>
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
