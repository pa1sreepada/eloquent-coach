import { useCallback, useEffect, useState } from 'react';
import { HardDrive, RefreshCw, FolderOpen } from 'lucide-react';

const API = 'http://127.0.0.1:8000';

interface StorageTable {
  name: string;
  rows: number;
  bytes: number | null;
}

interface StorageInfo {
  db_path: string;
  db_bytes: number;
  wal_bytes: number;
  free_bytes: number;
  sqlite_version: string;
  journal_mode: string;
  tables: StorageTable[];
  oldest_meeting: string | null;
  newest_meeting: string | null;
  legacy_transcripts_dir: string | null;
  legacy_transcripts_files: number;
  legacy_transcripts_bytes: number;
}

const TABLE_LABELS: Record<string, string> = {
  meetings: 'Meetings (summaries, notes, emails)',
  transcripts: 'Transcript lines',
  insights: 'Coaching cards',
  metrics: 'Speaking metrics',
  app_config: 'Settings',
};

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

const formatDate = (iso: string | null) => (iso ? new Date(iso + 'Z').toLocaleDateString() : '—');

const cell: React.CSSProperties = { padding: '0.5rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.06)' };
const num: React.CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

export default function StoragePanel() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    () =>
      fetch(`${API}/storage`)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data: StorageInfo) => {
          setInfo(data);
          setError('');
        })
        .catch(err => {
          console.error('Failed to load storage info:', err);
          setError('Could not load storage details from the backend.');
        })
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const refresh = () => {
    setLoading(true);
    load();
  };

  const reveal = () => fetch(`${API}/storage/reveal`, { method: 'POST' }).catch(console.error);

  return (
    <div className="glass-panel" style={{ padding: '2rem' }}>
      <h2 style={{ fontSize: '1.2rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <HardDrive size={20} color="var(--accent-primary)" /> Data & Storage
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={reveal} disabled={!info} title="Show the database file in Finder">
          <FolderOpen size={16} /> Show in Finder
        </button>
        <button className="btn" onClick={refresh} disabled={loading} title="Refresh">
          <RefreshCw size={16} className={loading ? 'pulse-animation' : undefined} />
        </button>
      </h2>

      {error && <p style={{ color: 'var(--color-risk)' }}>{error}</p>}

      {info && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            <Stat label="Database size" value={formatBytes(info.db_bytes + info.wal_bytes)} />
            <Stat label="Reclaimable" value={formatBytes(info.free_bytes)} />
            <Stat label="Oldest meeting" value={formatDate(info.oldest_meeting)} />
            <Stat label="Newest meeting" value={formatDate(info.newest_meeting)} />
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.5rem' }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                <th style={cell}>Data</th>
                <th style={{ ...num }}>Rows</th>
                <th style={{ ...num }}>Size</th>
              </tr>
            </thead>
            <tbody>
              {info.tables.map(t => (
                <tr key={t.name}>
                  <td style={cell}>{TABLE_LABELS[t.name] ?? t.name}</td>
                  <td style={num}>{t.rows.toLocaleString()}</td>
                  <td style={num}>{formatBytes(t.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <small style={{ display: 'block', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
            Location: <code style={{ userSelect: 'all' }}>{info.db_path}</code>
            <br />
            SQLite {info.sqlite_version} · {info.journal_mode.toUpperCase()} mode
            {info.wal_bytes > 0 && ` · ${formatBytes(info.wal_bytes)} pending in write-ahead log`}
            {info.legacy_transcripts_dir && (
              <>
                <br />
                Legacy transcript files: {info.legacy_transcripts_files} ({formatBytes(info.legacy_transcripts_bytes)}) in{' '}
                <code style={{ userSelect: 'all' }}>{info.legacy_transcripts_dir}</code>
              </>
            )}
            <br />
            Only text is stored. Markdown exports are generated on demand and aren't saved.
          </small>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '1rem', background: 'rgba(255,255,255,0.04)', borderRadius: '8px' }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: 600, marginTop: '0.25rem' }}>{value}</div>
    </div>
  );
}
