import { useState, useEffect } from 'react';
import { Save, Settings2, Database, Mic, RefreshCw } from 'lucide-react';
import AsrSettingsPanel, { type AsrSettings } from './AsrSettingsPanel';
import StoragePanel from './StoragePanel';
import LlmConnectionPanel from './LlmConnectionPanel';
import ExternalLlmPanel, { type ExternalLlmSettings } from './ExternalLlmPanel';
import { SYSTEM_AUDIO } from '../hud/useDualChannelCapture';

interface Settings extends AsrSettings, ExternalLlmSettings {
  llm_api_url: string;
  llm_model: string;
  llm_thinking: 'true' | 'false';
  llm_streaming: 'true' | 'false';
  llm_allow_remote: 'true' | 'false';
  coach_instructions: string;
  filler_words: string;
  custom_jargon: string;
  leader_name?: string;
}

export default function SettingsView() {
  const [settings, setSettings] = useState<Settings>({
    llm_api_url: '',
    llm_model: '',
    llm_thinking: 'false',
    llm_streaming: 'true',
    llm_allow_remote: 'false',
    external_llm_enabled: 'false',
    external_llm_provider: 'openai',
    external_llm_url: '',
    external_llm_model: '',
    coach_instructions: '',
    asr_profile: 'auto',
    asr_backend: 'auto',
    asr_adaptive: 'true',
    filler_words: '',
    custom_jargon: ''
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyMessage, setApiKeyMessage] = useState('');
  
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>('');
  const [selectedSystem, setSelectedSystem] = useState<string>('');

  useEffect(() => {
    fetch('http://127.0.0.1:8000/settings')
      .then(res => res.json())
      .then(({ llm_api_key_set, ...data }) => {
        setApiKeySet(!!llm_api_key_set);
        setSettings(prev => ({ ...prev, ...data }));
        setIsLoading(false);
      })
      .catch(err => {
        console.error("Failed to load settings:", err);
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    const getDevices = async () => {
      try {
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach(track => track.stop());
        } catch (e) {
          console.warn("Could not get initial microphone permission for listing labels", e);
        }
        
        const deviceList = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = deviceList.filter(device => device.kind === 'audioinput');
        setDevices(audioInputs);
        
        let savedMic = localStorage.getItem('selected_mic') || '';
        let savedSystem = localStorage.getItem('selected_system') || '';
        
        if (!savedMic && audioInputs.length > 0) {
          const defaultMicDevice = audioInputs.find(d => 
            d.label.toLowerCase().includes('microphone') || 
            d.label.toLowerCase().includes('built-in') || 
            d.deviceId === 'default'
          ) || audioInputs[0];
          savedMic = defaultMicDevice.deviceId;
          localStorage.setItem('selected_mic', savedMic);
        }
        
        // First run: prefer a BlackHole device if installed, otherwise the built-in Mac system audio.
        if (localStorage.getItem('selected_system') === null) {
          const bhDevice = audioInputs.find(d => d.label.toLowerCase().includes('blackhole'));
          savedSystem = bhDevice ? bhDevice.deviceId : SYSTEM_AUDIO;
          localStorage.setItem('selected_system', savedSystem);
        }
        
        setSelectedMic(savedMic);
        setSelectedSystem(savedSystem);
      } catch (err) {
        console.error("Error enumerating devices:", err);
      }
    };
    
    getDevices();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setSettings(prev => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage('');
    try {
      const response = await fetch('http://127.0.0.1:8000/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(settings)
      });
      
      if (response.ok) {
        setSaveMessage('Settings saved successfully!');
        setTimeout(() => setSaveMessage(''), 3000);
      } else {
        const detail = await response.json().then(d => d.detail).catch(() => '');
        setSaveMessage(`Failed to save settings.${typeof detail === 'string' && detail ? ` ${detail}` : ''}`);
      }
    } catch (err) {
      console.error(err);
      setSaveMessage('Error connecting to backend.');
    }
    setIsSaving(false);
  };

  const saveApiKey = async (key: string) => {
    setApiKeyMessage('');
    try {
      const res = await fetch('http://127.0.0.1:8000/llm/api-key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      setApiKeySet(!!data.llm_api_key_set);
      setApiKey('');
      setApiKeyMessage(key ? 'API key saved to the Keychain.' : 'API key removed.');
    } catch {
      setApiKeyMessage('Could not save the API key.');
    }
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <RefreshCw className="pulse-animation" size={24} />
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ height: '100%', overflowY: 'auto', paddingRight: '1rem' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ marginBottom: '0.2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Settings2 size={28} /> Configuration
        </h1>
        <p>Manage your backend engines, custom executive jargon, and LLM integration.</p>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        
        {/* LLM Settings */}
        <div className="glass-panel" style={{ padding: '2rem' }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Database size={20} color="var(--accent-primary)" /> Local LLM Engine (LM Studio or Ollama)
          </h2>
          
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>API Base URL</label>
            <input 
              type="text" 
              name="llm_api_url"
              value={settings.llm_api_url}
              onChange={handleChange}
              style={{ 
                width: '100%', 
                padding: '0.8rem', 
                backgroundColor: 'rgba(255,255,255,0.05)', 
                border: '1px solid rgba(255,255,255,0.1)', 
                borderRadius: '8px',
                color: 'var(--text-primary)'
              }}
            />
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              The endpoint where your local inference server is running. LM Studio, Ollama and other OpenAI-compatible servers are detected automatically.
            </small>
            <LlmConnectionPanel
              url={settings.llm_api_url}
              model={settings.llm_model}
              thinking={settings.llm_thinking === 'true'}
              allowRemote={settings.llm_allow_remote === 'true'}
              modelListId="llm-model-options"
              onUrlChange={url => setSettings(prev => ({ ...prev, llm_api_url: url }))}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={settings.llm_allow_remote === 'true'}
                onChange={e => setSettings(prev => ({ ...prev, llm_allow_remote: e.target.checked ? 'true' : 'false' }))}
              />
              Allow an LLM server on another machine
            </label>
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              Off (recommended): only a server on this Mac (127.0.0.1 / localhost) is used, so transcripts never leave it.
              On: meeting transcripts and notes are sent to the server at the URL above. Servers outside your local network must use https://.
            </small>
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
              LLM server API key (optional) {apiKeySet && <span style={{ color: 'var(--color-structure)' }}>· saved</span>}
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={apiKeySet ? '•••••••• (saved in the Keychain)' : 'Only if your server requires one'}
                style={{
                  flex: 1,
                  padding: '0.8rem',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)'
                }}
              />
              <button type="button" className="btn" disabled={!apiKey.trim()} onClick={() => saveApiKey(apiKey.trim())}>Save key</button>
              {apiKeySet && <button type="button" className="btn" onClick={() => saveApiKey('')}>Remove</button>}
            </div>
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              Sent as a Bearer token on every LLM request, e.g. when LM Studio's "Require API key" is on or a proxy protects Ollama.
              Stored in the macOS Keychain, never in the database. {apiKeyMessage}
            </small>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Coaching Instructions (optional)</label>
            <textarea 
              name="coach_instructions"
              value={settings.coach_instructions}
              onChange={handleChange}
              rows={4}
              placeholder="e.g. I tend to over-explain; push me to lead with the answer. Our team says 'north star' for the annual goal."
              style={{ 
                width: '100%', 
                padding: '0.8rem', 
                backgroundColor: 'rgba(255,255,255,0.05)', 
                border: '1px solid rgba(255,255,255,0.1)', 
                borderRadius: '8px',
                color: 'var(--text-primary)',
                resize: 'vertical'
              }}
            />
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              Added to every live coaching request. The built-in coaching prompts are tuned per meeting mode; use this for personal preferences only.
            </small>
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Model ID (optional)</label>
            <input 
              type="text" 
              name="llm_model"
              list="llm-model-options"
              value={settings.llm_model}
              onChange={handleChange}
              placeholder="e.g. google/gemma-4-e4b (LM Studio) or gemma4:e4b (Ollama). Blank uses the loaded model"
              style={{ 
                width: '100%', 
                padding: '0.8rem', 
                backgroundColor: 'rgba(255,255,255,0.05)', 
                border: '1px solid rgba(255,255,255,0.1)', 
                borderRadius: '8px',
                color: 'var(--text-primary)'
              }}
            />
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              Coaching cards are event-driven (questions, decisions, monologues) and automatically back off while transcription is under GPU pressure.
            </small>
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={settings.llm_thinking === 'true'}
                onChange={e => setSettings(prev => ({ ...prev, llm_thinking: e.target.checked ? 'true' : 'false' }))}
              />
              Enable model thinking / reasoning
            </label>
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              Off (recommended): reasoning models such as Qwen 3 and Gemma 4 answer directly, which keeps live cards fast.
              On: the model thinks before answering. Summaries may improve, but live cards arrive seconds later.
              Sent as <code>think</code> to Ollama and <code>reasoning_effort</code> to LM Studio. Applies to the next meeting or summary.
            </small>
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={settings.llm_streaming !== 'false'}
                onChange={e => setSettings(prev => ({ ...prev, llm_streaming: e.target.checked ? 'true' : 'false' }))}
              />
              Stream live coaching cards
            </label>
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              On (recommended): each card's headline appears on the HUD as soon as the model writes it, and the details follow.
              This saves seconds with larger models. If your server doesn't support streaming, the app falls back automatically.
              Applies to the next meeting.
            </small>
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Your name</label>
            <input className="field" type="text" name="leader_name" value={settings.leader_name ?? ''} onChange={handleChange}
              placeholder="e.g. Pavan Sreepada" maxLength={80} />
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              Lets the commitment ledger tell your action items from other people's, and keeps you out of your own attendee lists.
            </small>
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Tracked Filler Words</label>
            <input 
              type="text" 
              name="filler_words"
              value={settings.filler_words}
              onChange={handleChange}
              placeholder="e.g. um, uh, ah, like"
              style={{ 
                width: '100%', 
                padding: '0.8rem', 
                backgroundColor: 'rgba(255,255,255,0.05)', 
                border: '1px solid rgba(255,255,255,0.1)', 
                borderRadius: '8px',
                color: 'var(--text-primary)'
              }}
            />
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              Comma-separated list of words to track as fillers in your metrics.
            </small>
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Custom Executive Vocabulary & Jargon</label>
            <input 
              type="text" 
              name="custom_jargon"
              value={settings.custom_jargon}
              onChange={handleChange}
              placeholder="e.g. OKRs, ARR, LTV, Kubernetes, Project Phoenix"
              style={{ 
                width: '100%', 
                padding: '0.8rem', 
                backgroundColor: 'rgba(255,255,255,0.05)', 
                border: '1px solid rgba(255,255,255,0.1)', 
                borderRadius: '8px',
                color: 'var(--text-primary)'
              }}
            />
            <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-tertiary)' }}>
              Custom terms, acronyms, and project code names to ensure 100% transcription accuracy.
            </small>
          </div>
        </div>

        <ExternalLlmPanel value={settings} onChange={patch => setSettings(prev => ({ ...prev, ...patch }))} />

        {/* Audio Input Devices */}
        <div className="glass-panel" style={{ padding: '2rem' }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Mic size={20} color="var(--accent-primary)" /> Audio Input Devices
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Microphone (Your Voice)</label>
              <select 
                value={selectedMic}
                onChange={(e) => {
                  setSelectedMic(e.target.value);
                  localStorage.setItem('selected_mic', e.target.value);
                }}
                style={{ 
                  width: '100%', 
                  padding: '0.8rem', 
                  backgroundColor: 'rgba(255,255,255,0.05)', 
                  border: '1px solid rgba(255,255,255,0.1)', 
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                  outline: 'none'
                }}
              >
                {devices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.slice(0, 5)}`}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Meeting Loopback (Participant Voices)</label>
              <select 
                value={selectedSystem}
                onChange={(e) => {
                  setSelectedSystem(e.target.value);
                  localStorage.setItem('selected_system', e.target.value);
                }}
                style={{ 
                  width: '100%', 
                  padding: '0.8rem', 
                  backgroundColor: 'rgba(255,255,255,0.05)', 
                  border: '1px solid rgba(255,255,255,0.1)', 
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                  outline: 'none'
                }}
              >
                <option value={SYSTEM_AUDIO}>Mac system audio (built-in, no BlackHole)</option>
                <option value="">None (Mono Mic Only / No Speaker Isolation)</option>
                {devices.filter(d => d.deviceId !== selectedMic).map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.slice(0, 5)}`}</option>
                ))}
              </select>
            </div>
          </div>
          <small style={{ display: 'block', marginTop: '1rem', color: 'var(--text-tertiary)' }}>
            Choose your physical microphone for your voice. For participants, "Mac system audio" captures whatever your Mac plays (macOS will ask once for Screen &amp; System Audio Recording — allow it, then restart the app); a virtual device like BlackHole also works. Headphones give the cleanest Me/Participant split.
          </small>
        </div>

        {/* Transcription Settings */}
        <div className="glass-panel" style={{ padding: '2rem' }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Mic size={20} color="var(--color-structure)" /> Transcription Engine (Parakeet Q8_0, local streaming)
          </h2>
          <AsrSettingsPanel value={settings} onChange={p => setSettings(prev => ({ ...prev, ...p }))} />
        </div>

        <StoragePanel />

        {/* Save Bar */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '1rem', marginTop: '1rem' }}>
          {saveMessage && (
            <span style={{ color: saveMessage.includes('error') || saveMessage.includes('Failed') ? 'var(--color-risk)' : 'var(--color-structure)' }}>
              {saveMessage}
            </span>
          )}
          <button 
            className="btn btn-primary" 
            onClick={handleSave}
            disabled={isSaving}
            style={{ padding: '0.8rem 2rem', opacity: isSaving ? 0.7 : 1 }}
          >
            <Save size={18} /> {isSaving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
        
      </div>
    </div>
  );
}
