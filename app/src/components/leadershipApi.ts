import { useEffect, useState } from 'react';

export const API = 'http://127.0.0.1:8000';

/** JSON fetch that throws the server's `detail` message, so views can show why something failed. */
export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`);
  }
  return data as T;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Commitment {
  id: number; meeting_id: number | null; meeting_title: string | null; owner: string; is_mine: boolean;
  action: string; due_text: string | null; due_date: string | null; status: 'open' | 'done' | 'dropped';
  source: string; overdue: boolean; days_overdue: number; created_at: string | null;
}

export interface Reminders { overdue: Commitment[]; due_soon: Commitment[]; slipping: Commitment[]; unowned: Commitment[] }

/** Names from meeting attendees and the stakeholder map, for autocomplete. */
export function usePeople() {
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => { api<{ name: string }[]>('/people').then(p => setPeople(p.map(x => x.name))).catch(() => {}); }, []);
  return people;
}
