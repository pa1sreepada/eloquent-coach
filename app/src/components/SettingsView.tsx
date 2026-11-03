import { useState, useEffect } from 'react';
import { Save, Settings2, Database, Mic, RefreshCw } from 'lucide-react';
import AsrSettingsPanel, { type AsrSettings } from './AsrSettingsPanel';
import StoragePanel from './StoragePanel';

interface Settings extends AsrSettings {
  llm_api_url: string;
  llm_model: string;
  coach_instructions: string;
  filler_words: string;
  custom_jargon: string;
}

export default function SettingsView() {
  const [settings, setSettings] = useState<Settings>({
    llm_api_url: '',
    llm_model: '',
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
  
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>('');
  const [selectedSystem, setSelectedSystem] = useState<string>('');

  useEffect(() => {
    fetch('http://127.0.0.1:8000/settings')
      .then(res => res.json())
      .then(data => {
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
        
        if (!savedSystem && audioInputs.length > 0) {
          const bhDevice = audioInputs.find(d => d.label.toLowerCase().includes('blackhole'));
          if (bhDevice) {
            savedSystem = bhDevice.deviceId;
            localStorage.setItem('selected_system', savedSystem);
          }
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
        setSaveMessage('Failed to save settings.');
      }
    } catch (err) {
      console.error(err);
      setSaveMessage('Error connecting to backend.');
    }
    setIsSaving(false);
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
            <Database size={20} color="var(--accent-primary)" /> Local LLM Engine (LM Studio)
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
              The endpoint where your local inference server is running.
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
              value={settings.llm_model}
              onChange={handleChange}
              placeholder="e.g. google/gemma-4-e4b — blank uses the loaded model"
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
              <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Meeting Loopback (BlackHole - Participant Voices)</label>
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
                <option value="">None (Mono Mic Only / No Speaker Isolation)</option>
                {devices.filter(d => d.deviceId !== selectedMic).map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.slice(0, 5)}`}</option>
                ))}
              </select>
            </div>
          </div>
          <small style={{ display: 'block', marginTop: '1rem', color: 'var(--text-tertiary)' }}>
            Choose your physical microphone for your voice, and your virtual loopback device (e.g. BlackHole) to capture the meeting participants.
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
