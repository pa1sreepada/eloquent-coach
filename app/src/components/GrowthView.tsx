import { useCallback, useEffect, useState } from 'react';
import { Check, ScrollText, Sparkles, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { api, errText } from './leadershipApi';
import { ErrorLine, Muted, Panel } from './leadershipUi';
import { Spark } from './LeadershipView';

interface MetricDef { label: string; better: 'lower' | 'higher' | 'range'; target: number | [number, number]; unit?: string }
interface MetricRow { baseline: number | null; recent: number | null; improving: boolean | null; series: { date: string; value: number }[] }
interface Growth {
  metrics: Record<string, MetricDef>;
  categories: Record<string, { label: string; meetings: number; metrics: Record<string, MetricRow> }>;
  weekly: ({ week: string; meetings: number } & Record<string, number | null>)[];
  focus: { metric: string; label: string; recent: number; target: number | [number, number] }[];
  attribution: { verified: number; mixed: number; excluded: number; used: number };
  meetings: { id: number; title: string; date: string; category_label: string; attribution: string; override: string; confidence: number; me_words: number }[];
  practice: { count: number; sessions: { kind: string; date: string; title: string; stats: Record<string, number | null>; scores?: Record<string, number> }[] };
}
interface SayItem { key: string; original: string; better: string | null; why: string; meeting_id: number; meeting_title: string; date: string; attribution: string; practiced: boolean }

const fmtTarget = (t: number | [number, number]) => (Array.isArray(t) ? `${t[0]}–${t[1]}` : String(t));

export default function GrowthView() {
  const [g, setG] = useState<Growth | null>(null);
  const [mixed, setMixed] = useState(() => localStorage.getItem('growthMixed') === '1');
  const [error, setError] = useState<string | null>(null);
  const [showMeetings, setShowMeetings] = useState(false);

  const load = useCallback(() => {
    api<Growth>(`/growth?include_mixed=${mixed}`).then(d => { setG(d); setError(null); }).catch(e => setError(errText(e)));
  }, [mixed]);
  useEffect(() => { localStorage.setItem('growthMixed', mixed ? '1' : '0'); load(); }, [load, mixed]);

  const override = async (id: number, attribution: string) => {
    try { await api(`/meetings/${id}/attribution`, { method: 'PUT', body: { attribution } }); load(); } catch (e) { setError(errText(e)); }
  };

  return (
    <div className="fade-in" style={{ maxWidth: '960px', margin: '0 auto', padding: '1.5rem 0 2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <header>
        <h1 style={{ fontSize: '1.7rem', marginBottom: '0.25rem' }}>Growth</h1>
        <p style={{ margin: 0 }}>How your speaking is changing, compared like-for-like within each kind of meeting.</p>
      </header>
      <ErrorLine error={error} />
      <SayItBetter />
      {!g ? <Muted>Analysing your meetings… (the first run reads every transcript once)</Muted> : (
        <>
          <Panel title="Whose voice is counted" action={
            <label style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input type="checkbox" checked={mixed} onChange={e => setMixed(e.target.checked)} /> Include mixed meetings
            </label>}>
            <Muted>
              Your mic channel is "Me", but on speakers it also picks up the room. Trends use only meetings where the "Me" channel is
              clearly you ({g.attribution.verified} verified), plus rehearsals and teleprompter runs. {g.attribution.mixed} meetings look mixed
              {mixed ? ' and are included' : ' and are left out'}; {g.attribution.excluded} are excluded. Use a headset, or mark a meeting
              verified below, for the most accurate picture. {g.attribution.used} meetings are counted.
            </Muted>
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowMeetings(s => !s)}>
              {showMeetings ? 'Hide' : 'Review'} meeting attribution
            </button>
            {showMeetings && (
              <div style={{ maxHeight: '280px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {g.meetings.map(m => (
                  <div key={m.id} style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', fontSize: '0.82rem' }}>
                    <span style={{ width: '82px', color: 'var(--text-tertiary)' }}>{m.date.slice(0, 10)}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.title}>{m.title}</span>
                    <span style={{ width: '120px', color: 'var(--text-tertiary)' }}>{m.category_label}</span>
                    <span style={{ width: '80px', color: m.attribution === 'verified' ? '#34d399' : m.attribution === 'mixed' ? '#fbbf24' : 'var(--text-tertiary)' }}
                      title={`Auto confidence ${Math.round(m.confidence * 100)}% · ${m.me_words} words on "Me"`}>{m.attribution}</span>
                    <select className="type-select" value={m.override} onChange={e => override(m.id, e.target.value)}>
                      <option value="auto">auto</option><option value="verified">verified</option>
                      <option value="mixed">mixed</option><option value="exclude">exclude</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {g.focus.length > 0 && (
            <Panel title="Your focus right now">
              {g.focus.map(f => (
                <div key={f.metric} style={{ fontSize: '0.92rem' }}>
                  <strong>{f.label}</strong>: {f.recent} recently, target {fmtTarget(f.target)}. <span style={{ color: 'var(--text-secondary)' }}>{FOCUS_TIP[f.metric]}</span>
                </div>
              ))}
            </Panel>
          )}

          {Object.keys(g.categories).length === 0 ? (
            <Panel title="Trends by meeting type">
              <Muted>Not enough of your own speech yet. Mark meetings where you wore a headset as verified, or rehearse in Prepare.</Muted>
            </Panel>
          ) : Object.entries(g.categories).map(([cat, c]) => (
            <Panel key={cat} title={`${c.label} · ${c.meetings} meeting${c.meetings === 1 ? '' : 's'}`}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.6rem' }}>
                {Object.entries(c.metrics).map(([k, m]) => <MetricTile key={k} def={g.metrics[k]} row={m} />)}
              </div>
            </Panel>
          ))}

          {g.weekly.length > 1 && (
            <Panel title="Week by week">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.6rem' }}>
                {['filler_rate', 'hedge_rate', 'answer_first_pct', 'decisive_rate'].map(k => (
                  <div key={k}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>{g.metrics[k].label}</div>
                    <Spark values={g.weekly.map(w => w[k]).filter((v): v is number => v != null)} />
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {g.practice.count > 0 && (
            <Panel title={`Practice · ${g.practice.count} sessions`}>
              {g.practice.sessions.slice(-8).reverse().map((s, i) => (
                <div key={i} style={{ fontSize: '0.84rem', display: 'flex', gap: '0.6rem' }}>
                  <span style={{ width: '82px', color: 'var(--text-tertiary)' }}>{s.date}</span>
                  <span style={{ width: '110px', color: 'var(--text-secondary)' }}>{s.kind}</span>
                  <span style={{ flex: 1 }}>{s.title}</span>
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {s.scores && Object.keys(s.scores).length
                      ? Object.entries(s.scores).map(([k, v]) => `${k} ${v}`).join(' · ')
                      : [s.stats.wpm != null && `${s.stats.wpm} wpm`, s.stats.filler_rate != null && `${s.stats.filler_rate} fillers/100w`].filter(Boolean).join(' · ')}
                  </span>
                </div>
              ))}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

const FOCUS_TIP: Record<string, string> = {
  filler_rate: 'Replace "um/so/like" with a one-beat pause; silence reads as confidence.',
  hedge_rate: 'Swap "I think maybe we could" for "I recommend" or "We will". Own the position.',
  answer_first_pct: 'When asked a question, say the answer in your first sentence, then the reasons.',
  open_question_pct: 'Ask "what" and "how" questions to draw people out, not yes/no ones.',
  decisive_rate: 'Close topics with a clear decision, owner and date.',
  avg_turn_words: 'Shorter turns: make one point, then hand the floor back.',
};

function MetricTile({ def, row }: { def: MetricDef; row: MetricRow }) {
  const Icon = row.improving == null ? Minus : row.improving ? TrendingUp : TrendingDown;
  const color = row.improving == null ? 'var(--text-tertiary)' : row.improving ? '#34d399' : '#f87171';
  return (
    <div style={{ padding: '0.6rem 0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{def.label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0.15rem 0' }}>
        <span style={{ fontSize: '1.25rem', fontWeight: 600 }}>{row.recent ?? '—'}</span>
        <Icon size={15} color={color} />
        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>from {row.baseline ?? '—'} · target {fmtTarget(def.target)}</span>
      </div>
      <Spark values={row.series.map(s => s.value)} height={20} />
    </div>
  );
}

function SayItBetter() {
  const [items, setItems] = useState<SayItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const load = useCallback(() => { api<{ items: SayItem[] }>('/growth/say-it-better?days=7').then(d => setItems(d.items)).catch(e => setError(errText(e))); }, []);
  useEffect(() => { load(); }, [load]);

  const rewrite = async (it: SayItem) => {
    setBusy(it.key); setError(null);
    try {
      const r = await api<{ better: string }>('/growth/say-it-better/rewrite', { body: { original: it.original, meeting_id: it.meeting_id } });
      setItems(xs => xs?.map(x => (x.key === it.key ? { ...x, better: r.better } : x)) ?? null);
    } catch (e) { setError(errText(e)); } finally { setBusy(null); }
  };
  const practised = async (it: SayItem) => {
    await api('/growth/practice', { body: { original: it.original, better: it.better, meeting_id: it.meeting_id } }).catch(() => {});
    setItems(xs => xs?.map(x => (x.key === it.key ? { ...x, practiced: true } : x)) ?? null);
  };
  const toPrompter = async () => {
    const lines = (items ?? []).filter(i => i.better).map(i => i.better as string);
    if (!lines.length) return;
    try {
      await api('/scripts', { body: { title: `Say it better · ${new Date().toLocaleDateString()}`, content: lines.join('\n\n') } });
      setSent('Added to the Teleprompter library. Read them aloud three times each.');
    } catch (e) { setError(errText(e)); }
  };

  return (
    <Panel title="Say it better · this week's three moments" action={
      items?.some(i => i.better) ? <button className="btn" onClick={toPrompter}><ScrollText size={14} /> Practise in Teleprompter</button> : undefined}>
      <ErrorLine error={error} />
      {sent && <Muted>{sent}</Muted>}
      {!items ? <Muted>Loading…</Muted> : items.length === 0 ? <Muted>No moments to replay yet. Generate a meeting summary to get suggested reroutes.</Muted> : items.map(it => (
        <div key={it.key} style={{ borderLeft: '2px solid var(--border-color)', paddingLeft: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            {it.date} · {it.meeting_title}{it.attribution !== 'verified' && ' · may be someone else on your mic'}
          </div>
          <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>You said: “{it.original}”</div>
          {it.better
            ? <div style={{ fontSize: '0.95rem' }}>Try: <strong>“{it.better}”</strong></div>
            : <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy === it.key} onClick={() => rewrite(it)}>
                <Sparkles size={14} /> {busy === it.key ? 'Rewriting…' : 'Show me a stronger version'}</button>}
          {it.better && (it.practiced
            ? <span style={{ fontSize: '0.78rem', color: '#34d399' }}><Check size={12} /> Practised</span>
            : <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => practised(it)}><Check size={14} /> I said it aloud</button>)}
        </div>
      ))}
    </Panel>
  );
}
