import { useCallback, useEffect, useState } from 'react';
import { api } from './leadershipApi';

export interface Issue { level: 'problem' | 'warning'; title: string; detail: string; fix: string }
export interface CallStats { calls: number; failures: number; p50_s: number | null; p90_s: number | null; last_s: number | null; last_at: number | null }
export interface SetupStep { id: string; label: string; done: boolean; hint: string }
export interface Health {
  status: 'good' | 'warning' | 'problem';
  issues: Issue[];
  uptime_s: number;
  llm: { url: string; reachable: boolean; message: string; probe_ms: number | null; model: string; thinking: boolean; external: boolean; external_model: string | null };
  llm_calls: { coach: CallStats; task: CallStats; live_timeout_s: number };
  memory: { total_gb: number | null; swap_used_gb: number | null; pressure: 'normal' | 'warning' | 'critical' | null };
  asr: { ready: boolean | null; calibrated: boolean; calibrating: boolean; live: { meeting_id: number; asr_lag_ms: number | null; coach: string | null }[] };
  security: { encryption: string | null };
  setup: SetupStep[];
}

/** Polls /health/diagnostics; `null` until the backend answers. */
export function useHealth(pollMs = 30000) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => api<Health>('/health/diagnostics')
    .then(h => { setHealth(h); setError(null); }).catch(e => setError(String(e))), []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);
  return { health, error, refresh };
}

/** Audio devices live in this browser profile, not the backend. */
export const audioConfigured = () => !!localStorage.getItem('selected_mic');

export const STATUS_COLOR = { good: '#34d399', warning: '#fbbf24', problem: '#f87171' } as const;
