import { AlertCircle, Award, BookOpen, HelpCircle, Lightbulb, List, Scale, Target, UserCheck } from 'lucide-react';

// Shared look for live coaching cards (Live view + Meeting History).
const KINDS: Record<string, { label: string; color: string; Icon: typeof HelpCircle }> = {
  question: { label: 'Question', color: '#60a5fa', Icon: HelpCircle },
  counterpoint: { label: 'Counterpoint', color: '#f59e0b', Icon: Scale },
  alignment: { label: 'Alignment', color: '#10b981', Icon: List },
  bluf: { label: 'Bottom line', color: '#a78bfa', Icon: Target },
  context: { label: 'Context', color: '#a78bfa', Icon: Lightbulb },
  answer: { label: 'Answer', color: '#10b981', Icon: BookOpen },
  bio: { label: 'Who', color: '#f59e0b', Icon: UserCheck },
  risk: { label: 'Risk', color: '#ef4444', Icon: AlertCircle },
};
const FALLBACK = { label: 'Insight', color: '#60a5fa', Icon: Award };

export const kindInfo = (kind: string) => KINDS[kind] ?? { ...FALLBACK, label: kind || FALLBACK.label };

export function KindTag({ kind }: { kind: string }) {
  const { label, color, Icon } = kindInfo(kind);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color, fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
      <Icon size={14} /> {label}
    </span>
  );
}

export function CoachCard({ kind, headline, body, time, action }: { kind: string; headline: string; body?: string | null; time?: string; action?: React.ReactNode }) {
  const { color } = kindInfo(kind);
  return (
    <div className="slide-up" style={{
      padding: '0.9rem 1rem', borderRadius: '10px',
      background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border-color)',
      boxShadow: `inset 3px 0 0 ${color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem', minHeight: '20px' }}>
        <KindTag kind={kind} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {time && <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>{time}</span>}
          {action}
        </div>
      </div>
      <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>{headline}</div>
      {body && <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginTop: '0.3rem', lineHeight: 1.45 }}>{body}</div>}
    </div>
  );
}
