import { useEffect, useRef } from 'react'
import type { CoachEvent } from './protocol'

const API = 'ws://127.0.0.1:8000'

/** Subscribes to the backend event fan-out with exponential-backoff reconnect. */
export function useCoachEvents(meetingId: number | null, onEvent: (e: CoachEvent) => void) {
  const handler = useRef(onEvent)
  useEffect(() => { handler.current = onEvent })

  useEffect(() => {
    if (meetingId == null) return
    let ws: WebSocket | null = null
    let retry = 0
    let timer: number | undefined
    let closed = false

    const connect = () => {
      ws = new WebSocket(`${API}/ws/events/${meetingId}`)
      ws.onopen = () => { retry = 0 }
      ws.onmessage = (m) => {
        try { handler.current(JSON.parse(m.data) as CoachEvent) } catch { /* ignore malformed */ }
      }
      ws.onclose = () => {
        if (closed) return
        timer = window.setTimeout(connect, Math.min(5000, 250 * 2 ** retry++))
      }
    }
    connect()
    return () => { closed = true; window.clearTimeout(timer); ws?.close() }
  }, [meetingId])
}
