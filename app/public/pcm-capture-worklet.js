// AudioWorklet: runs on the audio render thread. Collects 2-channel float32
// at the context rate (16 kHz) and posts interleaved 80 ms frames (1280 samples/ch).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = 1280
    this.buf = new Float32Array(this.frame * 2)
    this.n = 0
    this.muted = false
    this.port.onmessage = (e) => { if (e.data && 'muted' in e.data) this.muted = !!e.data.muted }
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const L = input[0]
    const R = input[1] || null
    for (let i = 0; i < L.length; i++) {
      // Mute zeroes only my mic; the room keeps being transcribed.
      this.buf[this.n * 2] = this.muted ? 0 : L[i]
      this.buf[this.n * 2 + 1] = R ? R[i] : 0
      if (++this.n === this.frame) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer])
        this.buf = new Float32Array(this.frame * 2)
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
