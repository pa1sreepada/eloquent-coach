import { Loader2, Mic, MicOff } from 'lucide-react';
import { stopSpeaking, type useDictation } from './useDictation';

/** A text box with a mic button: talk (local speech-to-text) or type. */
export default function DictationBox({ value, onChange, onSubmit, mic, rows, placeholder }: {
  value: string; onChange: (v: string) => void; onSubmit?: () => void; mic: ReturnType<typeof useDictation>; rows: number; placeholder: string;
}) {
  const toggle = () => { if (mic.listening) mic.end(); else { stopSpeaking(); void mic.begin(value); } };
  return (
    <div style={{ position: 'relative' }}>
      <textarea className="field" rows={rows} placeholder={placeholder} value={value} style={{ width: '100%', paddingRight: '3rem',
        borderColor: mic.state === 'listening' ? 'rgba(248,113,113,0.7)' : undefined }}
        onChange={e => { if (mic.listening) mic.end(); onChange(e.target.value); }}
        onKeyDown={e => { if (onSubmit && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(); } }} />
      <button type="button" className="icon-btn" onClick={toggle} style={{ position: 'absolute', right: '0.5rem', top: '0.5rem', color: mic.listening ? '#f87171' : undefined }}
        title={mic.state === 'starting' ? 'Starting speech recognition…' : mic.listening ? 'Stop dictation' : 'Speak instead of typing (transcribed on this Mac, nothing is recorded)'}>
        {mic.state === 'starting' ? <Loader2 size={16} className="spin" /> : mic.listening ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      {mic.state === 'listening' && <div style={{ fontSize: '0.72rem', color: '#f87171', marginTop: '0.2rem' }}>● Listening. Click the mic to stop{onSubmit ? ', or press Send when you are done' : ''}.</div>}
    </div>
  );
}
