import { API_BASE } from '../api'

export type Voice = 'me' | 'room' | 'echo' | 'uncertain'

export interface VoiceProfileInfo {
  enrolled: boolean
  created_at?: string | null
  seconds?: number
  quality?: number | null
  labels: Partial<Record<Voice, number>>
  min_seconds: number
  max_seconds: number
}

export const VOICE_LABEL: Record<Voice, string> = { me: 'You', room: 'Room', echo: 'Speaker echo', uncertain: 'You?' }

/** Transcript label for a line: mic lines show their voice check (You / Room / Speaker echo / You?). */
export function speakerLabel(speaker: string, voice?: string | null): string {
  if (speaker !== 'Me') return 'Participant'
  return voice && voice in VOICE_LABEL ? VOICE_LABEL[voice as Voice] : 'You'
}

export function speakerColor(speaker: string, voice?: string | null): string {
  if (speaker !== 'Me' || voice === 'room') return '#34d399'
  return voice === 'echo' || voice === 'uncertain' ? 'var(--text-tertiary)' : '#60a5fa'
}

export interface Recording {
  stop: () => Float32Array
  cancel: () => void
}

/** Mic-only 16 kHz mono capture using the same mic and processing as meetings, so the voiceprint matches. */
export async function recordMic(onProgress: (seconds: number, level: number) => void): Promise<Recording> {
  const micId = localStorage.getItem('selected_mic') || ''
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: true, noiseSuppression: true },
  }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }))
  const ctx = new AudioContext({ sampleRate: 16000 })
  await ctx.audioWorklet.addModule(new URL('pcm-capture-worklet.js', document.baseURI).href)
  const node = new AudioWorkletNode(ctx, 'pcm-capture', {
    numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit',
  })
  const merger = ctx.createChannelMerger(2)
  ctx.createMediaStreamSource(stream).connect(merger, 0, 0)
  merger.connect(node)
  const chunks: Float32Array[] = []
  let samples = 0
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const stereo = new Float32Array(e.data)
    const mono = new Float32Array(stereo.length / 2)
    let peak = 0
    for (let i = 0; i < mono.length; i++) {
      mono[i] = stereo[i * 2]
      peak = Math.max(peak, Math.abs(mono[i]))
    }
    chunks.push(mono)
    samples += mono.length
    onProgress(samples / 16000, peak)
  }
  await ctx.resume()
  const close = () => {
    node.port.onmessage = null
    node.disconnect()
    stream.getTracks().forEach(t => t.stop())
    void ctx.close()
  }
  return {
    cancel: close,
    stop: () => {
      close()
      const out = new Float32Array(samples)
      let o = 0
      for (const c of chunks) { out.set(c, o); o += c.length }
      return out
    },
  }
}

/** POST raw float32 audio (never saved by the backend). */
export async function postAudio<T>(path: string, pcm: Float32Array): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([pcm.buffer as ArrayBuffer]),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`)
  }
  return data as T
}
