import { useCallback, useEffect, useRef } from 'react'

/**
 * Mic → L ("Me"), system loopback → R ("Participant"), 16 kHz float32 interleaved,
 * shipped in 80 ms frames over ws://…/ws/audio/{id}. Replaces ScriptProcessorNode.
 */
export function useDualChannelCapture(muted: boolean) {
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const streamsRef = useRef<MediaStream[]>([])

  useEffect(() => { nodeRef.current?.port.postMessage({ muted }) }, [muted])

  const stop = useCallback(() => {
    nodeRef.current?.disconnect()
    nodeRef.current = null
    wsRef.current?.close()
    wsRef.current = null
    streamsRef.current.forEach(s => s.getTracks().forEach(t => t.stop()))
    streamsRef.current = []
    void ctxRef.current?.close()
    ctxRef.current = null
  }, [])

  /** opts.url streams somewhere other than a meeting (the teleprompter); micOnly skips system audio;
   *  onMessage receives whatever that socket sends back. */
  const start = useCallback(async (meetingId: number, onStatus?: (s: 'connected' | 'disconnected') => void,
    opts: { url?: string; micOnly?: boolean; onMessage?: (data: string) => void } = {}) => {
    const micId = localStorage.getItem('selected_mic') || ''
    const sysId = opts.micOnly ? '' : localStorage.getItem('selected_system') || ''
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: true, noiseSuppression: true },
    }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }))
    const sys = sysId
      ? await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: sysId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        }).catch(() => null)
      : null
    streamsRef.current = sys ? [mic, sys] : [mic]

    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
    ctxRef.current = ctx
    await ctx.audioWorklet.addModule(new URL('pcm-capture-worklet.js', document.baseURI).href)
    const merger = ctx.createChannelMerger(2)
    ctx.createMediaStreamSource(mic).connect(merger, 0, 0)
    if (sys) ctx.createMediaStreamSource(sys).connect(merger, 0, 1)

    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit',
    })
    nodeRef.current = node
    node.port.postMessage({ muted })
    merger.connect(node)

    const ws = new WebSocket(opts.url ?? `ws://127.0.0.1:8000/ws/audio/${meetingId}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onopen = () => onStatus?.('connected')
    ws.onclose = () => onStatus?.('disconnected')
    if (opts.onMessage) ws.onmessage = (m) => { if (typeof m.data === 'string') opts.onMessage?.(m.data) }
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      // Drop rather than queue if the socket is congested (keeps latency bounded).
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 64 * 1024) ws.send(e.data)
    }
    await ctx.resume()
  }, [muted])

  useEffect(() => stop, [stop])
  return { start, stop }
}
