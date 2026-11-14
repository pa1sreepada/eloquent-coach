import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/** Minimal Markdown for LLM-written docs: ## headings, - bullets, **bold**. */
export function MiniMarkdown({ text }: { text: string }) {
  const bold = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>);
  return (
    <div style={{ fontSize: '0.9rem', lineHeight: 1.55 }}>
      {text.split('\n').map((line, i) => {
        const t = line.trim();
        if (!t) return <div key={i} style={{ height: '0.4rem' }} />;
        const h = t.match(/^#{1,4}\s+(.*)$/) || (/^[A-Z][A-Z &'/-]{3,}$/.test(t) ? [t, t] : null);
        if (h) return <div key={i} className="eyebrow" style={{ marginTop: '0.8rem', marginBottom: '0.25rem' }}>{h[1]}</div>;
        const b = t.match(/^[-*•]\s+(.*)$/);
        if (b) return <div key={i} style={{ paddingLeft: '1rem', textIndent: '-0.7rem' }}>• {bold(b[1])}</div>;
        return <div key={i}>{bold(t)}</div>;
      })}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn" onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : label}
    </button>
  );
}

export function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="glass-panel" style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
        <div className="eyebrow">{title}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>{error}</div> : null;
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>{children}</div>;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          style={{
            padding: '0.4rem 0.9rem', borderRadius: '999px', fontSize: '0.85rem', cursor: 'pointer',
            border: `1px solid ${value === v ? 'rgba(59,130,246,0.7)' : 'var(--border-color)'}`,
            background: value === v ? 'rgba(59,130,246,0.15)' : 'transparent',
            color: value === v ? '#bfdbfe' : 'var(--text-secondary)',
          }}>{label}</button>
      ))}
    </div>
  );
}

export function PeopleList({ id, people }: { id: string; people: string[] }) {
  return <datalist id={id}>{people.map(p => <option key={p} value={p} />)}</datalist>;
}
