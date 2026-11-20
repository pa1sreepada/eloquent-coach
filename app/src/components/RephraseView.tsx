import { useEffect, useState } from 'react';
import { RotateCcw, Save, WandSparkles } from 'lucide-react';
import { useDictation } from './useDictation';
import DictationBox from './DictationBox';
import { api, errText } from './leadershipApi';
import { CopyButton, ErrorLine, Muted, Panel } from './leadershipUi';

interface Option { label: string; text: string }
interface PromptT { prompt: string; default: string; custom: boolean }
type Style = 'all' | 'executive' | 'conversational' | 'direct';
type Context = 'auto' | 'work' | 'personal';

const STYLES: [Style, string][] = [['all', 'All three'], ['executive', 'Professional & Executive'], ['conversational', 'Collaborative & Conversational'], ['direct', 'Short & Direct']];
const CONTEXTS: [Context, string][] = [['auto', 'Detect work vs not'], ['work', 'Work message'], ['personal', 'Vendor / personal']];
const TWEAKS = ['Shorter', 'Firmer', 'Warmer', 'More detail'];

export default function RephraseView() {
  const [draft, setDraft] = useState('');
  const [style, setStyle] = useState<Style>(() => (localStorage.getItem('rephraseStyle') as Style) || 'all');
  const [context, setContext] = useState<Context>('auto');
  const [options, setOptions] = useState<Option[]>([]);
  const [busy, setBusy] = useState<string | null>(null);   // "all" or the label being refined
  const [error, setError] = useState<string | null>(null);
  const mic = useDictation(setDraft);
  useEffect(() => { localStorage.setItem('rephraseStyle', style); }, [style]);

  const run = async (label = '', instruction = '') => {
    if (!draft.trim()) return;
    if (mic.listening) mic.end();
    setBusy(label || 'all'); setError(null);
    try {
      const r = await api<{ options: Option[] }>('/rephrase', { body: { text: draft, style, context, label, instruction } });
      setOptions(label ? options.map(o => (o.label === label ? r.options[0] ?? o : o)) : r.options);
    } catch (e) { setError(errText(e)); } finally { setBusy(null); }
  };

  return (
    <div className="fade-in" style={{ maxWidth: '960px', margin: '0 auto', padding: '1.5rem 0 2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <header>
        <h1 style={{ fontSize: '1.7rem', marginBottom: '0.25rem' }}>Rephrase</h1>
        <p style={{ margin: 0 }}>Talk or type a rough draft, Slack message or email. Get ready-to-send versions in your voice.</p>
      </header>

      <Panel title="Your draft" action={draft && <button className="btn btn-outline" onClick={() => { setDraft(''); setOptions([]); }}>Clear</button>}>
        <div onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run(); } }}>
          <DictationBox value={draft} onChange={setDraft} mic={mic} rows={6}
            placeholder="e.g. need product to size the impact on promo before we commit, we're at capacity until peak freeze. click the mic to talk it out." />
        </div>
        {mic.error && <ErrorLine error={mic.error} />}
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="field" value={style} onChange={e => setStyle(e.target.value as Style)} style={{ width: 'auto' }} title="Which version to write">
            {STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="field" value={context} onChange={e => setContext(e.target.value as Context)} style={{ width: 'auto' }} title="Work messages and vendor or personal ones get different tones">
            {CONTEXTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className="btn btn-primary" disabled={!draft.trim() || busy !== null} onClick={() => void run()}>
            <WandSparkles size={14} /> {busy === 'all' ? 'Rephrasing…' : 'Rephrase'}
          </button>
          <Muted>⌘↵ to rephrase</Muted>
        </div>
        <ErrorLine error={error} />
      </Panel>

      {options.map(o => (
        <Panel key={o.label} title={o.label} action={<CopyButton text={o.text} />}>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.92rem', lineHeight: 1.55, opacity: busy === o.label ? 0.5 : 1 }}>{o.text}</div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {TWEAKS.map(t => (
              <button key={t} className="btn btn-outline" style={{ fontSize: '0.78rem', padding: '0.25rem 0.6rem' }} disabled={busy !== null}
                onClick={() => void run(o.label, `${t.toLowerCase()}. Rewrite only this option.`)}>{t}</button>
            ))}
          </div>
        </Panel>
      ))}

      <StylePrompt />
    </div>
  );
}

function StylePrompt() {
  const [p, setP] = useState<PromptT | null>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<PromptT>('/rephrase/prompt').then(r => { setP(r); setText(r.prompt); }).catch(e => setError(errText(e))); }, []);

  const save = async (prompt: string) => {
    setError(null);
    try {
      const r = await api<PromptT>('/rephrase/prompt', { method: 'PUT', body: { prompt } });
      setP(r); setText(r.prompt); setMsg(r.custom ? 'Saved.' : 'Using the default prompt.');
      setTimeout(() => setMsg(null), 2000);
    } catch (e) { setError(errText(e)); }
  };

  return (
    <Panel title="My style prompt" action={<button className="btn btn-outline" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Edit'}</button>}>
      <Muted>
        {p?.custom ? 'Using your own prompt.' : 'Using the built-in prompt.'} Describe your role, tone and the names and acronyms to keep exact.
        It is stored encrypted on this Mac. The app always asks for each option under a bold name, separated by ---.
      </Muted>
      {open && (
        <>
          <textarea className="field" rows={16} value={text} onChange={e => setText(e.target.value)} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }} />
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={!p || text === p.prompt} onClick={() => void save(text)}><Save size={14} /> Save</button>
            <button className="btn btn-outline" disabled={!p?.custom} onClick={() => void save('')}><RotateCcw size={14} /> Reset to default</button>
            {msg && <Muted>{msg}</Muted>}
          </div>
        </>
      )}
      <ErrorLine error={error} />
    </Panel>
  );
}
