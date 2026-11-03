import { useCallback, useEffect, useRef, useState } from 'react';

const API = 'http://127.0.0.1:8000';

/** Notes for a meeting, saved ~0.8 s after typing stops (and on flush). */
export function useNotesAutosave(meetingId: number | null, initial = '') {
  const [value, setValueState] = useState(initial);
  const [status, setStatus] = useState<'' | 'Saving…' | 'Saved' | 'Not saved'>('');
  const latest = useRef(initial);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const idRef = useRef(meetingId);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const id = idRef.current;
    if (!id || !dirty.current) return;
    dirty.current = false;
    setStatus('Saving…');
    try {
      const res = await fetch(`${API}/meetings/${id}/notes`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: latest.current }),
      });
      setStatus(res.ok ? 'Saved' : 'Not saved');
    } catch {
      dirty.current = true;
      setStatus('Not saved');
    }
  }, []);

  // Switching meetings: save the previous one, then load the new initial value.
  useEffect(() => {
    if (idRef.current !== meetingId) void flush();
    idRef.current = meetingId;
    latest.current = initial;
    dirty.current = false;
    setValueState(initial);
    setStatus('');
  }, [meetingId, initial, flush]);

  useEffect(() => () => { void flush(); }, [flush]);

  const setValue = (v: string) => {
    setValueState(v);
    latest.current = v;
    dirty.current = true;
    setStatus('');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 800);
  };

  return { value, setValue, status, flush };
}
