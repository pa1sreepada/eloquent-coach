import type { TranscriptEvent } from './protocol'

export interface Line { id: string; speaker: string; text: string; final: boolean; t0: number }
export const MAX_LINES = 200

/** Upsert by utterance_id so partials rewrite in place; bounded history. */
export function applyTranscript(lines: Line[], e: TranscriptEvent): Line[] {
  const line: Line = { id: e.utterance_id, speaker: e.speaker, text: e.text, final: e.kind === 'final', t0: e.t0_ms }
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    if (lines[i].id === line.id) {
      const next = lines.slice()
      next[i] = line
      return next
    }
  }
  const next = [...lines, line].sort((a, b) => a.t0 - b.t0)
  return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
}
