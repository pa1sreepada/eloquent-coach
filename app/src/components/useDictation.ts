import { useCallback, useEffect, useRef, useState } from 'react'
import { useDualChannelCapture } from '../hud/useDualChannelCapture'

export type DictationState = 'off' | 'starting' | 'listening'

/** Speech-to-text into a text box, on this machine: the mic-only Parakeet stream the teleprompter uses
 *  (transcript events as in hud/protocol.ts).
 *  Nothing is recorded or stored; words appear while you speak and stay editable afterwards. */
export function useDictation(onText: (text: string) => void) {
  const { start, stop } = useDualChannelCapture(false)
  const [state, setState] = useState<DictationState>('off')
  const [error, setError] = useState<string | null>(null)
  const parts = useRef(new Map<string, string>())
  const prefix = useRef('')
  const emit = useRef(onText)
  useEffect(() => { emit.current = onText })

  const end = useCallback(() => { stop(); setState('off') }, [stop])

  /** Start listening; dictated words are appended after `existing`. */
  const begin = useCallback(async (existing: string) => {
    parts.current = new Map()
    prefix.current = existing.trim()
    setError(null)
    setState('starting')
    try {
      await start(0, s => { if (s === 'disconnected') setState('off') }, {
        url: 'ws://127.0.0.1:8000/ws/prompter', micOnly: true,
        onMessage: (data) => {
          let e: { type: string; state?: string; speaker?: string; utterance_id?: string; text?: string }
          try { e = JSON.parse(data) } catch { return }
          if (e.type === 'prompter_status') setState(e.state === 'ready' ? 'listening' : 'starting')
          else if (e.type === 'transcript' && e.speaker === 'Me' && e.utterance_id) {
            parts.current.set(e.utterance_id, e.text ?? '')
            emit.current([prefix.current, ...parts.current.values()].filter(Boolean).join(' '))
          }
        },
      })
    } catch (err) {
      stop()
      setState('off')
      setError(`Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [start, stop])

  return { state, error, begin, end, listening: state !== 'off' }
}

/** Read a line aloud with the system voice; resolves when it finishes (or can't play). */
export function speak(text: string): Promise<void> {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) { resolve(); return }
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    u.onend = () => resolve()
    u.onerror = () => resolve()
    window.speechSynthesis.speak(u)
  })
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}
