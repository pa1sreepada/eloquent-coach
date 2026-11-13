import { useState } from 'react';
import { CheckCircle2, AlertTriangle, PlugZap, ShieldAlert } from 'lucide-react';

const API = 'http://127.0.0.1:8000';

const LLM_PRESETS = [
  { id: 'lmstudio', label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
  { id: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
] as const;

interface ModelInfo {
  id: string;
  loaded: boolean | null;
  context_length: number | null;
  size_bytes: number | null;
}

interface LlmStatus {
  url: string;
  reachable: boolean;
  provider: string | null;
  provider_name: string | null;
  models: ModelInfo[];
  model: string | null;
  model_source: 'configured' | 'auto';
  ok: boolean;
  message: string;
  local: boolean;              // server is on this Mac (loopback)
  exposed_at: string | null;   // same server also answers on this Mac's network address
}

const gb = (b: number | null) => (b ? ` · ${(b / 1024 ** 3).toFixed(1)} GB` : '');

const presetButton = (active: boolean): React.CSSProperties => ({
  padding: '0.4rem 0.9rem',
  borderRadius: '999px',
  border: `1px solid ${active ? 'var(--accent-primary)' : 'rgba(255,255,255,0.15)'}`,
  background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
  color: 'var(--text-primary)',
  cursor: 'pointer',
});

/** Server presets, connection test and model discovery for the LLM settings. Works with LM Studio, Ollama
 *  or any OpenAI-compatible server; the backend detects which one is at the URL. */
export default function LlmConnectionPanel({ url, model, thinking, allowRemote, onUrlChange, modelListId }: {
  url: string;
  model: string;
  thinking: boolean;
  allowRemote: boolean;
  onUrlChange: (url: string) => void;
  modelListId: string;   // <datalist> id for the Model ID input's suggestions
}) {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    try {
      const qs = new URLSearchParams({ url, model, thinking: String(thinking), allow_remote: String(allowRemote), test: 'true' });
      const res = await fetch(`${API}/llm/status?${qs}`);
      const data = await res.json();
      setStatus(res.ok ? data : { ...emptyStatus(url), message: data.detail || `HTTP ${res.status}` });
    } catch {
      setStatus({ ...emptyStatus(url), message: 'Could not reach the backend.' });
    }
    setTesting(false);
  };

  const fresh = status && status.url === url.trim().replace(/\/+$/, '') ? status : null;
  const autoNote = fresh?.ok && fresh.model_source === 'auto' && fresh.model
    ? ` Model ID is blank, so the app uses ${fresh.model}.` : '';

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        {LLM_PRESETS.map(p => (
          <button key={p.id} type="button" style={presetButton(url === p.url)} onClick={() => onUrlChange(p.url)}>
            {p.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={test} disabled={testing || !url.trim()}>
          <PlugZap size={16} /> {testing ? 'Testing… (loading the model can take a minute)' : 'Test connection'}
        </button>
      </div>

      {fresh && (
        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
          color: fresh.ok ? 'var(--color-structure)' : 'var(--color-risk)' }}>
          {fresh.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>
            {fresh.provider_name && fresh.reachable && <b>{fresh.provider_name} detected. </b>}
            {fresh.message}{autoNote}
          </span>
        </div>
      )}

      {fresh && fresh.reachable && !fresh.local && (
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', color: 'var(--color-risk)' }}>
          <ShieldAlert size={18} />
          <span>This server is not on this Mac: meeting transcripts and notes are sent to it.</span>
        </div>
      )}

      {fresh?.exposed_at && (
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', color: 'var(--color-risk)' }}>
          <ShieldAlert size={18} />
          <span>
            {fresh.provider_name || 'The LLM server'} is also reachable from your network at {fresh.exposed_at}, so other
            devices can use it. Unless you need that, limit it to this Mac (Ollama: unset <code>OLLAMA_HOST</code>;
            LM Studio: turn off "Serve on Local Network").
          </span>
        </div>
      )}

      {fresh && fresh.models.length > 0 && (
        <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
          Available models: {fresh.models.map(m => `${m.id}${m.loaded ? ' (loaded)' : ''}${gb(m.size_bytes)}`).join(', ')}
        </small>
      )}

      <datalist id={modelListId}>
        {fresh?.models.map(m => <option key={m.id} value={m.id} />)}
      </datalist>
    </div>
  );
}

function emptyStatus(url: string): LlmStatus {
  return { url: url.trim().replace(/\/+$/, ''), reachable: false, provider: null, provider_name: null,
    models: [], model: null, model_source: 'auto', ok: false, message: '', local: true, exposed_at: null };
}
