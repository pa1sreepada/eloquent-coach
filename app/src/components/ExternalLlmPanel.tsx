import { useEffect, useState } from 'react';
import { Cloud, CheckCircle2, AlertTriangle, PlugZap, ShieldAlert } from 'lucide-react';

const API = 'http://127.0.0.1:8000';

export interface ExternalLlmSettings {
  external_llm_enabled: 'true' | 'false';
  external_llm_provider: string;
  external_llm_url: string;
  external_llm_model: string;
}

interface ProviderInfo {
  id: string;
  label: string;
  url: string;        // '' = user supplies the URL (Azure / custom)
  url_hint: string;
  model_hint: string;
  key_set: boolean;
}

interface Status {
  reachable: boolean;
  ok: boolean;
  models: string[];
  message: string;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.8rem',
  backgroundColor: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  color: 'var(--text-primary)',
};
const labelStyle: React.CSSProperties = { display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' };
const hintStyle: React.CSSProperties = { display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' };

export default function ExternalLlmPanel({ value, onChange }: {
  value: ExternalLlmSettings;
  onChange: (patch: Partial<ExternalLlmSettings>) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [testing, setTesting] = useState(false);

  const loadProviders = () =>
    fetch(`${API}/external-llm/providers`).then(r => r.json()).then(setProviders).catch(() => setProviders([]));
  useEffect(() => { loadProviders(); }, []);

  const provider = providers.find(p => p.id === value.external_llm_provider);
  const enabled = value.external_llm_enabled === 'true';
  const customUrl = provider ? !provider.url : false;

  const saveKey = async (key: string) => {
    setKeyMessage('');
    try {
      const res = await fetch(`${API}/external-llm/api-key`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: value.external_llm_provider, api_key: key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      setApiKey('');
      setKeyMessage(key ? 'API key saved to the Keychain.' : 'API key removed.');
      loadProviders();
    } catch {
      setKeyMessage('Could not save the API key.');
    }
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    const q = new URLSearchParams({
      provider: value.external_llm_provider,
      url: value.external_llm_url,
      model: value.external_llm_model,
      test: 'true',
    });
    try {
      const res = await fetch(`${API}/external-llm/status?${q}`);
      const data = await res.json();
      setStatus(res.ok ? data : { reachable: false, ok: false, models: [], message: String(data.detail ?? 'Invalid settings.') });
    } catch {
      setStatus({ reachable: false, ok: false, models: [], message: 'Error connecting to backend.' });
    }
    setTesting(false);
  };

  return (
    <div className="glass-panel" style={{ padding: '2rem' }}>
      <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Cloud size={20} color="var(--accent-primary)" /> External Frontier Model (optional)
      </h2>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => onChange({ external_llm_enabled: e.target.checked ? 'true' : 'false' })}
        />
        Use an external model for post-meeting summaries, follow-up emails and teleprompter polish
      </label>
      <small style={{ ...hintStyle, marginBottom: '1.5rem' }}>
        Live coaching cards always use the local LLM above. Any API that follows the OpenAI chat-completions spec works.
      </small>
      {enabled && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: '1.5rem', color: 'var(--color-warning, #f5a524)' }}>
          <ShieldAlert size={18} style={{ flexShrink: 0, marginTop: 2 }} />
          <small>
            When on, full meeting transcripts, notes and scripts are sent over HTTPS to {provider?.label ?? 'the provider'} and
            are subject to its data-retention policy. Use a business/enterprise account with training opt-out for confidential meetings.
          </small>
        </div>
      )}

      <div style={{ marginBottom: '1.5rem' }}>
        <label style={labelStyle}>Provider</label>
        <select
          value={value.external_llm_provider}
          onChange={e => { setStatus(null); setKeyMessage(''); onChange({ external_llm_provider: e.target.value }); }}
          style={inputStyle}
        >
          {providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <label style={labelStyle}>API Base URL</label>
        <input
          type="text"
          value={customUrl ? value.external_llm_url : provider?.url ?? ''}
          readOnly={!customUrl}
          placeholder={provider?.url_hint}
          onChange={e => onChange({ external_llm_url: e.target.value })}
          style={{ ...inputStyle, opacity: customUrl ? 1 : 0.6 }}
        />
        {customUrl && <small style={hintStyle}>Must use https:// (http:// only for a server on this Mac).</small>}
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <label style={labelStyle}>
          API key {provider?.key_set && <span style={{ color: 'var(--color-structure)' }}>· saved</span>}
        </label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={provider?.key_set ? '•••••••• (saved in the Keychain)' : `Your ${provider?.label ?? ''} API key`}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="button" className="btn" disabled={!apiKey.trim()} onClick={() => saveKey(apiKey.trim())}>Save key</button>
          {provider?.key_set && <button type="button" className="btn" onClick={() => saveKey('')}>Remove</button>}
        </div>
        <small style={hintStyle}>
          One key per provider, stored in the macOS Keychain. Never saved in the database or shown again. {keyMessage}
        </small>
      </div>

      <div>
        <label style={labelStyle}>Model ID</label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            list="external-llm-models"
            value={value.external_llm_model}
            onChange={e => onChange({ external_llm_model: e.target.value })}
            placeholder={provider?.model_hint}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="button" className="btn" onClick={test} disabled={testing}>
            <PlugZap size={16} /> {testing ? 'Testing…' : 'Test'}
          </button>
        </div>
        <datalist id="external-llm-models">
          {(status?.models ?? []).map(m => <option key={m} value={m} />)}
        </datalist>
        {status && (
          <small style={{ ...hintStyle, display: 'flex', gap: 6, alignItems: 'center',
                          color: status.ok ? 'var(--color-structure)' : 'var(--color-warning, #f5a524)' }}>
            {status.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            {status.message || (status.reachable ? `${status.models.length} models available.` : 'Not reachable.')}
            {status.models.length > 0 && status.message && ` ${status.models.length} models available.`}
          </small>
        )}
        <small style={hintStyle}>Test lists the models your key can use and sends one tiny request. Click Save Settings to apply.</small>
      </div>
    </div>
  );
}
